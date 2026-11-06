#!/bin/sh
# The release archive checksum authenticates this installer and SHA256SUMS.
# File checksums protect staged bytes; no system Node or service is needed.
set -eu
umask 077
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
if command -v sha256sum >/dev/null 2>&1; then
  hash() { sha256sum "$1"; }
  check() { sha256sum -c SHA256SUMS; }
elif command -v shasum >/dev/null 2>&1; then
  hash() { shasum -a 256 "$1"; }
  check() { shasum -a 256 -c SHA256SUMS; }
else
  echo 'SHA256 verifier missing (sha256sum or shasum required)' >&2
  exit 1
fi
verify() (
  # Conditional callers suppress shell errexit, so propagate every failed check.
  cd "$1" || return 1
  [ -f SHA256SUMS ] && [ ! -L SHA256SUMS ] || return 1
  # No absolute/traversal/escaped names, duplicate records, or special files.
  awk '
    length($1) != 64 || $1 ~ /[^0-9a-f]/ { exit 1 }
    NF != 2 || $2 !~ /^[A-Za-z0-9_.\/@+-]+$/ { exit 1 }
    $2 ~ /^\// || $2 ~ /(^|\/)\.\.?($|\/)/ || $2 ~ /\/\// { exit 1 }
    $2 == "SHA256SUMS" || seen[$2]++ { exit 1 }
    END { if (NR == 0) exit 1 }
  ' SHA256SUMS || return 1
  special_files=$(find . ! -type f ! -type d -print) || return 1
  [ -z "$special_files" ] || return 1
  [ "$(find . -type f | wc -l | tr -d ' ')" = "$(($(wc -l < SHA256SUMS) + 1))" ] || return 1
  check || return 1
  for executable in bin/node bin/pi-host bin/pi-desktop-host-core install.sh; do
    [ -x "$executable" ] || return 1
  done
  [ -f pi-host.js ] || return 1
)

# install   stage + atomically switch current (default, unchanged contract)
# --stage   stage only, print PI_HOST_STAGED and leave current untouched
# --activate <dir>          switch current to a staged version under both locks
# --activate-locked <dir>   same switch when the caller already holds .deploy.lock
mode=install
activation_target=
case "${1:-}" in
  --verify)
    [ "$#" -eq 1 ] || { echo 'Unexpected --verify argument' >&2; exit 2; }
    verify "$source_dir"
    exit 0
    ;;
  --stage)
    [ "$#" -eq 1 ] || { echo 'Unexpected --stage argument' >&2; exit 2; }
    mode=stage
    ;;
  --activate|--activate-locked)
    [ "$#" -eq 2 ] || { echo "$1 requires one staged version directory" >&2; exit 2; }
    mode=${1#--}
    activation_target=$2
    ;;
  '') ;;
  *) echo "Unknown install option: $1" >&2; exit 2 ;;
esac

root=${PI_HOST_INSTALL_DIR:-$HOME/.pi-desktop/pi-host}
mkdir -p "$root"
root=$(CDPATH= cd -- "$root" && pwd -P)

stage=
operation=
install_lock=
directory_lock=
cleanup() {
  [ -z "$stage" ] || rm -rf "$stage"
  [ -z "$operation" ] || rm -rf "$operation"
  [ -z "$install_lock" ] || rmdir "$install_lock" 2>/dev/null || true
  [ -z "$directory_lock" ] || rmdir "$directory_lock" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# Lock order everywhere: deployment lock, then install lock. `--stage` publishes
# bytes only and `--activate-locked` runs under a caller that already holds the
# deployment lock. A legacy one-shot install takes that lock only when a managed
# host has created it, so a fresh or test-only root keeps its released layout.
needs_deploy_lock=0
if [ "$mode" = activate ]; then
  needs_deploy_lock=1
elif [ "$mode" = install ] && { [ -e "$root/.deploy.lock" ] || [ -d "$root/.deploy-lock" ]; }; then
  needs_deploy_lock=1
fi
if [ "$needs_deploy_lock" = 1 ]; then
  if [ "$(uname -s)" = Linux ]; then
    command -v flock >/dev/null 2>&1 || { echo 'flock is required on Linux' >&2; exit 1; }
    exec 9>"$root/.deploy.lock"
    flock -w 120 9 || { echo 'Another deployment is active' >&2; exit 1; }
  else
    directory_lock="$root/.deploy-lock"
    mkdir "$directory_lock" || { echo 'Another deployment is active' >&2; exit 1; }
  fi
fi
if [ "$(uname -s)" = Linux ]; then
  command -v flock >/dev/null 2>&1 || { echo 'flock is required on Linux' >&2; exit 1; }
  exec 8>"$root/.install.lock"
  flock -w 120 8 || { echo 'Another install is active' >&2; exit 1; }
else
  install_lock="$root/.install-lock"
  mkdir "$install_lock" || { echo 'Another install is active' >&2; exit 1; }
fi

activate() {
  # Canonicalize the caller-supplied path before the containment check so a
  # relative, dot-segment, or shell-translated spelling cannot look outside.
  candidate=$(CDPATH= cd -- "$1" 2>/dev/null && pwd -P) || { echo 'Staged version is missing or unsafe' >&2; return 1; }
  case "$candidate" in "$root"/sha256-*) ;; *) echo 'Staged version is outside the install root' >&2; return 1 ;; esac
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || { echo 'Staged version is missing or unsafe' >&2; return 1; }
  verify "$candidate"
  address=$(hash "$candidate/SHA256SUMS")
  address=${address%% *}
  version_name=${candidate##*/}
  # A repair directory is a verified immutable sibling of a damaged canonical
  # one; both are addressed by the same manifest digest.
  case "$version_name" in
    "sha256-$address"|"sha256-$address"-repair-*) ;;
    *) echo 'Staged version address mismatch' >&2; return 1 ;;
  esac
  # Refuse a legacy real directory, then rename a symlink atomically. Unlike
  # ln -sfn or portable mv, rename never follows an existing directory symlink.
  [ ! -e "$root/current" ] || [ -L "$root/current" ] || { echo 'Refusing to replace a legacy current directory' >&2; return 1; }
  operation=$(mktemp -d "$root/.activate.XXXXXXXX")
  ln -s "$candidate" "$operation/current"
  NODE_OPTIONS= NODE_PATH= "$candidate/bin/node" --input-type=module -e 'import { renameSync } from "node:fs"; renameSync(process.argv[1], process.argv[2]);' "$operation/current" "$root/current"
  rmdir "$operation"
  operation=
}

if [ "$mode" = activate ] || [ "$mode" = activate-locked ]; then
  activate "$activation_target"
  echo "PI_HOST_ACTIVATED $activation_target"
  exit 0
fi

stage=$(mktemp -d "$root/.stage.XXXXXXXX")
cp -R "$source_dir"/. "$stage"/
verify "$stage"
digest=$(hash "$stage/SHA256SUMS")
digest=${digest%% *}
version="$root/sha256-$digest"
if [ -e "$version" ] || [ -L "$version" ]; then
  if [ -d "$version" ] && [ ! -L "$version" ] && verify "$version" >/dev/null 2>&1 && cmp -s "$stage/SHA256SUMS" "$version/SHA256SUMS"; then
    rm -rf "$stage"
    stage=
  elif [ "$mode" = stage ]; then
    # The canonical address holds damaged or foreign bytes. Never repair it in
    # place and never delete the evidence: publish the verified candidate as an
    # immutable repair sibling and leave the damaged directory untouched. Only
    # the transactional `--stage` path does this; a plain install still refuses.
    version=
    for candidate in "$root/sha256-$digest"-repair-*; do
      [ -d "$candidate" ] && [ ! -L "$candidate" ] || continue
      if verify "$candidate" >/dev/null 2>&1 && cmp -s "$stage/SHA256SUMS" "$candidate/SHA256SUMS"; then
        version=$candidate
        break
      fi
    done
    if [ -z "$version" ]; then
      nonce=$(NODE_OPTIONS= NODE_PATH= "$stage/bin/node" -e 'process.stdout.write(require("node:crypto").randomBytes(8).toString("hex"))') || { echo 'Repair nonce generation failed' >&2; exit 1; }
      case "$nonce" in *[!a-f0-9]*|'') echo 'Repair nonce generation failed' >&2; exit 1 ;; esac
      version="$root/sha256-$digest-repair-$nonce"
      [ ! -e "$version" ] && [ ! -L "$version" ] || { echo 'Repair version already exists' >&2; exit 1; }
      mv "$stage" "$version"
    fi
    # The staging copy is disposable in every repair branch; the verified sibling
    # is either the moved stage or a previously published repair directory.
    [ ! -d "$stage" ] || rm -rf "$stage"
    stage=
  else
    # Released contract for a plain install: a damaged canonical version is an
    # error, existing files and `current` stay untouched.
    [ -d "$version" ] && [ ! -L "$version" ]
    verify "$version"
    cmp "$stage/SHA256SUMS" "$version/SHA256SUMS"
    rm -rf "$stage"
    stage=
  fi
else
  mv "$stage" "$version"
  stage=
fi
if [ "$mode" = stage ]; then
  echo "PI_HOST_STAGED $version"
  exit 0
fi
activate "$version"
echo "PI_HOST_INSTALLED $version"
