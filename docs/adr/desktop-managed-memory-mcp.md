# ADR: Desktop-owned managed HTTP MCP for a memory center

- Status: Implemented candidate; architecture A approved for implementation
- Related: [Local Agent and remote workspace tools](local-agent-remote-workspace-tools.md), [User MCP ownership](0056-extension-activation-scope.md), [Remote MCP OAuth](0283-remote-mcp-oauth.md)

## Context

New remote workspaces keep the Agent and MCP dispatch on Desktop. The remote
Host executes the six repository tools, not every tool in the Agent catalog.
A stdio memory bridge has no access to that remote repository and cannot use
`remote-project:<groupId>` as a local cwd. Retrieval and saving plain-text
experience need only the center API, not remote repository access.

Existing HTTP MCP already provides initialization, discovery and calls, but
ordinary headers are portable plaintext configuration. The center uses static
Bearer authentication, not OAuth, and private CAs need connection-scoped trust.
A plugin cannot bypass secret-setting or MCP mutation restrictions through its
ordinary settings or `desktop.control` gateway.

## Decision

Reuse the native MCP settings page and editor. A Memory center action opens the
existing `superclaude-memory` record; only an explicit Save migrates stdio to
HTTP. Show the Desktop connection location separately from project activation
and exact PI-identity to center-project bindings.

Host Core generates `secret:mcp:bearer:<UUID>` references. Native Main removes
transient `bearerToken` before registry RPC and stores an encrypted versioned
`{version:1, endpoint, token}` secret. Renderer receives existence metadata, not
a runtime read channel. Changing the exact endpoint requires credential re-entry;
missing, corrupt, wrong-namespace or endpoint-mismatched credentials fail closed.
The plugin cannot select a reference or gain general secret permissions.

Public CA PEM is bounded to 64 KiB and 16 certificates. Main validates it and
appends it to default trust only for the owning HTTPS connection. Verification
stays enabled; no process-global roots or TLS environment flags are changed.
Managed Bearer/CA connections reject redirects, including same-origin path
redirects. Known credential values are redacted from results, parser/transport
errors and audit messages before model context or diagnostic surfaces.

Connections and asynchronous work have per-server invalidation generations.
Retained names after credential rotation are routing hints only: reconnect and
revalidate the catalog before every dispatch. An obsolete secret read, handshake
or authorization probe cannot resurrect or discard a replacement connection.
Never replay a failed `tools/call`; a write may already have happened.

Bindings use exact PI identities, including opaque remote project IDs, and an
existing center ID. They supply defaults and reject conflicting explicit memory
arguments; they are not authorization. Activation scope and center grants stay
authoritative. Graph paths are verified using repository tools on the actual
local/remote workspace, never joined to Desktop's home or the opaque identity.

The center's separately implemented `/mcp` endpoint shares authentication,
MemoryService and storage with REST. Its stateless JSON Streamable HTTP contract
provides initialize, notifications, ping and the eight center tools; the legacy
stdio diagnostic is not a ninth HTTP tool.

## Alternatives

- Require every SSH Host to install a memory CLI and hold a token: rejected as
  the default. An independent CI/remote client is a separately scoped option.
- Use ordinary Authorization headers for new credentials: legacy compatibility
  remains, but the managed path avoids plaintext synchronization and export.
- Treat static Bearer as OAuth: rejected; existing OAuth behavior is retained.
- Disable TLS or replace global roots: rejected; trust is scoped and validated.
- Change remote tool allowlists or Plan/Goal visibility: not needed and rejected
  from this phase. Old headless remote-agent histories/catalogs remain unchanged.

## Consequences and migration

Existing local stdio and OAuth remain available. Plugin reload must preserve an
explicit HTTP record without appending stdio fields. No automatic migration,
indexing, memory upload, credential forwarding, session rewrite or source upload
is performed. Transfer, including collision rename, preserves the opaque
reference. Explicit clear/delete cleans its secret; failed removal retains the
credential rather than leaving a saved record without its owned secret.

Managed tokens are device-local; portable configuration does not read them and
another device must configure its own credential. The remote collector/publisher
is a later phase, contingent on a real target and verified CBM installation and
calling contract; this change does not implement a new parser.

Validation combines editor interaction-model tests, real temporary HTTPS
certificates, deterministic async races, a real native Host lifecycle and a
cross-engine PI-client/Python-center test with isolated SQLite and synthetic
authorization. Actual installed-GUI, physical SSH/Linux, real-center deployment
and explicitly authorized live writes remain independent qualification gates.
