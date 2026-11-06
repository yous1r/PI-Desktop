import { writeDeploymentWorkerScript } from "./pi-host-deployment-worker.js";

/** Generated POSIX-shell bridge that verifies upload then starts the detached deployment worker. */
export function buildPiHostTransactionScript(): string {
  return String.raw`step() { printf '%s\n' "PI_HOST_BOOTSTRAP $1"; }
die() {
  code=$1
  printf '%s\n' "PI_HOST_BOOTSTRAP_FAILED $code" >&2
  printf '%s\n' "PI_HOST_FAILED {\"code\":\"$code\",\"step\":\"$code\"}"
  exit 1
}
need() { command -v "$1" >/dev/null 2>&1 || die "missing-$1"; }
[ -n "${"${"}HOME:-}" ] || die "no-home"
need tar
need cp
need flock
[ "$(uname -s)" = Linux ] || die "unsupported-platform"
case "$EXPECTED_SHA256" in *[!a-f0-9]*|'') die "invalid-checksum" ;; esac
[ "${"${"}#EXPECTED_SHA256}" -eq 64 ] || die "invalid-checksum"
[ -n "$ARTIFACT_PATH" ] || die "upload-required"

base="$HOME/.pi-desktop/pi-host"
work="$base/.bootstrap"
transactions="$work/transactions"
mkdir -p "$base" "$work" "$transactions"
chmod 700 "$base" "$work" "$transactions" 2>/dev/null || die "deployment-permissions"
for directory in "$base" "$work" "$transactions"; do
  [ ! -L "$directory" ] && [ -d "$directory" ] || die "unsafe-deployment-directory"
done
case "$ARTIFACT_PATH" in "$base"/.upload.*/artifact.tar.gz) ;; *) die "invalid-artifact-path" ;; esac
[ -f "$ARTIFACT_PATH" ] && [ ! -L "$ARTIFACT_PATH" ] || die "upload-missing"
chmod 600 "$ARTIFACT_PATH" 2>/dev/null || die "artifact-permissions"
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d ' ' -f 1
  else return 127
  fi
}
step "verify"
actual=$(sha256_of "$ARTIFACT_PATH") || die "missing-sha256-tool"
[ "$actual" = "$EXPECTED_SHA256" ] || die "checksum-mismatch"

step "stage"
prepare=$(mktemp -d "$work/.prepare.XXXXXXXX") || die "stage-failed"
trap 'rm -rf "$prepare"' EXIT
mkdir "$prepare/unpack"
tar -xzf "$ARTIFACT_PATH" -C "$prepare/unpack" || die "extract-failed"
bundle="$prepare/unpack/$BUNDLE_DIR"
[ -d "$bundle" ] && [ ! -L "$bundle" ] || die "unexpected-archive-layout"
[ -x "$bundle/bin/node" ] || die "missing-deployment-worker"
sh "$bundle/install.sh" --verify >/dev/null 2>&1 || die "bundle-verification-failed"
worker_node="$bundle/bin/node"
worker_dir="$prepare"
${writeDeploymentWorkerScript()}
state="$work/deployment-state.json"
if [ -e "$state" ] || [ -L "$state" ]; then
  [ -f "$state" ] && [ ! -L "$state" ] || die "HOST_RECOVERY_REQUIRED"
  phase=$(grep -o '"phase":"[^"]*"' "$state" 2>/dev/null | head -n 1 | cut -d '"' -f 4) || die "HOST_RECOVERY_REQUIRED"
  case "$phase" in
    complete|failed-safe) ;;
    recovery-required|awaiting-racp)
      recovery_reply=$(NODE_OPTIONS= NODE_PATH= flock -w 15 "$base/.deploy.lock" "$bundle/bin/node" "$prepare/deploy.mjs" --begin-recovery "$VERSION" "$EXISTING_HOST_ID" "$EXPECTED_DEVICE_TOKEN_HASH" "$PRESERVE_PAIRING" "$EXPECTED_SHA256") || die "HOST_RECOVERY_REQUIRED"
      recovery_job=$(printf '%s\n' "$recovery_reply" | sed -n 's/^PI_HOST_RECOVERY_JOB //p')
      printf '%s\n' "$recovery_job" | grep -Eq '^[a-f0-9]{32}/recovery-[a-f0-9]{32}$' || die "HOST_RECOVERY_REQUIRED"
      recovery_dir="$transactions/$recovery_job"
      waited=0
      while [ "$waited" -lt "$((READY_TIMEOUT_SEC + 720))" ]; do
        if [ -f "$recovery_dir/failure.json" ]; then
          case "$(cat "$recovery_dir/failure.json")" in
            *HOST_BUSY*) die "HOST_BUSY" ;; *HOST_AUTH_FAILED*) die "HOST_AUTH_FAILED" ;;
            *HOST_VERSION_MISMATCH*) die "HOST_VERSION_MISMATCH" ;; *) die "HOST_RECOVERY_REQUIRED" ;;
          esac
        fi
        if [ -f "$recovery_dir/done.json" ]; then cat "$recovery_dir/output.txt"; exit 0; fi
        sleep 1
        waited=$((waited + 1))
      done
      die "HOST_RECOVERY_REQUIRED" ;;
    *) die "HOST_RECOVERY_REQUIRED" ;;
  esac
fi
transaction_id=$(NODE_OPTIONS= NODE_PATH= "$bundle/bin/node" -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))') || die "transaction-id-failed"
case "$transaction_id" in *[!a-f0-9]*|'') die "transaction-id-failed" ;; esac
[ "${"${"}#transaction_id}" -eq 32 ] || die "transaction-id-failed"
txdir="$transactions/$transaction_id"
mkdir "$txdir" || die "transaction-create-failed"
chmod 700 "$txdir" || die "transaction-permissions"
cp "$ARTIFACT_PATH" "$txdir/artifact.tar.gz" || die "upload-copy-failed"
cp "$prepare/deploy.mjs" "$txdir/deploy.mjs" || die "worker-copy-failed"
cp "$prepare/deploy-recovery.mjs" "$txdir/deploy-recovery.mjs" || die "worker-copy-failed"
cp "$bundle/bin/node" "$txdir/node" || die "worker-copy-failed"
chmod 700 "$txdir/node" || die "transaction-permissions"
chmod 600 "$txdir/artifact.tar.gz" "$txdir/deploy.mjs" "$txdir/deploy-recovery.mjs" || die "transaction-permissions"

export PI_TX_TRANSACTION="$transaction_id" PI_TX_VERSION="$VERSION"
export PI_TX_BUNDLE_DIR="$BUNDLE_DIR" PI_TX_ARTIFACT_NAME="$ARTIFACT_NAME"
export PI_TX_SHA256="$EXPECTED_SHA256" PI_TX_ARTIFACT_PATH="$txdir/artifact.tar.gz"
export PI_TX_PORT="$PORT" PI_TX_PAIRING_LIFETIME_MS="$PAIRING_LIFETIME_MS" PI_TX_READY_TIMEOUT_SEC="$READY_TIMEOUT_SEC"
export PI_TX_EXPECTED_HOST_ID="$EXISTING_HOST_ID" PI_TX_EXPECTED_CURRENT_VERSION="$EXPECTED_CURRENT_VERSION"
export PI_TX_EXPECTED_DEVICE_TOKEN_HASH="$EXPECTED_DEVICE_TOKEN_HASH"
export PI_TX_ALLOW_LEGACY_MAINTENANCE="$ALLOW_LEGACY_MAINTENANCE" PI_TX_PRESERVE_PAIRING="$PRESERVE_PAIRING"
export PI_TX_REQUEST="$txdir/request.json"
NODE_OPTIONS= NODE_PATH= "$txdir/node" -e '
const { writeFileSync } = require("node:fs");
const request = {
  transactionId: process.env.PI_TX_TRANSACTION,
  version: process.env.PI_TX_VERSION,
  bundleDir: process.env.PI_TX_BUNDLE_DIR,
  artifactName: process.env.PI_TX_ARTIFACT_NAME,
  expectedSha256: process.env.PI_TX_SHA256,
  artifactPath: process.env.PI_TX_ARTIFACT_PATH,
  port: Number(process.env.PI_TX_PORT),
  pairingLifetimeMs: Number(process.env.PI_TX_PAIRING_LIFETIME_MS),
  readyTimeoutSec: Number(process.env.PI_TX_READY_TIMEOUT_SEC),
  ...(process.env.PI_TX_EXPECTED_HOST_ID ? { expectedHostId: process.env.PI_TX_EXPECTED_HOST_ID } : {}),
  ...(process.env.PI_TX_EXPECTED_CURRENT_VERSION ? { expectedCurrentVersion: process.env.PI_TX_EXPECTED_CURRENT_VERSION } : {}),
  ...(process.env.PI_TX_EXPECTED_DEVICE_TOKEN_HASH ? { expectedDeviceTokenHash: process.env.PI_TX_EXPECTED_DEVICE_TOKEN_HASH } : {}),
  allowLegacyMaintenance: process.env.PI_TX_ALLOW_LEGACY_MAINTENANCE === "true",
  preservePairing: process.env.PI_TX_PRESERVE_PAIRING === "true",
};
writeFileSync(process.env.PI_TX_REQUEST, JSON.stringify(request) + String.fromCharCode(10), { mode: 0o600, flag: "wx" });
' || die "request-write-failed"

step "deploy"
NODE_OPTIONS= NODE_PATH= "$txdir/node" "$txdir/deploy.mjs" --begin "$txdir/request.json" || {
  case "$(cat "$txdir/failure.json" 2>/dev/null || true)" in
    *HOST_BUSY*) die "HOST_BUSY" ;; *HOST_AUTH_FAILED*) die "HOST_AUTH_FAILED" ;;
    *HOST_VERSION_MISMATCH*) die "HOST_VERSION_MISMATCH" ;; *HOST_MAINTENANCE_UNAVAILABLE*) die "HOST_MAINTENANCE_UNAVAILABLE" ;;
    *HOST_RECOVERY_REQUIRED*) die "HOST_RECOVERY_REQUIRED" ;; *) die "deployment-start-failed" ;;
  esac
}
step "await-ready"
waited=0
max_wait=$((READY_TIMEOUT_SEC + 720))
while [ "$waited" -lt "$max_wait" ]; do
  if [ -f "$txdir/failure.json" ]; then
    case "$(cat "$txdir/failure.json")" in
      *HOST_BUSY*) die "HOST_BUSY" ;; *HOST_AUTH_FAILED*) die "HOST_AUTH_FAILED" ;;
      *HOST_VERSION_MISMATCH*) die "HOST_VERSION_MISMATCH" ;; *HOST_MAINTENANCE_UNAVAILABLE*) die "HOST_MAINTENANCE_UNAVAILABLE" ;;
      *HOST_STOP_TIMEOUT*) die "host-stop-timeout" ;; *HOST_PROCESS_UNIDENTIFIED*) die "host-process-unidentified" ;;
      *HOST_RECOVERY_REQUIRED*) die "HOST_RECOVERY_REQUIRED" ;; *) die "deployment-failed" ;;
    esac
  fi
  if [ -f "$txdir/result.txt" ] && [ -f "$state" ]; then
    phase=$(grep -o '"phase":"[^"]*"' "$state" 2>/dev/null | head -n 1 | cut -d '"' -f 4 || true)
    if [ "$phase" = awaiting-racp ]; then
      ready=$(sed -n '1p' "$txdir/result.txt")
      pairing=$(sed -n '2p' "$txdir/result.txt")
      [ -n "$ready" ] || die "HOST_RECOVERY_REQUIRED"
      printf '%s\n' "$ready"
      [ -z "$pairing" ] || printf '%s\n' "$pairing"
      printf '%s\n' "PI_HOST_DEPLOYMENT_TRANSACTION $transaction_id"
      step "ready"
      exit 0
    fi
  fi
  sleep 1
  waited=$((waited + 1))
done
die "deployment-timeout"
`;
}
