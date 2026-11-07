# Remote terminal compatibility validation

## Confirmed contract and failure

Future Linux remote bundles keep host-core statically linked with musl. Node
and `node-pty` remain compatible with glibc 2.28 or newer. This is not a fully
musl Node distribution; system glibc and sshd are not changed by the repair.

On the authorized `paas` Host, the official 0.22.2 bundle's Node and static
host-core worked, but `node-pty` imported GLIBC_2.32/GLIBC_2.34 while the system
provides glibc 2.28. The Host therefore advertised no workspace terminal. The
Desktop's generic "Upgrade pi-host for workspace terminal support" did not
explain this ABI failure. Ordinary SSH and project browsing remained healthy.

## Immediate repair and real user path

The retained 0.22.1-beta.6 installation had node-pty 1.1.0 with identical runtime
JavaScript and a compatible native addon. Its SHA-256 was:

`f87d7fc2895837f48be1dd4894419232e0bf2b12b0b653227ca26d879ac4744c`

The addon loaded under the current bundled Node 24.22.2 and passed a real PTY
shell test on the glibc 2.28 machine. A separate 0.22.2 installation directory
was staged with only that native addon replaced and its manifest recomputed.
The official archive/cache and old installed directories were retained.

The Host remained busy after the initial idle-window request. Only after the
user explicitly authorized stopping current connections/work, the exact known
Host process received SIGTERM. The verified repair directory was activated and
the Host restarted on its previous port without new pairing. Identity and
credential files were compared byte-for-byte across the operation. No sshd or
system-library changes were made.

A separate Desktop validation process then read the existing encrypted pairing
records and exercised real SSH, RACP and PTY operations on all three Hosts:

| Host | Directory | Create / input / output / resize / replay / close |
| --- | --- | --- |
| dev | `/root/Packages/scan-port` | Passed |
| paas-v020 | `/root/uniadmin_plus` | Passed |
| dev-code | `/root/uniadmin_plus-v020.002.010` | Passed |

Only fixed output markers and `pwd` ran; no model/provider request was made.
All test terminals closed and copied encryption metadata was removed afterward.
The repair keeps version 0.22.2, static musl host-core and all existing data.

## Regression prevention

- Release x64/arm64 lanes build node-pty from pristine pinned source in native
  manylinux_2_28 containers, using checksum-verified matching Node headers.
- `bundle.mjs --pty` explicitly selects that isolated package and refuses a
  missing or mismatched version before replacing build output.
- `check-linux-pi-host-runtime.mjs` retains the static host-core check, validates
  imported GLIBC/GLIBCXX/CXXABI limits, requires a bundled native module and
  verifies actual shell output. A separate native CI matrix exercises the
  compatible-addon builder before release.
- The new gate was run against real installed binaries: it rejected the
  incompatible official 0.22.2 addon and accepted the compatible installation.
- Unit tests cover ABI ordering, malformed reports, architecture, source
  isolation, header digests, offline container build arguments and lane ordering.

## Limits

The immediate repair is an explicitly identified local compatibility repair,
not a replacement published archive. Reinstalling the old official 0.22.2
archive would restore its incompatible addon. Future published bundles need the
new release workflow. No tag or release publication is performed by this task.
Native builder CI outcomes are reported separately; source/configuration tests
alone are not claimed as a successful container compilation.
