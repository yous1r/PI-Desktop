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
   `x86_64-unknown-linux-musl` / `aarch64-unknown-linux-musl`. No linker or
   rustflags entry is configured for those targets: rustc's bundled
   self-contained musl already links them statically, as a static PIE on x64 and
   a plain static executable on arm64. `musl-tools` supplies `musl-gcc` to build
   mimalloc's C source; it is set as `CC`, not the Rust linker.
   Overriding the Rust linker to the system `musl-gcc` was measured to produce
   a binary that reports `statically linked` but segfaults inside libc startup
   before `main`, so that override is deliberately absent.
2. A dedicated release job (`host-core-musl`) builds both architectures on
   native runners and uploads the binary; `pi-host-bundle` consumes that
   artifact through `bundle.mjs --host-core` and no longer compiles Rust.
3. `scripts/check-linux-host-static.mjs` fails a binary that `file(1)` calls
   dynamically linked or that names an interpreter, that `readelf -d` shows
   resolving a shared library, or that imports any `GLIBC_*` symbol. Because a
   static report alone did not catch the broken link, every lane that ships the
   binary also runs `app.handshake` against it and requires a JSON-RPC reply.
4. The desktop's own Linux package keeps the glibc 2.35 build. Its floor is
   Electron's, its JIT and GPU paths cannot live in a static musl process, and
   its local host-core is already bound to that floor.
5. Remote Node and terminal addons retain the glibc 2.28 baseline. This is not
   a fully musl Node distribution: a musl addon cannot be loaded into the glibc
   Node executable. Build `node-pty` in native manylinux_2_28 x64/arm64 images
   and pass that isolated package to `bundle.mjs --pty`; never ship the runner's
   Ubuntu-built addon by accident. Static host-core remains mandatory on every
   subsequent release.
6. Before archiving, `check-linux-pi-host-runtime.mjs` reruns the static host-core
   gate, checks imported Node/PTY symbol versions against glibc 2.28 and the
   corresponding C++ ABI, and runs a real shell through the bundled PTY. A
   version handshake or project browse alone cannot qualify terminal support.

## Consequences

- host-core on a remote machine no longer depends on glibc at all. Bundled
  Node and `node-pty` require glibc 2.28 or newer; a musl-only distribution such
  as Alpine remains unsupported. The floor applies to the complete remote
  runtime, including terminals, rather than only to Node and host-core.
- A static binary cannot `dlopen`. host-core loads no plugin, no SQLite
  extension and no NSS module, so nothing in its current surface depends on the
  dynamic loader. Name lookups use the local files only, which matters solely
  for users whose accounts live in a network directory.
- The musl lanes install `musl-tools` for mimalloc's C compilation and set
  `CC=musl-gcc`; Rust still uses its bundled self-contained musl linker. The
  bundle grows by the static-link size delta.
- A static binary is a separate artifact from the desktop's glibc one, so the
  two are built in different lanes from the same commit.
