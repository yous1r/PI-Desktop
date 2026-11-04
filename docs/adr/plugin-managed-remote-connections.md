# ADR: Host-managed plugin remote connections

- Status: Accepted for implementation by the approved ai-memory plan
- Scope: Plugin SDK, native settings, network and credential boundaries

## Context

Plugin settings deliberately do not support secrets. A memory plugin needs authenticated HTTP without copying tokens into its bundle, agent prompts, local queue, or ordinary settings. Existing MCP credentials must not be exported to arbitrary plugins.

## Decision

Native Host settings create connections owned by one plugin. Store the private connection record through the existing Rust Host secret store; no new SQLite owner or database schema is introduced. Plugins receive connection IDs and sanitized metadata only. The Host injects authorization for requests to exact user-approved relative routes and methods beneath a normalized base URL.

Require a dedicated `net.connection` grant, plugin ownership, a current connection revision, bounded request/response sizes and deadlines, cancellation, and ordinary certificate verification. Reject redirects, credentials in URLs, path traversal, forwarded/auth/cookie header overrides, and non-loopback HTTP without explicit opt-in. A private CA is scoped to that connection. Origin/base-path changes require credential re-entry; all changes increment the revision. No generic getSecret API is added.

Connection configuration IPC is native-only and excluded from the agent desktop-control catalog. Existing user MCP configurations stay unchanged. Revision changes and removal abort active requests. Plugin unload aborts requests but retains configuration; native removal deletes this connection only, never remote data.

Uninstall ends the credential authorization: after unload, delete the plugin's encrypted connection record before removing its registration. A cleanup failure leaves uninstall incomplete and visible. Reinstalling a manifest with the same ID must not inherit old credentials; disable/reload remain non-destructive. This follows the existing uninstall lifetime of plugin-private data and does not contact or delete remote memory.

## Alternatives

Secret fields in plugin settings would expose credentials through existing read/sync paths. A raw bearer file duplicates security handling. An ai-memory-specific Host client would couple core releases to upstream changes. An opaque, generic connection provides the needed boundary without those dependencies.

## Consequences

The owning plugin may transmit authorized content to the configured destination, so the install grant and connection UI make this explicit. A malicious configured server can echo data it receives: the Host redacts exact credential material from returned headers/bodies and exposes bounded transport errors. Private CA trust never replaces global roots or disables verification. The existing secret store's encryption/backups retain their current guarantees and limitations.
