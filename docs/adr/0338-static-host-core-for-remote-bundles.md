# ADR 0338: The remote bundle ships a statically linked host-core

- Status: Accepted
- Date: 2026-10-30
- Deciders: PI-Desktop maintainers
- Amends: [ADR 0326](0326-verified-ssh-host-installation.md) decision 4 — the
  native runtime the bundle carries
- Related: [ADR 0292](0292-ssh-remote-host-bootstrap.md) ·
  [03-runtime/07-process-model](../spec/03-runtime/07-process-model.md) ·
  [06-delivery/06-release-runbook](../spec/06-delivery/06-release-runbook.md)

## Context

The Linux `pi-host` bundle carries a Rust `host-core` sidecar. Both release
lanes build it on Ubuntu 22.04, so the binary needs glibc 2.35 or newer, and
`scripts/check-linux-host-glibc.mjs` refuses anything newer. A remote machine is
not the desktop: it is whatever distribution the user already reaches over SSH,
and the bundle is installed there without privileges or a build toolchain.

A remote with an older glibc therefore fails in the least diagnosable place.
Observed on a Kylin V10 container (glibc 2.28, reached over SSH on port 1000):
the bundle downloaded, verified, installed and started; `pi-host` then exited
before printing `PI_HOST_READY`, so the desktop reported
`HOST_BOOTSTRAP_FAILED` with step `host-exited` — "the remote pi-host process
exited before it became ready". The cause stayed on the remote in
`~/.pi-desktop/pi-host/.bootstrap/pi-host.err`:

```
pi-desktop-host-core: /usr/lib64/libm.so.6: version `GLIBC_2.29' not found
{"level":"error","channel":"pi-host","message":"host-core exited unexpectedly"}
Error: write EPIPE
```

The host never reached the version handshake, and nothing in the desktop's own
error path named glibc.

## Decision

1. The Linux `pi-host` bundle ships a host-core built for
   `x86_64-unknown-linux-musl` / `aarch64-unknown-linux-musl` and statically
   linked (`-C target-feature=+crt-static`). `.cargo/config.toml` pins the
   linker for both targets, so the build stays one `cargo build --target` call.
2. A dedicated release job (`host-core-musl`) builds both architectures on
   native runners and uploads the binary; `pi-host-bundle` consumes that
   artifact through `bundle.mjs --host-core` and no longer compiles Rust.
3. `scripts/check-linux-host-static.mjs` fails a binary that `file(1)` calls
   dynamically linked, that `readelf -d` reports a dynamic section for, or that
  imports any `GLIBC_*` symbol. The release lane, the path-filtered
  `Host-core static build` workflow and a musl-only smoke run all execute it,
  so a dynamic build fails on the change that introduces it.
4. The desktop's own Linux package keeps the glibc 2.35 build. Its floor is
   Electron's, its JIT and GPU paths cannot live in a static musl process, and
   its local host-core is already bound to that floor.

## Consequences

- host-core on a remote machine no longer depends on glibc at all. The bundled
  Node runtime still does (Node 24 needs glibc 2.28 or newer), so a musl-only
  distribution such as Alpine remains an unsupported remote target; the
  reachable floor becomes Node's, not 2.35, and a machine that passes the Node
  floor now runs host-core too.
- A static binary cannot `dlopen`. host-core loads no plugin, no SQLite
  extension and no NSS module, so nothing in its current surface depends on the
  dynamic loader. Name lookups use the local files only, which matters solely
  for users whose accounts live in a network directory.
- The lanes gain a required `musl-tools` install on Ubuntu runners and roughly
  four minutes of build time; the bundle grows by the static-link size delta.
- A local `cargo build --target *-linux-musl` now needs `musl-gcc`. A plain
  `cargo build` is unaffected and keeps using the host toolchain.
