/**
 * Durable SSH port forwards for bootstrapped remote hosts (spec §5.2 step 4).
 *
 * A paired host is reached at `ws://127.0.0.1:<forwarded port>`, and that port
 * only exists while an `ssh -N -L` session is alive. The manager owns those
 * sessions for the lifetime of the app: one per host key, re-used while the
 * host stays paired, closed when the host is removed or the app quits.
 *
 * The forward is opened lazily by {@link SshTunnelManager.open} on the next
 * launch, and adopted from the bootstrap on the pairing path
 * ({@link SshTunnelManager.adopt}) so pairing never pays for a forward it is
 * about to throw away.
 */
import { RACP_WS_PATH, type RemoteHostSshMetadata } from "@pi-desktop/shared";
import { ExternalResourceActivity } from "../external-resource-activity.js";
import { ensureRemoteHostReady } from "./remote-host-supervisor.js";
import { completeHostDeployment } from "./remote-host-deployment.js";
import {
  createSystemSshTransport,
  reserveLocalPort,
  type SshForward,
  type SshTarget,
  type SshTransport,
} from "./ssh-transport.js";

/** The loopback RACP endpoint a forward on `port` exposes. */
export function racpUrlForLocalPort(port: number): string {
  return `ws://127.0.0.1:${port}${RACP_WS_PATH}`;
}

/**
 * Translate a persisted descriptor into `ssh` arguments.
 *
 * `sshSecret` is the login password read back from the encrypted record and is
 * deliberately not part of {@link RemoteHostSshMetadata}: the descriptor is
 * plaintext metadata that the renderer also receives, so the secret travels
 * beside it rather than inside it.
 */
export function sshTargetOf(ssh: RemoteHostSshMetadata, sshSecret?: string): SshTarget {
  return {
    host: ssh.host,
    ...(ssh.port !== undefined ? { port: ssh.port } : {}),
    ...(ssh.user ? { user: ssh.user } : {}),
    ...(ssh.identityFile ? { identityFile: ssh.identityFile } : {}),
    ...(sshSecret ? { password: sshSecret } : {}),
  };
}

export type SshTunnel = {
  /** `ws://127.0.0.1:<localPort>/v1/racp/ws` for this host right now. */
  url: string;
  localPort: number;
  /** Complete an interrupted deployment only after authenticated RACP verification. */
  completePreparation?: () => Promise<void>;
};

export type SshTunnelManagerOptions = {
  isAdmissionClosed?: () => boolean;
  /**
   * Build the transport for one host. Defaults to the system `ssh` client,
   * which is what makes the user's own `~/.ssh/config` and agent apply; tests
   * substitute a fake so no process is spawned. The second argument is the
   * decrypted login password, absent for a key-authenticated host.
   */
  buildTransport?: (ssh: RemoteHostSshMetadata, sshSecret?: string) => SshTransport;
  /** Reserve the loopback port `-L` binds. Injectable for deterministic tests. */
  reservePort?: () => Promise<number>;
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
};

export interface SshTunnelManager {
  /**
   * Open the forward for `hostKey`, or return the live one. `sshSecret` is the
   * decrypted login password when the host authenticates with one.
   */
  open(hostKey: string, ssh: RemoteHostSshMetadata, sshSecret?: string): Promise<SshTunnel>;
  /** Take ownership of a forward the bootstrap already opened. */
  adopt(hostKey: string, ssh: RemoteHostSshMetadata, forward: SshForward): Promise<SshTunnel>;
  /** Close the forward for one host; a missing key is a no-op. */
  close(hostKey: string): Promise<void>;
  /** Close every forward. Idempotent; safe before any `open`. */
  dispose(): Promise<void>;
  getHandoffActivity(): { operations: number; resources: number; uncontainedResources: number };
}

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type TunnelEntry = {
  key: string;
  transport?: SshTransport;
  forward?: SshForward;
  tunnel?: SshTunnel;
  opened: Deferred<SshTunnel>;
  initialized: Deferred<void>;
  retired: boolean;
  disposed: boolean;
  disposeError?: unknown;
  closing?: Promise<void>;
  forwardClosing?: Promise<void>;
  preparing?: Promise<void>;
};

export function createSshTunnelManager(options: SshTunnelManagerOptions = {}): SshTunnelManager {
  const log = options.log ?? (() => undefined);
  const activity = new ExternalResourceActivity(options.isAdmissionClosed ?? (() => false));
  const buildTransport = options.buildTransport ?? ((ssh: RemoteHostSshMetadata, sshSecret?: string) =>
    createSystemSshTransport(sshTargetOf(ssh, sshSecret), { log }));
  const reservePort = options.reservePort ?? reserveLocalPort;
  const entries = new Map<string, TunnelEntry>();
  const owned = new Set<TunnelEntry>();
  let closed = false;
  let disposal: Promise<void> | undefined;
  const disconnected = () => Object.assign(new Error("SSH forward was closed"), { errorCode: "HOST_DISCONNECTED" });
  const assertOpen = () => { if (closed) throw disconnected(); activity.assertOpen(); };
  const assertCurrent = (entry: TunnelEntry) => {
    if (entry.retired || entries.get(entry.key) !== entry) throw disconnected();
    assertOpen();
  };
  function reportCleanup(): void {
    try { log("warn", "SSH tunnel cleanup could not be confirmed; idle handoff remains unavailable"); }
    catch { console.error("SSH tunnel cleanup notification failed"); }
  }
  function disposeTransport(entry: TunnelEntry): void {
    if (!entry.transport || entry.disposed) return;
    entry.disposed = true;
    try { entry.transport.dispose(); }
    catch (error) { entry.disposeError = error; }
  }
  function closeForward(entry: TunnelEntry): Promise<void> | undefined {
    if (!entry.forward || entry.forwardClosing) return entry.forwardClosing;
    const completion = deferred<void>();
    entry.forwardClosing = completion.promise;
    void activity.track(() => entry.forward!.close()).then(completion.resolve, completion.reject);
    // Original close remains owned even if initialization has not completed.
    void completion.promise.catch(() => undefined);
    return completion.promise;
  }
  function closeEntry(entry: TunnelEntry): Promise<void> {
    if (entry.closing) return entry.closing;
    const completion = deferred<void>();
    entry.closing = completion.promise;
    entry.retired = true;
    void activity.track(async () => {
      closeForward(entry);
      disposeTransport(entry);
      await entry.initialized.promise;
      disposeTransport(entry);
      const [forward] = await Promise.allSettled([closeForward(entry), entry.preparing]);
      if (forward.status === "rejected") throw forward.reason;
      if (entry.disposeError !== undefined) throw entry.disposeError;
    }).then(() => {
      forget(entry); completion.resolve();
    }, error => {
      forget(entry); reportCleanup(); completion.reject(error);
    });
    void completion.promise.catch(() => undefined);
    return completion.promise;
  }
  function forget(entry: TunnelEntry): void {
    owned.delete(entry);
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
  }
  function createEntry(key: string): TunnelEntry {
    const entry: TunnelEntry = { key, opened: deferred<SshTunnel>(), initialized: deferred<void>(), retired: false, disposed: false };
    entries.set(key, entry); owned.add(entry);
    return entry;
  }
  function initialize(entry: TunnelEntry, operation: () => Promise<SshTunnel>): Promise<SshTunnel> {
    void activity.track(async () => {
      try {
        const tunnel = await operation();
        assertCurrent(entry);
        entry.tunnel = tunnel;
        entry.initialized.resolve();
        return tunnel;
      } catch (error) {
        entry.initialized.resolve();
        await closeEntry(entry);
        throw error;
      }
    }).then(entry.opened.resolve, entry.opened.reject);
    return entry.opened.promise;
  }
  function preparation(entry: TunnelEntry, transactionId: string, hostId: string): Promise<void> {
    try { assertCurrent(entry); } catch (error) { return Promise.reject(error); }
    if (entry.preparing) return entry.preparing;
    const completion = deferred<void>();
    entry.preparing = completion.promise;
    void activity.track(async () => {
      assertCurrent(entry);
      await completeHostDeployment(entry.transport!, transactionId, hostId);
      assertCurrent(entry);
      if (entry.tunnel) delete entry.tunnel.completePreparation;
    }).then(completion.resolve, completion.reject);
    return completion.promise;
  }

  return {
    async open(hostKey, ssh, sshSecret) {
      assertOpen();
      const existing = entries.get(hostKey);
      if (existing) {
        assertCurrent(existing);
        return existing.opened.promise;
      }
      const entry = createEntry(hostKey);
      return initialize(entry, async () => {
        assertCurrent(entry);
        activity.nativeAttempt();
        entry.transport = buildTransport(ssh, sshSecret);
        assertCurrent(entry);
        const ready = await ensureRemoteHostReady(entry.transport, { version: ssh.version, expectedHostId: ssh.hostId });
        assertCurrent(entry);
        const localPort = await reservePort();
        assertCurrent(entry);
        entry.forward = await entry.transport.forward({
          localPort, remoteHost: ready.host === "::1" ? "[::1]" : ready.host, remotePort: ready.port,
          assertCurrent: () => assertCurrent(entry),
        });
        assertCurrent(entry);
        log("info", "ssh forward open", { hostKey, localPort: entry.forward.localPort, remotePort: ready.port });
        assertCurrent(entry);
        const tunnel: SshTunnel = { url: racpUrlForLocalPort(entry.forward.localPort), localPort: entry.forward.localPort };
        if (ready.transactionId) {
          const transactionId = ready.transactionId;
          tunnel.completePreparation = () => preparation(entry, transactionId, ready.hostId);
        }
        return tunnel;
      });
    },
    async adopt(hostKey, _ssh, forward) {
      assertOpen();
      const previous = entries.get(hostKey);
      activity.nativeAttempt();
      const entry = createEntry(hostKey);
      entry.forward = forward;
      return initialize(entry, async () => {
        if (previous) await closeEntry(previous);
        assertCurrent(entry);
        return { url: racpUrlForLocalPort(forward.localPort), localPort: forward.localPort };
      });
    },
    close(hostKey) {
      const entry = entries.get(hostKey);
      return entry ? closeEntry(entry) : Promise.resolve();
    },
    dispose() {
      if (disposal) return disposal;
      const completion = deferred<void>();
      disposal = completion.promise;
      closed = true; activity.seal();
      void Promise.allSettled([...owned].map(closeEntry)).then(results => {
        const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
        if (failures.length) completion.reject(new AggregateError(failures, "SSH tunnel cleanup could not be confirmed"));
        else completion.resolve();
      });
      return disposal;
    },
    getHandoffActivity: () => activity.snapshot(owned.size),
  };
}
