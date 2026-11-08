# Vendored File Manager: workspace execution hotfix

This directory is the actual plugin loaded and packaged by Desktop. It now
contains the remote-read consumer required by issue #1711. It follows the
existing Desktop hotfix convention introduced by commit
`73d8932ade73471277b9a51afac90ee9867d97c8`, rather than representing an
unpublished plugin contribution as an official upstream release.

## Source and distribution provenance

| Field | Value |
| --- | --- |
| Upstream repository | https://github.com/Tioit-Wang/pi-desktop-plugin-file-manager |
| Released reference tag | `v0.9.0` |
| Released reference commit | `92ccff9b7c1102d1664915c44ae1e5f3bb5c56a6` |
| Integration source | https://github.com/Seraph-x/pi-desktop-plugin-file-manager/tree/f47ce21fab3c59f3f4b94d30f3e3a0c8124447e1 |
| Integration commit | `f47ce21fab3c59f3f4b94d30f3e3a0c8124447e1` |
| Companion upstream proposal | https://github.com/Tioit-Wang/pi-desktop-plugin-file-manager/pull/5 |
| Bundled version | `0.9.1-pi.2` — Desktop workspace hotfix, not an upstream release |
| License | MIT; preserve the bundled `LICENSE` and PDF.js notices |
| Historical 0.9.1-pi.1 runtime (not this candidate) | `pi.file-manager-0.9.1-pi.1.piplug`, 6921923 bytes, SHA-256 `e8b6041cb5d3d4eab2b68a1e7fa61a8c7089235d9918f4a418541bd60cd109b3` |
| Marketplace publication | Not published; no marketplace artifact or accepted upstream tag is claimed for this hotfix |

The released reference tag is retained unchanged. The integration source is a
separate, immutable contribution commit. Its remote consumer uses public
`pi.fs.list` / `pi.fs.readPreview`, not local filesystem reads for opaque remote
identities. That legacy gateway remains read-only. The new workspace companion runs the native engine beside the workspace files.

The hotfix is strictly newer than both the previous bundled `0.5.3-pi.1` and
marketplace `0.9.0`, so `sync_builtin` can repair either installation. A future
stable upstream `0.9.1` is strictly newer and can replace it normally. The
source candidate version `0.9.1` is not reused as a supposedly released version.

## Build inputs

The recorded build used Node 24.13.0, Vite 5.4.21, TypeScript 5.9.3,
React 18.3.1 and PDF.js 6.4.299, reusing the existing plugin dependency tree.
The exact source tree and its dependency lockfiles are pinned by the integration
commit above. Native file-watch verification ran outside the filesystem sandbox
so the synthetic filesystem events could reach Node.

## Local changes from the pinned integration source

1. Apply `patches/file-manager-search-theme.patch` to
   `views-src/src/styles/index.css`, then rebuild the production view. This
   retains the theme-token search-control repair already shipped in Desktop
   by #1861 and proposed upstream in plugin PR #6. No minified JavaScript is
   edited by hand. The patch changes only CodeMirror search fields/buttons.
2. Set manifest version to `0.9.1-pi.1`, add `license: MIT`, and prefix its
   changelog with the Desktop hotfix description. Keep all other manifest
   declarations, permissions and safety notes from the integration source.
3. Keep Desktop's MIT `LICENSE` and `package.json` CommonJS marker. The latter
   scopes Node's module interpretation to this plugin; other bundled plugins
   retain their own module format.

`remote-workspace.js`, `README.md`, `CHANGELOG.md`, `views/index.html`
and `views/assets/pdfjs-LICENSES.txt` are byte-identical to the pinned integration
commit. The manifest and `main.js` now carry the workspace patch, and `desktop.js` is a new Desktop entry. The generated view retains the previous hotfix bytes. The historical pack above predates this patch.
QA dependencies, tests and `views-src/` are not included in the shipped plugin.
The pinned changelog contains trailing spaces; its narrow `.gitattributes`
exception preserves those upstream bytes rather than silently rewriting them.

## Workspace patch (0.9.1-pi.2)

- Desktop `desktop.js` forwards project requests using public `workspace.invoke`;
  `main.js` exposes `onWorkspaceInvoke` and runs locally or on the admitted SSH Host.
- Local scratch/attachment reads and saves stay in the Desktop entry, with a
  short-lived single-file grant supplied by the host-owned view. Workspace
  entries reject remote `external: true` requests. Native Node code is trusted
  with the account's OS privileges; SDK gates are not an OS sandbox.
- Remote graphical editor detection/launch is disabled. Default-app actions
  download an explicit copy; HTML actions use bounded Host-authorized reads.
- Linux/macOS path matching preserves case. External attachments skip project
  Git lookup. New/create/rename filename validation and the independent
  `entryFromStat` helper repair an existing malformed function in the pinned
  integration source (`rel` was undefined in `assertValidName`).
- No generated JavaScript was edited or rebuilt for this patch. If
  `workspace.isAvailable()` is false (old Host or refused native approval), the
  Desktop entry keeps the scoped read-only consumer and does not prompt again.
- New regression: `workspace-plugin-files-git.test.mjs` executes this actual
  bundle through the broker for local and remote service transports, including
  editing/conflicts, create/rename/search/delete, local attachment isolation,
  HTML/download/reveal, and disconnected-write refusal.

The 0.9.1-pi.2 candidate has not been published to the marketplace. Full Linux
SSH and mounted Electron acceptance remain release gates. Reproduce the
workspace patch from this Desktop task tree before checking or packing; the
old three-edit recipe below describes only the historical 0.9.1-pi.1 hotfix.

## Shipped checksums (SHA-256)

Every runtime file, including the new remote helper and PDF license notices,
is recorded here. `UPSTREAM.md` is the provenance record, not a runtime input.

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `CHANGELOG.md` | 34520 | `b7a3c06c07b2dbe5ce79577bbc6c6a53ffa00324bd64a27d0d5634493dec48b4` |
| `LICENSE` | 1067 | `ebaec3ae096498a39f6b86e3ac8017e39818fb5aaff80b452349f94bc275ec0d` |
| `README.md` | 38470 | `4ecf6e3afa2051b59b479907c485d156caca54ef6d1f4e3c410805807942a268` |
| `desktop.js` | 827 | `702e6a3f66bc0003c76d9323a3538440ff7b3a2b754f1dc78f8911b2dded66b2` |
| `main.js` | 126368 | `1bdd1a78ecfdd14adcc056b6ce5da60a3b4d721a0c1afb8ce0ce79c783bc9edc` |
| `manifest.json` | 41327 | `ff6c563b5186a03473bed6544dbfdf94069eb07d8182063928ee9d83bc0b7f3f` |
| `package.json` | 25 | `8005a3491db7d92f36ac66369861589f9c47123d3a7c71e643fc2c06168cd45a` |
| `remote-workspace.js` | 3757 | `931a579801fd4b334c3d96231aafc7ff52e0c03e7baebbabaf00b4c5e17cc366` |
| `views/assets/index.js` | 6616929 | `0e415df8a14b4414a53ce3e2add8bb2cc155c67de21a43582a4dc217ae1a85e0` |
| `views/assets/pdfjs-LICENSES.txt` | 61789 | `a8b04e2e9022721482079ee5c85b9f05ae129e6a2cfd59ea67f2629a3fc23640` |
| `views/index.html` | 345 | `771fd3d8afdea7fca75ed1f1918c1ce93ad1c87babdb321cfb85e910465cd2c1` |

## Reproducing or updating this hotfix

1. Export the exact integration commit above as LF blobs. Reuse the plugin's
   compatible build dependencies; do not copy QA dependencies into the runtime.
2. Apply the checked-in theme patch from the Desktop checkout with `git apply`.
3. Run the source typecheck, every verification script (including native file
   watching), and `vite build` in `views-src`.
4. Apply the three documented manifest edits, then run
   `node scripts/prepare-package.mjs` and the official `pi-plugin check` and
   `pi-plugin pack` against `dist/runtime`. Compare unpacked artifact files to
   the installed resource files byte for byte; retain both local metadata files.
5. Refresh this provenance record and all runtime checksums. Run
   `bundled-plugins.test.mjs` and `bundled-remote-file-manager.test.mjs`, then
   `node scripts/e2e-remote-file-manager.mjs` **without** a directory argument.
   The default journey must list and read real remote fixture files through the
   actual bundled process/view, Desktop broker, RACP and Host filesystem.
6. Run the bundled light/dark editor-search journey and local edit/save controls.
   Validate the final candidate after incorporating current `origin/main`.
7. When the companion change is accepted and officially published, replace the
   integration pin with that real tag/commit and marketplace provenance; preserve
   the search-theme fix if that release does not yet contain it. Do not rewrite
   an existing upstream tag or label the local artifact as a marketplace release.

## Desktop Git deadline repair (#1731)

The Git timeout rejects immediately and destroys its captured output streams,
instead of waiting for a `close` event that inherited child pipes may delay.
The existing best-effort snapshot path returns unavailable Git metadata while
preserving directory listing and preview. No upstream release is claimed.
