# ADR: User MCP connections retain endpoint-scoped CA trust

- Status: Implemented candidate
- Scope: User MCP configuration, TLS transport and independent plugin ownership

## Context

The 0.22.1-beta.6 user MCP editor and configuration record do not expose or
retain the `caCertificate` field introduced in the earlier memory-HTTP
candidate. Plugin-managed connections have a private CA setting, but an
ordinary user HTTP MCP connection does not use that connection API. Its TLS
handshake therefore rejects a private authority that is absent from platform
trust. Moving memory integrations into plugins does not replace generic MCP
configuration.

## Decision

Restore optional public CA PEM on user MCP records and in the HTTP editor,
with the same `caCertificate` spelling. Omitted input preserves the value;
null or empty input clears it. Rust persists it in the existing MCP JSON
configuration and carries it through transfers. No SQLite schema changes or
credential migration are required. Older records retain default trust.

The shared MCP client validates public CA bundles and creates per-request
HTTPS trust additive to default and system roots. Certificate chain, expiry
and hostname verification remain enabled. Trust is restricted to the saved
HTTPS origin; cross-origin redirects are refused when a custom CA is active.
The Desktop caller supplies its existing configured proxy/PAC/bypass tunnel.
Streaming responses, cancellation and response limits remain owned by the MCP
transport. Changing or clearing the CA closes the old client.

`local.ai-memory` is developed in the independent `PI-AI-Memory` repository.
Its source, upstream adapters, domain tests, compatibility CI and package
workflow leave Desktop. Generic extension-owner and managed-connection APIs
and their host tests remain in Desktop. Installing the plugin stays explicit;
existing plugin identity, user configuration and remote data do not change.

## Alternatives

Installing a CA in the OS store remains possible, but broadens trust beyond
the selected MCP endpoint. Disabling TLS verification is not acceptable.
Requiring a memory-specific plugin for generic MCP trust would couple separate
contracts. Reusing the buffered managed-connection HTTP adapter would regress
MCP servers that keep SSE responses open, so the shared MCP transport retains
a streaming adapter.

## Consequences

A public CA is portable configuration, not a private key or bearer credential.
The native editor can display it, and saved configuration synchronization follows
existing MCP-file semantics. A downgrade to a version without this field can
ignore it; editing in that version may discard it. No running user application
or global certificate store is modified by this implementation.
