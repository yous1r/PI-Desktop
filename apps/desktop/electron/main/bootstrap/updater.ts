import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { UpdaterOptions } from "../updater";
import { AppUpdaterController } from "../updater";

/** Production callbacks resolve synchronously after the controller checks its
 * immutable original-owner guard; each RPC then remains on that exact Host. */
export function createDesktopUpdater(input: {
  logger: Logger;
  send: UpdaterOptions["send"];
  currentVersion: string;
  isPackaged: boolean;
  getLocale: () => string;
  getHost: () => HostProcess | null;
  isAdmissionClosed: () => boolean;
}) {
  const host = () => {
    const current = input.getHost();
    if (!current?.isAvailable()) throw new Error("host unavailable");
    return current;
  };
  return new AppUpdaterController({
    ...input,
    captureOwner: () => {
      const original = input.getHost(), generation = original?.generation;
      return () => !!original && input.getHost() === original && original.generation === generation && original.isAvailable();
    },
    readUpdateSettings: () => host().call("settings.get"),
    persistLastNotifiedVersion: async (version) => { await host().call("settings.set", { lastNotifiedUpdateVersion: version }); },
    persistDismissedVersion: async (version) => { await host().call("settings.set", { updateDismissedVersion: version }); },
  });
}
