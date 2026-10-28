# Bundled remote helper artifacts

Release packaging places two Linux helper binaries and their generated manifests here:

- `pi-helper-linux-x64` — `x86_64-unknown-linux-musl`
- `pi-helper-linux-arm64` — `aarch64-unknown-linux-musl`

The release workflow produces these files from native Linux runners, verifies their architecture, and downloads them into this directory before packaging the Desktop app. The manifests pin the Desktop version, target, filename and SHA-256 digest.

A source checkout intentionally contains no generated binaries. A locally packaged Desktop therefore has no usable mirror helper until the bundle build has produced both artifacts.
