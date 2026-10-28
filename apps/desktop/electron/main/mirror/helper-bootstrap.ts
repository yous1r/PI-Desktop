import { randomUUID } from "node:crypto";
import type { SshTransport } from "../remote/ssh-transport.js";
import { shellQuote } from "../remote/pi-host-bootstrap-script.js";
import type { HelperArtifact } from "./helper-bundle.js";

const DEFAULT_READY_TIMEOUT_SECONDS = 30;
const MAX_READY_TIMEOUT_SECONDS = 120;

export type HelperReady = {
  port: number;
  version: string;
  protocol: 1;
  token: string;
};

export type HelperBootstrapOptions = {
  transport: SshTransport;
  artifact: HelperArtifact;
  desktopVersion: string;
  readyTimeoutSeconds?: number;
};

function fail(message: string, errorCode: string): Error {
  return Object.assign(new Error(message), { errorCode });
}

function safeToken(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function safeVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

export function parseHelperReady(stdout: string, expectedVersion: string): HelperReady {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 2 || !lines[0]?.startsWith("PI_HELPER_READY ")
      || !lines[1]?.startsWith("PI_HELPER_TOKEN ")) {
    throw fail("The remote helper did not report a single ready line and token", "HELPER_START_FAILED");
  }
  const token = lines[1].slice("PI_HELPER_TOKEN ".length);
  if (!safeToken(token)) throw fail("The remote helper reported an invalid token", "HELPER_START_FAILED");
  let payload: unknown;
  try {
    payload = JSON.parse(lines[0].slice("PI_HELPER_READY ".length)) as unknown;
  } catch {
    throw fail("The remote helper reported malformed readiness", "HELPER_START_FAILED");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw fail("The remote helper reported invalid readiness", "HELPER_START_FAILED");
  }
  const record = payload as Record<string, unknown>;
  if (!Number.isInteger(record.port) || typeof record.port !== "number" || record.port < 1 || record.port > 65535
      || typeof record.version !== "string" || record.protocol !== 1) {
    throw fail("The remote helper reported invalid readiness", "HELPER_START_FAILED");
  }
  if (record.version !== expectedVersion) {
    throw fail("The remote helper version does not match this Desktop release", "HELPER_VERSION_MISMATCH");
  }
  return { port: record.port, version: record.version, protocol: 1, token };
}

export function buildHelperBootstrapScript(input: {
  digest: string;
  version: string;
  stageName: string;
  readyTimeoutSeconds: number;
}): string {
  if (!safeToken(input.digest) || !safeVersion(input.version)
      || !/^\.upload\.[a-f0-9]{32}$/.test(input.stageName)
      || !Number.isInteger(input.readyTimeoutSeconds)
      || input.readyTimeoutSeconds < 1 || input.readyTimeoutSeconds > MAX_READY_TIMEOUT_SECONDS) {
    throw fail("Invalid bundled helper bootstrap input", "HELPER_DEPLOY_FAILED");
  }
  const digest = shellQuote(input.digest);
  const version = shellQuote(input.version);
  const stageName = input.stageName;
  const timeout = shellQuote(String(input.readyTimeoutSeconds));
  return `#!/bin/sh
set -eu
umask 077
die() { printf '%s\\n' "PI_HELPER_BOOTSTRAP_FAILED $1" >&2; exit 1; }
[ -n "\${HOME:-}" ] || die no-home
base="$HOME/.pi-desktop-helper"
[ ! -L "$base" ] || die unsafe-helper-root
mkdir -p "$base" || die helper-directory
chmod 700 "$base" || die helper-directory
[ ! -L "$base" ] || die unsafe-helper-root
stage="$base/${stageName}"
install_tmp="$base/bin/.pi-helper.new"
pidfile="$base/pids/helper.pid"
pid_tmp="$base/pids/helper.pid.new.${stageName}"
log="$base/logs/helper.log"
trap 'rm -f -- "$stage" "$install_tmp" "$pid_tmp"' EXIT
trap 'exit 1' HUP INT TERM
[ ! -e "$stage" ] && [ ! -L "$stage" ] || die unsafe-stage
cat > "$stage" || die upload
[ ! -L "$stage" ] && [ -f "$stage" ] || die missing-upload
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d ' ' -f 1
  else return 1; fi
}
actual=$(sha256_of "$stage") || die missing-sha256-tool
[ "$actual" = ${digest} ] || die checksum-mismatch
for dir in "$base/bin" "$base/logs" "$base/pids"; do
  [ ! -L "$dir" ] || die unsafe-helper-directory
  mkdir -p "$dir" || die helper-directory
  chmod 700 "$dir" || die helper-directory
done
program="$base/bin/pi-helper"
for path in "$program" "$install_tmp" "$pidfile" "$pid_tmp" "$log"; do
  [ ! -L "$path" ] || die unsafe-helper-state
  [ ! -e "$path" ] || [ -f "$path" ] || die unsafe-helper-state
done
chmod 750 "$stage" || die helper-permissions
mv -f "$stage" "$install_tmp" || die helper-install
mv -f "$install_tmp" "$program" || die helper-install
helper_pid=""
if [ -f "$pidfile" ]; then
  helper_pid=$(cat "$pidfile")
  case "$helper_pid" in ''|*[!0-9]*|0) die invalid-helper-pid ;; esac
fi
if [ -n "$helper_pid" ] && kill -0 "$helper_pid" 2>/dev/null; then
  command_line=$(ps -p "$helper_pid" -o args= 2>/dev/null) || die helper-process-unreadable
  case "$command_line" in *"$program"*" serve "*"$base"*) ;; *) die helper-pid-mismatch ;; esac
  ready=$(grep -m1 '^PI_HELPER_READY ' "$log" 2>/dev/null || true)
  running_version=$(printf '%s\\n' "$ready" | sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p')
  if [ "$running_version" = ${version} ]; then
    token=$(cat "$base/token") || die token-unavailable
    case "$token" in *[!a-f0-9]*|'') die invalid-token ;; esac
    [ "$(printf "%s" "$token" | wc -c)" -eq 64 ] || die invalid-token
    printf '%s\\n' "$ready"
    printf 'PI_HELPER_TOKEN %s\\n' "$token"
    exit 0
  fi
  kill "$helper_pid" 2>/dev/null || die helper-stop
  stopped=0
  while [ "$stopped" -lt 10 ] && kill -0 "$helper_pid" 2>/dev/null; do
    sleep 1
    stopped=$((stopped + 1))
  done
  kill -0 "$helper_pid" 2>/dev/null && die helper-stop-timeout
fi
: > "$log"
nohup "$program" serve --root "$base" --port 0 >"$log" 2>&1 </dev/null 9>&- &
helper_pid=$!

printf '%s\\n' "$helper_pid" > "$pid_tmp"
chmod 600 "$pid_tmp"
mv -f "$pid_tmp" "$pidfile"
waited=0
while [ "$waited" -lt ${timeout} ]; do
  kill -0 "$helper_pid" 2>/dev/null || die helper-exited
  ready=$(grep -m1 '^PI_HELPER_READY ' "$log" 2>/dev/null || true)
  if [ -n "$ready" ]; then
    token=$(cat "$base/token") || die token-unavailable
    case "$token" in *[!a-f0-9]*|'') die invalid-token ;; esac
    [ "$(printf "%s" "$token" | wc -c)" -eq 64 ] || die invalid-token
    printf '%s\\n' "$ready"
    printf 'PI_HELPER_TOKEN %s\\n' "$token"
    exit 0
  fi
  sleep 1
  waited=$((waited + 1))
done
die ready-timeout
`;
}

export async function deployBundledHelper(options: HelperBootstrapOptions): Promise<HelperReady> {
  const { transport, artifact, desktopVersion } = options;
  const readyTimeoutSeconds = options.readyTimeoutSeconds ?? DEFAULT_READY_TIMEOUT_SECONDS;
  if (!safeToken(artifact.manifest.sha256) || artifact.manifest.version !== desktopVersion
      || !safeVersion(desktopVersion)) {
    throw fail("The bundled helper manifest does not match this Desktop release", "HELPER_DEPLOY_FAILED");
  }
  const execWithFile = transport.execWithFile;
  if (!execWithFile) {
    throw fail("The SSH transport cannot upload the bundled helper", "HELPER_DEPLOY_FAILED");
  }
  const stageName = `.upload.${randomUUID().replaceAll("-", "")}`;
  const script = buildHelperBootstrapScript({
    digest: artifact.manifest.sha256,
    version: desktopVersion,
    stageName,
    readyTimeoutSeconds,
  });
  const command = `sh -c ${shellQuote(script)}`;
  let result: Awaited<ReturnType<typeof execWithFile>>;
  try {
    result = await execWithFile(command, artifact.path, {
      timeoutMs: (readyTimeoutSeconds + 60) * 1000,
      maxOutputBytes: 16 * 1024,
    });
  } catch {
    throw fail("The bundled helper could not be uploaded or started", "HELPER_DEPLOY_FAILED");
  }
  if (result.code !== 0) {
    throw fail("The bundled helper could not be uploaded or started", "HELPER_DEPLOY_FAILED");
  }
  return parseHelperReady(result.stdout, desktopVersion);
}


