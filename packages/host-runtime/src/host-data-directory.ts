import { ErrorCodes } from "@pi-desktop/shared";

/** A competing Host must exit before opening or recovering this data directory. */
export class HostDataDirectoryInUseError extends Error {
  readonly errorCode = ErrorCodes.HOST_DATA_DIR_IN_USE;

  constructor() {
    super("Another Host owns this data directory. Close that owner before starting this Host; do not delete the ownership lock.");
    this.name = "HostDataDirectoryInUseError";
  }
}

/** Only the Rust main failure marker is authoritative, not arbitrary log text. */
export function diagnoseHostDataDirectoryFailure(stderr: string): HostDataDirectoryInUseError | null {
  return /^Error: HOST_DATA_DIR_IN_USE: another host-core owns this data directory\r?$/m.test(stderr)
    ? new HostDataDirectoryInUseError()
    : null;
}
