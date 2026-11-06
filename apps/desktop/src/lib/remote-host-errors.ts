/**
 * Only approved localized summaries cross into remote-host UI; never raw
 * stderr. Preparation failures are listed here as well, because they reach the
 * renderer as error codes on `RemoteHostSummary.preparation` and as the
 * rejection of `remoteHostPrepare` — the same code, so the same sentence.
 */
export function remoteHostErrorKey(error: unknown): string {
  let code: unknown;
  if (error && typeof error === "object") {
    code = "errorCode" in error ? error.errorCode : "code" in error ? error.code : undefined;
  }
  return remoteHostErrorCodeKey(code);
}

/** The mapping alone, for callers that already hold a bare code. */
export function remoteHostErrorCodeKey(code: unknown): string {
  switch (code) {
    case "REMOTE_PATH_NOT_FOUND": return "remote:pathUnavailable";
    case "REMOTE_PATH_FORBIDDEN": return "remote:pathForbidden";
    case "HOST_VERSION_MISMATCH": return "remote:upgradeRequired";
    case "HOST_AUTH_FAILED":
    case "SSH_AUTH_FAILED":
    case "TOKEN_INVALID":
    case "PAIRING_FAILED": return "remote:authenticationRequired";
    case "HOST_DISCONNECTED":
    case "REMOTE_CONNECTION_FAILED":
    case "AGENT_UNAVAILABLE": return "remote:connectionUnavailable";
    case "REMOTE_MUTATION_OUTCOME_UNKNOWN": return "remote:mutationUncertain";
    // Preparation stops the user can act on (spec: demand update).
    case "HOST_DOWNLOAD_REQUIRED": return "remote:preparation.error.downloadRequired";
    case "HOST_MAINTENANCE_REQUIRED": return "remote:preparation.error.maintenanceRequired";
    case "HOST_BUSY": return "remote:preparation.error.busy";
    case "HOST_CLIENT_TOO_OLD": return "remote:preparation.error.clientTooOld";
    case "HOST_VERSION_UNSUPPORTED": return "remote:preparation.error.versionUnsupported";
    case "HOST_RELEASE_UNAVAILABLE": return "remote:preparation.error.releaseUnavailable";
    case "HOST_DOWNLOAD_FAILED": return "remote:preparation.error.downloadFailed";
    case "HOST_UPLOAD_FAILED": return "remote:preparation.error.uploadFailed";
    case "HOST_NETWORK_NOT_READY": return "remote:preparation.error.networkNotReady";
    case "HOST_INTEGRITY_FAILED": return "remote:preparation.error.integrityFailed";
    case "HOST_START_FAILED": return "remote:preparation.error.startFailed";
    case "HOST_RECOVERY_REQUIRED": return "remote:preparation.error.recoveryRequired";
    case "HOST_PREPARATION_CANCELLED": return "remote:preparation.error.cancelled";
    default: return "remote:operationFailed";
  }
}
