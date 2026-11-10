/**
 * App auto-update via electron-updater against GitHub Releases.
 *
 * The feed (latest*.yml + installers) is attached to each GitHub Release by
 * .github/workflows/release.yml. Discovery always tracks the latest stable
 * release (`allowPrerelease = false`) so RC installs still graduate to newer
 * stables. Delivery mode per install:
 *  - Windows NSIS / Linux AppImage / packaged macOS → full in-app flow: silent
 *    background download, "restart to update" prompt, install-on-quit fallback.
 *  - Windows ZIP / legacy portable (`piDistribution = "zip"` or
 *    `PORTABLE_EXECUTABLE_FILE`) → notify + link. The
 *    NSIS installer must not replace a no-install run.
 *  - Linux deb (no $APPIMAGE in env) → notify + link.
 *  - Unpackaged dev runs → disabled (no app-update.yml in resources).
 *
 * The installer download cache lives in the user cache directory rather than
 * beside the installation; `PI_DESKTOP_UPDATE_CACHE_DIR` relocates it, and
 * `./update-cache` owns what may be reclaimed from it (#1098).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, shell } from "electron";
import electronUpdaterPkg from "electron-updater";
import type { AppUpdater, UpdateInfo, ProgressInfo } from "electron-updater";
import {
  formatChangelogNotes,
  IPC,
  type UpdatePreference,
  type UpdateState,
} from "@pi-desktop/shared";
import type { Logger } from "./logger";
import { parseAllowedExternalUrl } from "./safe-open-external";
import {
  defaultUpdateCacheBasePath,
  relocateUpdateCacheBasePath,
  resolveUpdateCacheOverride,
  UPDATE_CACHE_DIR_ENV,
} from "./update-cache";
import { UpdateCacheMaintenance } from "./update-cache-maintenance";
import {
  UpdaterActivity,
  type UpdaterHandoffActivity,
  type UpdaterOwnerGuard,
  type UpdaterScope,
  type UpdaterStream,
} from "./updater-activity";
import {
  raceWithTimeout,
  UPDATE_CHECK_TIMEOUT_CODE,
} from "./update-timeout";
import {
  resolveDefaultUpdatePreference,
  resolveEffectiveUpdatePreference,
  resolveStoredUpdatePreference,
  resolveUpdateMode as resolveUpdateModePolicy,
  supportsAutomaticUpdates,
  type WindowsDistribution,
} from "./update-policy";
import { ManualUpdateReminderTracker } from "./manual-update-reminder";

export { resolveUpdateMode } from "./update-policy";
export type { WindowsDistribution } from "./update-policy";

const { NsisUpdater, autoUpdater } = electronUpdaterPkg;

/** Windows NSIS updater with a caller-selected cache base. */
class RelocatedNsisUpdater extends NsisUpdater {
  constructor(baseCachePath: string) {
    super();
    relocateUpdateCacheBasePath(this.app, baseCachePath);
  }
}

function createRelocatedUpdater(
  platform: NodeJS.Platform,
  baseCachePath: string,
): AppUpdater | null {
  return platform === "win32" ? new RelocatedNsisUpdater(baseCachePath) : null;
}

export const RELEASES_URL = "https://github.com/vastsa/PI-Desktop/releases/latest";

const AUTO_CHECK_INITIAL_DELAY_MS = 15_000;
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Auto-check wait. Chromium's GitHub hang is ~60s; do not pin UI on that. */
export const AUTO_CHECK_TIMEOUT_MS = 8_000;
/** Manual check can wait a bit longer; still far below the socket timeout. */
export const MANUAL_CHECK_TIMEOUT_MS = 15_000;

export type UpdaterSettings = {
  updatePreference?: unknown;
  lastNotifiedUpdateVersion?: unknown;
  updateDismissedVersion?: unknown;
};

export type UpdaterOptions = {
  logger: Logger;
  send: (channel: string, payload: unknown) => void;
  currentVersion: string;
  readUpdateSettings?: () => Promise<UpdaterSettings>;
  persistLastNotifiedVersion?: (version: string) => Promise<void>;
  /** Persists the version whose update notice the user dismissed (#1317). */
  persistDismissedVersion?: (version: string | null) => Promise<void>;
  /** Overrides the Electron singleton in controller tests. */
  autoUpdater?: AppUpdater;
  /**
   * Active product UI locale for shipped-locale release notes.
   * Called when attaching notes to update state; defaults to English.
   */
  getLocale?: () => string | null | undefined;
  /**
   * `PI_DESKTOP_UPDATE_CACHE_DIR`; an absolute directory moves the updater's
   * download cache out of the user cache directory. Empty keeps the default.
   */
  updateCacheDirOverride?: string | null;
  /**
   * The shared Desktop admission gate. Once it closes, no new check, download,
   * cache pass, settings write or installer handoff may start; already admitted
   * work keeps running and keeps reporting until it actually settles.
   */
  isAdmissionClosed?: () => boolean;
  /**
   * Captures the original Host/generation that admitted this work at an entry
   * point. Late settings writes and renderer pushes revalidate it so a replaced
   * Host never receives a previous generation's persistence.
   */
  captureOwner?: () => () => boolean;
  /** Test seam for cache maintenance; Main composition keeps the real service. */
  cacheMaintenance?: UpdateCacheMaintenancePort;
  /** Overrides for tests. */
  platform?: NodeJS.Platform;
  isPackaged?: boolean;
  distribution?: WindowsDistribution;
};

/** Cache filesystem passes the controller owns and reports. */
export type UpdateCacheMaintenancePort = Pick<
  UpdateCacheMaintenance,
  "discardDownloadedInstaller" | "reclaimLegacyCache"
>;

export class AppUpdaterController {
  private readonly logger: Logger;
  private readonly send: (channel: string, payload: unknown) => void;
  private readonly getLocale: () => string | null | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly isPackaged: boolean;
  private readonly env: NodeJS.ProcessEnv;
  private readonly distribution?: WindowsDistribution;
  private readonly defaultPreference: UpdatePreference;
  private readonly automaticSupported: boolean;
  private readonly readUpdateSettings?: () => Promise<UpdaterSettings>;
  private readonly persistLastNotifiedVersion?: (version: string) => Promise<void>;
  private readonly persistDismissedVersion?: (
    version: string | null,
  ) => Promise<void>;
  private dismissedVersionPersistence: Promise<void> = Promise.resolve();
  private readonly manualReminderTracker = new ManualUpdateReminderTracker();
  private preference: UpdatePreference;
  private preferenceRevision = 0;
  private settingsReady: Promise<void> | null = null;
  private autoCheckStarted = false;
  /** Admission, original-owner and activity accounting owned by this producer. */
  private readonly activity: UpdaterActivity;
  /** Bounds a reentrant check/download to one handoff of hidden work. */
  private checkPending = false;
  private downloadPending = false;
  private state: UpdateState;
  /** Version whose notice the user dismissed; cleared when a new one appears. */
  private dismissedVersion?: string;
  private activeDownloadCancellation?: {
    version: string;
    cancel: () => void;
  };
  private manualRequested = false;
  private initialTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private listenersAttached = false;
  /** Removes only the listeners this controller registered on the shared emitter. */
  private readonly listenerRemovals: Array<() => void> = [];
  /**
   * Set before a downloaded update is handed to the platform installer.
   *
   * electron-updater spawns that installer synchronously and only asks the app
   * to quit afterwards, so the shutdown path must already know that the quit it
   * is about to see is the update restart.
   */
  private installRequested = false;
  private readonly autoUpdater: AppUpdater;
  private readonly cacheMaintenance: UpdateCacheMaintenancePort;

  private readPackagedDistribution(
    isPackaged: boolean,
  ): WindowsDistribution | undefined {
    if (!isPackaged) return undefined;
    try {
      const packageJson = JSON.parse(
        readFileSync(join(app.getAppPath(), "package.json"), "utf8"),
      ) as unknown;
      if (typeof packageJson !== "object" || packageJson === null) {
        return undefined;
      }
      const distribution = (packageJson as Record<string, unknown>)
        .piDistribution;
      return distribution === "installed" || distribution === "zip" || distribution === "portable"
        ? distribution
        : undefined;
    } catch (error) {
      this.logger.app(
        "updater",
        "warn",
        "packaged distribution metadata unavailable",
        { data: { detail: String(error) } },
      );
      return undefined;
    }
  }

  constructor(options: UpdaterOptions) {
    this.logger = options.logger;
    this.send = options.send;
    this.activity = new UpdaterActivity({
      logger: this.logger,
      isAdmissionClosed: options.isAdmissionClosed,
      captureOwner: options.captureOwner,
    });
    this.getLocale = options.getLocale ?? (() => "en");
    const platform = options.platform ?? process.platform;
    const isPackaged = options.isPackaged ?? app.isPackaged;
    const distribution =
      options.distribution ??
      (platform === "win32"
        ? this.readPackagedDistribution(isPackaged)
        : undefined);
    this.platform = platform;
    this.isPackaged = isPackaged;
    this.env = process.env;
    this.distribution = distribution;
    this.defaultPreference = resolveDefaultUpdatePreference(
      platform,
      isPackaged,
      this.env,
      distribution,
    );
    this.preference = this.defaultPreference;
    this.automaticSupported = supportsAutomaticUpdates(
      platform,
      isPackaged,
      this.env,
    );
    this.readUpdateSettings = options.readUpdateSettings;
    this.persistLastNotifiedVersion = options.persistLastNotifiedVersion;
    this.persistDismissedVersion = options.persistDismissedVersion;
    const mode = resolveUpdateModePolicy(
      platform,
      isPackaged,
      this.env,
      distribution,
      this.preference,
    );
    const defaultCacheBasePath = defaultUpdateCacheBasePath({
      platform,
      env: process.env,
      home: homedir(),
    });
    const requestedCacheBasePath =
      options.updateCacheDirOverride ??
      resolveUpdateCacheOverride(process.env[UPDATE_CACHE_DIR_ENV]);
    const relocated =
      mode !== "in-app" || !requestedCacheBasePath
        ? null
        : createRelocatedUpdater(platform, requestedCacheBasePath);
    const activeBasePath =
      relocated && requestedCacheBasePath
        ? requestedCacheBasePath
        : defaultCacheBasePath;
    const legacyBasePath = relocated ? defaultCacheBasePath : null;
    if (requestedCacheBasePath && !relocated && mode !== "disabled") {
      this.logger.app(
        "updater",
        "warn",
        "update cache relocation is not supported on this target",
        { data: { platform } },
      );
    }
    this.autoUpdater = options.autoUpdater ?? relocated ?? autoUpdater;
    this.cacheMaintenance =
      options.cacheMaintenance ??
      new UpdateCacheMaintenance({
        resourcesPath: process.resourcesPath,
        activeBasePath,
        legacyBasePath,
        logger: this.logger,
      });
    this.state = {
      mode,
      preference: this.preference,
      defaultPreference: this.defaultPreference,
      automaticSupported: this.automaticSupported,
      manualReminder: false,
      status: "idle",
      currentVersion: options.currentVersion,
      releasesUrl: RELEASES_URL,
    };
    if (mode !== "disabled") this.attachListeners();
  }

  /** Localized product notes for a discovered version, if catalogued. */
  private notesFor(version: string | undefined): string | undefined {
    if (!version) return undefined;
    return formatChangelogNotes(version, this.getLocale());
  }

  /**
   * Loads stored update settings once. The read is counted to settlement and its
   * result is applied only while the entry that started it still owns the work;
   * a read admitted by a replaced owner is discarded so its successor re-reads.
   */
  private loadSettings(scope: UpdaterScope): Promise<void> {
    const preferenceRevision = this.preferenceRevision;
    return (async () => {
      const readSettings = this.readUpdateSettings;
      if (!readSettings) {
        this.applyPreference(this.preference, false, scope);
        return;
      }
      try {
        // Counted to settlement: a caller that stops waiting keeps this visible.
        const settings = await scope.track(() => readSettings());
        if (!scope.current()) {
          // The replacement owner must not inherit this read as its own state.
          this.settingsReady = null;
          return;
        }
        const lastNotifiedVersion = settings.lastNotifiedUpdateVersion;
        if (
          typeof lastNotifiedVersion === "string" &&
          lastNotifiedVersion.length > 0 &&
          lastNotifiedVersion.length <= 128
        ) {
          this.manualReminderTracker.hydrate(lastNotifiedVersion);
        }
        const dismissedVersion = settings.updateDismissedVersion;
        if (
          typeof dismissedVersion === "string" &&
          dismissedVersion.length > 0 &&
          dismissedVersion.length <= 128
        ) {
          this.dismissedVersion = dismissedVersion;
          if (this.state.availableVersion === dismissedVersion) {
            this.setState({ dismissed: true }, scope.owner);
          }
        }
        const preference = resolveStoredUpdatePreference(
          settings.updatePreference,
          this.defaultPreference,
        );
        if (preferenceRevision === this.preferenceRevision) {
          this.applyPreference(preference, false, scope);
        }
      } catch (error) {
        this.logger.app("updater", "warn", "update preferences unavailable", {
          data: { detail: String(error) },
        });
        if (!scope.current()) {
          this.settingsReady = null;
          return;
        }
        if (preferenceRevision === this.preferenceRevision) {
          this.applyPreference("manual", false, scope);
        }
      }
    })();
  }

  private async ensureSettingsLoaded(scope: UpdaterScope): Promise<void> {
    // A discarded result leaves `settingsReady` null, so a live entry retries
    // once with its own scope and reads the settings of the owner it belongs to.
    // A replaced entry reads nothing at all.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!scope.current()) return;
      const ready =
        this.settingsReady ?? (this.settingsReady = this.loadSettings(scope));
      await ready;
      if (this.settingsReady !== null) return;
    }
  }

  private manualReminderFor(
    version: string,
    owner: UpdaterOwnerGuard | null,
  ): boolean {
    // An unattributable event must not consume the reminder decision for a
    // version this owner cannot prove it discovered.
    if (owner === null) {
      this.activity.refuse("manual update reminder", "unattributed");
      return false;
    }
    const decision = this.manualReminderTracker.observe(version);
    if (decision.persist) this.persistLastNotified(version, owner);
    return decision.show;
  }

  /** Reminder bookkeeping is a settings write: gated, attributed and counted. */
  private persistLastNotified(
    version: string,
    owner: UpdaterOwnerGuard | null,
  ): void {
    const persist = this.persistLastNotifiedVersion;
    if (!persist) return;
    if (!this.activity.canPersist(owner)) {
      this.activity.refuse(
        "update reminder persistence",
        owner ? "closed" : "unattributed",
      );
      return;
    }
    void this.activity
      .track(async () => {
        // Revalidated at the write: nothing admitted here crosses a replacement.
        if (!this.activity.canPersist(owner)) {
          this.activity.refuse("update reminder persistence", "replaced");
          return;
        }
        await persist(version);
      })
      .catch((error: unknown) =>
        this.activity.lateFailure("update reminder persistence", error),
      );
  }

  private applyPreference(
    preference: UpdatePreference,
    checkImmediately: boolean,
    scope: UpdaterScope,
  ): void {
    const previousMode = this.state.mode;
    const effectivePreference = resolveEffectiveUpdatePreference(
      preference,
      this.automaticSupported,
    );
    const mode = resolveUpdateModePolicy(
      this.platform,
      this.isPackaged,
      this.env,
      this.distribution,
      effectivePreference,
    );
    const preferenceChanged =
      effectivePreference !== this.preference || mode !== previousMode;
    this.preference = effectivePreference;
    const dismissed =
      this.state.availableVersion !== undefined &&
      this.dismissedVersion === this.state.availableVersion;
    // A latched deferred effect: after disposal it must never re-enable the
    // installer electron-updater runs on quit.
    const latched = !this.activity.sealed();
    this.autoUpdater.autoDownload = mode === "in-app" && !dismissed && latched;
    this.autoUpdater.autoInstallOnAppQuit = mode === "in-app" && !dismissed && latched;
    if (!preferenceChanged) return;

    const patch: Partial<UpdateState> = {
      mode,
      preference: effectivePreference,
      manualReminder: false,
    };
    if (mode === "manual") {
      if (
        this.state.status === "downloading" ||
        this.state.status === "downloaded"
      ) {
        patch.status = this.state.availableVersion ? "available" : "idle";
        patch.progressPercent = undefined;
      }
      if (this.state.availableVersion) {
        patch.manualReminder = this.manualReminderFor(
          this.state.availableVersion,
          scope.owner,
        );
      }
    }
    this.setState(patch, scope.owner);
    if (
      checkImmediately &&
      previousMode === "manual" &&
      mode === "in-app"
    ) {
      // The user action that changed the preference owns the check it triggers.
      void this.runCheck(scope, {}).catch((error: unknown) =>
        this.activity.noteFailure("preference update check", error),
      );
    }
  }

  setPreference(preference: UpdatePreference): void {
    if (preference !== "automatic" && preference !== "manual") return;
    const scope = this.activity.begin("update preference");
    this.preferenceRevision += 1;
    this.applyPreference(preference, true, scope);
  }

  /**
   * Records the user's decision to stop nudging about `availableVersion`
   * until a newer version is detected (#1317). The banner hides itself from
   * the pushed `dismissed` flag, so the decision survives restarts.
   */
  async dismiss(): Promise<void> {
    const scope = this.activity.begin("dismiss update");
    // The decision itself is the fresh effect (a settings write); refuse it
    // rather than record a dismissal the original owner can no longer persist.
    scope.assertFresh();
    const version = this.state.availableVersion;
    if (!version) return;
    this.dismissedVersion = version;
    if (this.state.mode === "in-app") {
      this.autoUpdater.autoDownload = false;
      this.autoUpdater.autoInstallOnAppQuit = false;
    }
    this.setState(
      {
        status:
          this.state.status === "downloading" ||
          this.state.status === "downloaded"
            ? "available"
            : this.state.status,
        progressPercent: undefined,
        dismissed: true,
      },
      scope.owner,
    );
    if (this.activeDownloadCancellation?.version === version) {
      this.activeDownloadCancellation.cancel();
      this.activeDownloadCancellation = undefined;
    }
    await this.persistDismissedVersionInOrder(scope.owner, version);
  }

  private persistDismissedVersionInOrder(
    owner: UpdaterOwnerGuard | null,
    version: string | null,
  ): Promise<void> {
    const persist = this.persistDismissedVersion;
    if (!persist) return Promise.resolve();
    if (!this.activity.canPersist(owner)) {
      this.activity.refuse(
        "update dismissal persistence",
        owner ? "closed" : "unattributed",
      );
      return Promise.resolve();
    }
    // The head is read now so the chain below never awaits itself. The count
    // starts at enqueue, not when the queue finally reaches this write, so a
    // queued write stays visible for its whole life.
    const head = this.dismissedVersionPersistence;
    const queued = this.activity.track(async () => {
      await head;
      // Revalidated at execution: the original owner may be gone by now.
      if (!this.activity.canPersist(owner)) {
        this.activity.refuse("update dismissal persistence", "replaced");
        return;
      }
      await persist(version);
    });
    this.dismissedVersionPersistence = queued.catch((error: unknown) => {
      this.activity.lateFailure("update dismissal persistence", error);
    });
    return this.dismissedVersionPersistence;
  }

  private trackAutomaticDownload(
    scope: UpdaterScope,
    result: Awaited<ReturnType<AppUpdater["checkForUpdates"]>>,
  ): void {
    const downloadPromise = result?.downloadPromise;
    const cancellationToken = result?.cancellationToken;
    if (!downloadPromise || !cancellationToken) return;
    this.activeDownloadCancellation = {
      version: result.updateInfo.version,
      cancel: () => cancellationToken.cancel(),
    };
    // The download belongs to the check that started it, so its events keep that
    // operation's original owner; a later entry cannot adopt it.
    const stream = this.activity.openStream(scope.owner);
    // Counted until it really settles: a dismissal, a timeout or a dispose never
    // releases it.
    void scope
      .track(() => downloadPromise)
      .catch((error: unknown) =>
        this.activity.lateFailure("update download", error),
      )
      .finally(() => stream.close());
    if (this.dismissedVersion === result.updateInfo.version) {
      cancellationToken.cancel();
    }
  }

  private attachListeners() {
    if (this.listenersAttached) return;
    this.listenersAttached = true;

    // Do not let cached updates download or install before Host preferences load.
    this.autoUpdater.autoDownload = false;
    this.autoUpdater.autoInstallOnAppQuit = false;
    // electron-updater defaults allowPrerelease=true when the installed
    // version has a prerelease component (e.g. 0.2.0-rc.6). That pins the
    // GitHub provider to the same custom channel ("rc") and never offers a
    // newer stable release such as 0.2.2. Always track GitHub's latest
    // stable release so RC installs can graduate to stable.
    this.autoUpdater.allowPrerelease = false;
    // Only automatic mode may install on quit; manual mode never hands an
    // installer a no-install/portable directory.
    this.autoUpdater.logger = {
      info: (m: unknown) =>
        this.logger.app("updater", "info", "updater diagnostic", {
          data: { detail: String(m) },
        }),
      warn: (m: unknown) =>
        this.logger.app("updater", "warn", "updater diagnostic", {
          data: { detail: String(m) },
        }),
      error: (m: unknown) =>
        this.logger.app("updater", "error", "updater diagnostic", {
          data: { detail: String(m) },
        }),
      debug: (m: unknown) =>
        this.logger.app("updater", "debug", "updater diagnostic", {
          data: { detail: String(m) },
        }),
    };
    const onCheckingForUpdate = (): void => {
      this.setState(
        { status: "checking", error: undefined },
        this.activity.eventOwner(),
      );
    };
    const onUpdateAvailable = (info: UpdateInfo): void => {
      // electron-updater is a shared emitter: the event belongs to the live
      // transport that produced it, and `null` means two transports overlap.
      const owner = this.activity.eventOwner();
      // A newly discovered version supersedes any earlier dismissal.
      if (this.dismissedVersion && this.dismissedVersion !== info.version) {
        this.dismissedVersion = undefined;
        void this.persistDismissedVersionInOrder(owner, null);
      }
      const dismissed = this.dismissedVersion === info.version;
      // An unattributable event never enables a deferred installer, never claims
      // a download this owner cannot prove it started, and never pushes state.
      const automatic =
        owner !== null && this.state.mode === "in-app" && !dismissed;
      this.autoUpdater.autoDownload = automatic;
      this.autoUpdater.autoInstallOnAppQuit = automatic;
      this.setState(
        {
          status: automatic ? "downloading" : "available",
          availableVersion: info.version,
          releaseNotes: this.notesFor(info.version),
          progressPercent: automatic ? 0 : undefined,
          dismissed,
          manualReminder: automatic
            ? false
            : this.manualReminderFor(info.version, owner),
        },
        owner,
      );
    };
    const onUpdateNotAvailable = (): void => {
      const owner = this.activity.eventOwner();
      this.setState(
        {
          status: "up-to-date",
          availableVersion: undefined,
          releaseNotes: undefined,
          progressPercent: undefined,
          manualReminder: false,
        },
        owner,
      );
      // In-app installs have no newer staged installer after the feed reports
      // current. Keep the differential baselines for the next update. Manual
      // delivery modes may share a cache with an installed NSIS copy.
      if (this.state.mode === "in-app") {
        void this.discardDownloadedInstaller(owner);
      }
    };
    const onDownloadProgress = (progress: ProgressInfo): void => {
      const owner = this.activity.eventOwner();
      // A progress event from an unattributable transport claims nothing.
      if (owner === null) return;
      if (this.state.mode !== "in-app") return;
      if (this.dismissedVersion === this.state.availableVersion) return;
      this.setState(
        {
          status: "downloading",
          // Preserve notes already attached when discovery advanced to download.
          releaseNotes:
            this.state.releaseNotes ??
            this.notesFor(this.state.availableVersion),
          progressPercent: Math.round(progress.percent),
        },
        owner,
      );
    };
    const onUpdateDownloaded = (info: UpdateInfo): void => {
      const owner = this.activity.eventOwner();
      const dismissed = this.dismissedVersion === info.version;
      const automatic =
        owner !== null && this.state.mode === "in-app" && !dismissed;
      this.activeDownloadCancellation = undefined;
      this.autoUpdater.autoInstallOnAppQuit = automatic;
      this.setState(
        {
          status: automatic ? "downloaded" : "available",
          availableVersion: info.version,
          releaseNotes: this.notesFor(info.version),
          progressPercent: automatic ? 100 : undefined,
          dismissed,
          manualReminder: automatic
            ? false
            : this.manualReminderFor(info.version, owner),
        },
        owner,
      );
    };
    const onUpdateCancelled = (info: UpdateInfo): void => {
      const owner = this.activity.eventOwner();
      if (this.activeDownloadCancellation?.version === info.version) {
        this.activeDownloadCancellation = undefined;
      }
      if (this.dismissedVersion !== info.version) return;
      this.setState(
        {
          status: "available",
          progressPercent: undefined,
          dismissed: true,
        },
        owner,
      );
    };
    const onUpdaterError = (error: Error): void => {
      // Auto checks fail quietly (offline, private repo, rate limits);
      // the renderer only surfaces errors when `manual` is set.
      this.logger.app("updater", "warn", "updater error", { data: String(error) });
      this.setState(
        { status: "error", error: error.message },
        this.activity.eventOwner(),
      );
    };
    this.autoUpdater.on("checking-for-update", onCheckingForUpdate);
    this.autoUpdater.on("update-available", onUpdateAvailable);
    this.autoUpdater.on("update-not-available", onUpdateNotAvailable);
    this.autoUpdater.on("download-progress", onDownloadProgress);
    this.autoUpdater.on("update-downloaded", onUpdateDownloaded);
    this.autoUpdater.on("update-cancelled", onUpdateCancelled);
    this.autoUpdater.on("error", onUpdaterError);
    // Only these registrations belong to this controller; a shared emitter may
    // carry third-party listeners that disposal must never remove.
    this.listenerRemovals.push(
      () => this.autoUpdater.removeListener("checking-for-update", onCheckingForUpdate),
      () => this.autoUpdater.removeListener("update-available", onUpdateAvailable),
      () => this.autoUpdater.removeListener("update-not-available", onUpdateNotAvailable),
      () => this.autoUpdater.removeListener("download-progress", onDownloadProgress),
      () => this.autoUpdater.removeListener("update-downloaded", onUpdateDownloaded),
      () => this.autoUpdater.removeListener("update-cancelled", onUpdateCancelled),
      () => this.autoUpdater.removeListener("error", onUpdaterError),
    );
  }

  /** Removes exactly the listeners registered by `attachListeners()`. */
  private detachListeners(): void {
    if (!this.listenersAttached) return;
    this.listenersAttached = false;
    for (const remove of this.listenerRemovals.splice(0)) remove();
  }

  /** Detached cache pass: attributed, gated, skipped after closure, counted. */
  private discardDownloadedInstaller(
    owner: UpdaterOwnerGuard | null,
  ): Promise<void> {
    if (!this.activity.canPersist(owner)) {
      this.activity.refuse(
        "update cache discard",
        owner ? "closed" : "unattributed",
      );
      return Promise.resolve();
    }
    return this.activity
      .track(() => this.cacheMaintenance.discardDownloadedInstaller())
      .catch((error: unknown) => {
        this.activity.lateFailure("update cache discard", error);
      });
  }

  /**
   * Applies a state patch and pushes it only to the owner that produced it.
   * Read-only pushes cross a temporary admission inspection, but never a sealed
   * owner, a replaced origin, or an unattributable (ambiguous) event.
   */
  private setState(
    patch: Partial<UpdateState>,
    owner: UpdaterOwnerGuard | null,
  ) {
    this.state = { ...this.state, ...patch, manual: this.manualRequested };
    if (!this.activity.canPublish(owner)) return;
    this.send(IPC.event.updatesState, this.state);
  }

  getState(): UpdateState {
    return this.state;
  }

  /**
   * Re-resolve release notes after the product UI locale changes so the
   * banner and Settings → Info stay aligned without a new feed check.
   */
  refreshReleaseNotes(): UpdateState {
    if (!this.state.availableVersion) return this.state;
    const next = this.notesFor(this.state.availableVersion);
    if (next === this.state.releaseNotes) return this.state;
    // A locale refresh is a read-only push for whichever owner asks for it.
    this.setState({ releaseNotes: next }, this.activity.captureOwnerNow());
    return this.state;
  }

  /** User- or schedule-triggered check. Resolves with the settled state. */
  async check(options: { manual?: boolean } = {}): Promise<UpdateState> {
    return this.runCheck(this.activity.begin("update check"), options);
  }

  /**
   * One check entry with an immutable attribution. The settings read and the
   * transport handoff are both revalidated against that same original owner, so
   * a replacement that appears during an await is refused rather than served.
   */
  private async runCheck(
    scope: UpdaterScope,
    options: { manual?: boolean },
  ): Promise<UpdateState> {
    scope.assertFresh();
    await this.ensureSettingsLoaded(scope);
    if (this.state.mode === "disabled") {
      throw new Error("updates are disabled in development builds");
    }
    if (
      this.state.status === "checking" ||
      this.state.status === "downloading" ||
      this.state.status === "downloaded"
    ) {
      return this.state;
    }
    // A reentrant caller in the same tick would otherwise hand the same hidden
    // work to electron-updater twice; only one handoff may start.
    if (this.checkPending) return this.state;
    // The settings wait above may have crossed a replacement: refuse the
    // handoff and leave the replacement to its own entry.
    scope.assertFresh();
    this.manualRequested = Boolean(options.manual);
    const timeoutMs = this.manualRequested
      ? MANUAL_CHECK_TIMEOUT_MS
      : AUTO_CHECK_TIMEOUT_MS;
    this.checkPending = true;
    let stream: UpdaterStream | null = null;
    let handedOff = false;
    const closeStream = (): void => stream?.close();
    try {
      // Fire-and-forget relative to boot: callers must not await this from the
      // first-window path. The race only bounds *our* wait; electron-updater
      // may still finish later and emit available/up-to-date. The counted
      // operation is the real check, so a timed-out wait keeps it visible.
      stream = this.activity.openStream(scope.owner);
      const checkPromise = scope.attemptNative(() =>
        this.autoUpdater.checkForUpdates(),
      );
      handedOff = true;
      void checkPromise
        .then(
          (result) => this.trackAutomaticDownload(scope, result),
          (error: unknown) => this.activity.lateFailure("update check", error),
        )
        .finally(closeStream);
      await raceWithTimeout(checkPromise, timeoutMs, "update check");
    } catch (error) {
      // A bounded wait that expired leaves the transport running: only its own
      // settlement may close the attribution, so a straggler cannot silently
      // adopt a later entry's owner.
      if (!handedOff) closeStream();
      const timedOut =
        (error as { code?: unknown } | null)?.code === UPDATE_CHECK_TIMEOUT_CODE;
      if (timedOut) {
        if (this.manualRequested) {
          this.setState(
            { status: "error", error: "update check timed out" },
            scope.owner,
          );
          throw error;
        }
        // Auto checks fail quietly. Drop "checking" so a 60s GitHub hang
        // cannot skip the next interval or freeze Settings on a spinner.
        // Read through getState(): check() already narrowed this.state.status
        // away from "checking", but the checking-for-update listener can set
        // it during the awaited race.
        if (this.getState().status === "checking") {
          this.setState({ status: "idle", error: undefined }, scope.owner);
        }
        return this.state;
      }
      // A refused handoff stays diagnosable and must never be reported as a
      // quiet success; the 'error' listener already recorded real failures.
      this.activity.noteFailure("update check", error);
      if (options.manual) throw error;
    } finally {
      this.checkPending = false;
    }
    return this.state;
  }

  /** Explicit download for in-app installs when a check was manual-only. */
  async download(): Promise<UpdateState> {
    if (this.state.mode !== "in-app") {
      throw new Error("in-app download is not supported on this install");
    }
    if (
      this.downloadPending ||
      this.state.status === "downloading" ||
      this.state.status === "downloaded"
    ) {
      return this.state;
    }
    const scope = this.activity.begin("update download");
    scope.assertFresh();
    this.downloadPending = true;
    let stream: UpdaterStream | null = null;
    try {
      stream = this.activity.openStream(scope.owner);
      const started = scope.attemptNative(() =>
        this.autoUpdater.downloadUpdate(),
      );
      await started.finally(() => stream?.close());
      return this.state;
    } catch (error) {
      stream?.close();
      this.activity.noteFailure("update download", error);
      throw error;
    } finally {
      this.downloadPending = false;
    }
  }

  /**
   * True once a downloaded update was handed to the platform installer.
   *
   * The NSIS/AppImage installer is spawned before `app.quit()` and gives up
   * after a few seconds when the app is still running, so the quit that follows
   * must not be deferred — including by the explicit-quit confirmation.
   */
  isInstallingUpdate(): boolean {
    return this.installRequested;
  }

  /** Quit and install a downloaded update (in-app mode). */
  install(): void {
    if (this.state.mode !== "in-app" || this.state.status !== "downloaded") {
      throw new Error("no downloaded update to install");
    }
    const scope = this.activity.begin("install update");
    // IPC already admitted the caller, but the installer is spawned from this
    // entry, so a closed gate or a replaced original must refuse here before
    // any latch is set. The latch stays clear for the shutdown handler.
    scope.assertFresh();
    // Marked before the call: quitAndInstall spawns the installer itself, so
    // the shutdown handler must already know this quit is the update restart.
    this.installRequested = true;
    // Fires 'before-quit' first, so host/sidecar shutdown still runs. The
    // spawned installer never reports exit: the attempt stays uncontained.
    scope.attemptNativeEffect(() =>
      this.autoUpdater.quitAndInstall(false, true),
    );
  }

  /** Adopt legacy NSIS cache files before the first update check. */
  reclaimRelocatedUpdateCache(): Promise<void> {
    if (this.state.mode === "disabled") return Promise.resolve();
    const scope = this.activity.begin("update cache reclaim");
    if (!scope.current()) {
      // Boot wiring chains `.finally()` only; refuse without rejecting.
      this.activity.refuse(
        "update cache reclaim",
        this.activity.gateClosed() ? "closed" : "replaced",
      );
      return Promise.resolve();
    }
    return scope
      .track(() => this.cacheMaintenance.reclaimLegacyCache())
      .catch((error: unknown) => {
        this.activity.lateFailure("update cache reclaim", error);
      });
  }

  async openReleases(): Promise<void> {
    const scope = this.activity.begin("open update releases");
    const url = parseAllowedExternalUrl(RELEASES_URL);
    if (!url) throw new Error("DISALLOWED_EXTERNAL_URL");
    // The system browser is a real external launch: gated against this entry's
    // original owner, counted for the awaited call, and reported as uncontained
    // because that process never reports its exit. It is never killed.
    await scope.attemptNative(() => shell.openExternal(url));
  }

  /**
   * Schedule background GitHub feed checks. Never await this from boot: the
   * first check is delayed and time-bounded so a hung feed cannot block the
   * first window or pin the updater on `checking`.
   *
   * The timers stay contained: `dispose()` clears them, and each tick is its own
   * entry that refuses before any transport or filesystem effect once the gate
   * closes or its captured owner is replaced. A retained timer is therefore
   * reported through no counter.
   */
  startAutoCheck() {
    if (this.autoCheckStarted || this.state.mode === "disabled") return;
    const scope = this.activity.begin("automatic update checks");
    if (!scope.current()) {
      this.activity.refuse(
        "automatic update checks",
        this.activity.gateClosed() ? "closed" : "replaced",
      );
      return;
    }
    this.autoCheckStarted = true;
    void this.ensureSettingsLoaded(scope).then(
      () => {
        if (this.activity.sealed() || this.state.mode === "disabled") return;
        this.initialTimer = setTimeout(() => {
          void this.check().catch((error: unknown) =>
            this.activity.noteFailure("automatic update check", error),
          );
        }, AUTO_CHECK_INITIAL_DELAY_MS);
        this.intervalTimer = setInterval(() => {
          void this.check().catch((error: unknown) =>
            this.activity.noteFailure("automatic update check", error),
          );
        }, AUTO_CHECK_INTERVAL_MS);
      },
      (error: unknown) =>
        this.activity.noteFailure("automatic update checks", error),
    );
  }

  /**
   * Synchronous, side-effect-free activity for the Desktop handoff inventory.
   *
   * Unsettled work stays counted after disposal, so this never claims that a
   * sealed owner released a check, download, cache pass or installer handoff.
   */
  getHandoffActivity(): UpdaterHandoffActivity {
    return this.activity.snapshot(this.installRequested ? 1 : 0);
  }

  dispose() {
    // Seal first: timers, listeners and late continuations must not start work
    // from here on. Settled counters are not rewritten.
    this.activity.seal();
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.initialTimer = null;
    this.intervalTimer = null;
    // Cancel the download this controller owns; the token only exists for
    // downloads electron-updater started from a check. Its settlement stays
    // counted until the real promise reports it.
    const cancellation = this.activeDownloadCancellation;
    this.activeDownloadCancellation = undefined;
    if (cancellation) {
      try {
        cancellation.cancel();
      } catch (error) {
        this.activity.lateFailure("update download cancellation", error);
      }
    }
    this.detachListeners();
    this.logger.app("updater", "info", "updater sealed; unsettled work retained", {
      data: this.getHandoffActivity(),
    });
  }
}
