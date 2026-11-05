# ADR 0340: Execute native plugin backends beside the workspace

- Status: Implemented candidate; SSH release acceptance pending
- Date: 2026-11-04
- Deciders: PI-Desktop maintainers
- Related: [ADR 0008](0008-plugin-runtime-isolation-target.md),
  [ADR 0292](0292-ssh-remote-host-bootstrap.md),
  [workspace execution contract](../spec/07-plugins/18-workspace-execution.md)

## Context

Git and the vendored File Manager use native Node filesystem and child-process
APIs. Returning an SSH path from `workspace.get` cannot move those operations to
another computer. The local Agent and model credentials must remain local, and
workspace terminals cannot require creation of a remote Agent session. Retained
views and delayed callbacks also cannot choose their target from current selection.

## Decision

Add optional manifest backend placement and reuse the paired SSH/RACP/pi-host
connection. A workspace main runs beside the project. A Desktop main can declare
an explicit companion, reached by `workspace.invoke`. Views remain on Desktop.
One shared Host Runtime runner and MCP client serve both locations. The Broker
owns captured workspace/session identity, permission checks and Desktop callbacks;
Rust retains durable native-execution consent by Host and package digest.

Expose structured process and PTY services independently of Agent sessions. Route
trusted extension workspace exec to those services. Scope tool discovery and
execution to the originating workspace; keep model/device/renderer integrations
on a Desktop main. Resident services follow main placement and do not duplicate
inside a companion. MCP placement is explicit when it differs from main.

Resource opening is explicit: download a local copy with no writeback, reveal in
the application, bounded HTML resource reads, or a workspace-bound localhost SSH
forward. Local attachments stay on Desktop under host-issued single-file grants.
No plugin-specific SSH implementation, directory mirror, global fs monkey-patch,
argv-to-shell-string conversion, local fallback or mutation replay is introduced.

## Consequences

Portable native-JS plugins can use the user's remote Git/files/tools without
moving model credentials. Native remote code still has the SSH user's privileges;
SDK checks are not an OS sandbox. Package transfer, callbacks, output and caches
are bounded, and disconnect/revocation has a defined owner cleanup path.

Old manifests remain Desktop-only, old File Manager hosts keep the read-only
remote consumer, and missing new capabilities fail explicitly. Arbitrary native
addons and node_modules transfer are deliberately unsupported. Target-package
selection/installation, real Linux x64/arm64 SSH acceptance and mounted Desktop
acceptance remain prerequisites to broad release; Windows loopback tests do not
establish those results.

The new contract and migration examples live in spec 18. It amends the earlier
Desktop-only backend and read-only remote plugin assumptions without changing
local Agent persistence or the provider-secret owner.
