# 17. Owned extension services and managed connections

These additive capabilities support integrations that keep durable work in a resident plugin service. They do not embed any memory-server protocol in Desktop. See [owner-call ADR](../../adr/plugin-agent-extension-owner-calls.md) and [managed-connection ADR](../../adr/plugin-managed-remote-connections.md).

## Capability and compatibility

Plugins must probe `ctx.owner?.version === 1` in an extension callback and await `pi.connections.getCapabilities()` in their plugin process. Desktop 0.22.1-beta.4 and earlier do not provide these capabilities; 0.22.1-beta.5 is the first version that carries them. A version string alone is still insufficient admission, so integrations must probe the capabilities at runtime. Older extensions and embeddings without owner bridge members retain their existing behavior.

## Manifest and owner calls

A plugin with `agent.extension` may add up to 32 unique bounded operations:

```json
{
  "contributes": {
    "agentExtensions": ["agent-extension.mjs"],
    "agentExtensionOperations": [
      { "name": "recall", "readOnly": true },
      { "name": "capture", "readOnly": false }
    ]
  }
}
```

Within an active extension handler, `await ctx.owner.call("recall", payload)` reaches that plugin's `onAgentExtensionCall(operation, payload, context)`. The caller cannot select another plugin, session, project, turn or mode. Main projects the manifest, records outbound runtime launch bindings, verifies the persistent Host session/worktree record, and validates registration and each invocation. Rechecking after awaits rejects stale results. The plugin receives an abort signal; downstream SDK calls belong to the same invocation and expire with it.

Context contains persistent `sessionId`, optional `turnId`, independent `runtimeId`, durable `projectPath`, actual `workspaceRoot`, optional `remoteWorkspace`, mode, optional parent identity and retirement reason. The durable remote-project identity differs from its filesystem path. Each runtime generation owns its initialization state; imported module caching does not preserve that state.

Plan/Goal allow only declared read-only operations. Host-side enforcement is additional to the extension-side check. Payload and result must be serializable JSON, each at most 256 KiB. Calls have a 10-second Host ceiling. Callers can use shorter cancellation deadlines. Completion, Stop, retirement, plugin unload, permission loss and transport closure must not allow descendant calls to continue using expired authority.

The wire routes are `extensions.owner.call`, `.cancel`, `.registerRuntime` and `.retireRuntime`. They use the existing sidecar proxy allowlist and never become arbitrary Rust RPC access. The plugin-process callback runs as `extension.owner` under the existing invocation cancellation mechanism.

## Files inside owner callbacks

`pi.fs.readPreview(relativePath, {workspacePath: context.projectPath})` inside an owner callback resolves against the Host-owned session root, including isolated worktrees and remote workspaces. It requires `fs.read`, `root: "workspace"` and an explicit matching `fs.read.scope`. No fallback to the visible window or local cwd is allowed. Absolute/traversing paths, sensitive paths, application-private paths and scope escapes fail closed. Remote reads use the existing remote Host plugin-file capability and validate its response. Missing remote support is an explicit failure. Session binding, activation and cancellation are checked again after reads. Ordinary panel previews keep their existing workspace-selection behavior.

Owner previews emit the existing `fs.readPreview` audit record with plugin, bounded relative path, success/failure and result kind/size. File bodies never enter that audit record.

## Retirement and shutdown

`runtimeId` is independent of a persisted conversation. Retirement reasons are `reconfigure`, `session-close`, and `app-quit`. Shutdown callbacks have a bounded two-second budget; app quit invokes graceful sidecar shutdown before plugin services and Host persistence stop. Unresponsive callbacks cannot hold the application open. An instance retiring after a model or mode change is not evidence that the user's task completed. Integrations must not automatically create a final handoff on every shutdown.

Resident services started by the Host may issue SDK calls after `service.start`
returns. Their background tasks belong to the loaded plugin's service lifecycle,
not the completed startup RPC. Unload and current permissions still gate every
call. Ordinary panel/tool/owner descendants retain their originating-call expiry.

For extensions declaring owner capability, `agent_end` notification handlers have a two-second total budget. Turn settlement waits for these handlers and status remains busy while they complete, so a subsequent turn/retirement cannot cancel a timely local receipt. Expired callbacks remain cancelled. Extensions without owner capability retain their existing notification timing.

The retiring generation freezes its last admitted turn identity. A replacement launch cannot relabel that final event. During the two-second retirement window each extension may invoke its declared `retire` operation once; other owner operations and repeated terminal calls are rejected. The live Host mode and current plugin grant still apply, including Agent-to-Plan transitions. Unknown Host modes fail closed; legacy `chat` is read-only Plan. An unloaded plugin invalidates old generations; a later idle launch retires the stale runtime before rebuilding it. Active turns are not interrupted merely to reload an extension.

## Idle handoff and original owner activity

The Main owner bridge requires the application's shared admission gate and binds
one original Host object and startup generation. Registration and ordinary calls
fail before Host lookup while admission is closed. Host availability, launch
identity and admission are checked after awaits, before consuming a launch, before
the next RPC or plugin dispatch, and before publishing results. A replacement
Host cannot inherit old authorization, including between idle requests.

`PluginExtensionOwnerBroker.getHandoffActivity()` reports original `operations`
and authorized `runtimes`. Registration work and the original session lookup,
plugin dispatch and result-validation promises remain counted after cancellation,
timeout, generation removal or broker disposal. A cancelled request keeps its ID
and its place in the existing 256-call bound until its original work settles.
These counts describe activity, not execution capacity or native containment.

The existing two-second, single-use declared `retire` operation remains available
through closed admission only for the broker's retiring generation. Current
grants, Plan/Goal restrictions, frozen turn identity and cancellation still apply.
Main records this authorization on the original plugin-process call, outside the
wire payload. Descendant SDK calls require that exact active parent and plugin
installation; ordinary calls and expired descendants gain no admission bypass.
Permanent plugin-runtime shutdown remains sealed.

`AgentSidecar.getExtensionOwnerActivity()` includes original sidecar calls and
current or retiring bridge activity. Replacing or disposing a bridge cannot hide
unfinished work. Completed empty retired records can be compacted; missing or
invalid reporting refuses handoff. Late session disposal closes only its captured
lifecycle and launch, and a stale retirement query cannot dispose a replacement.
Unconfirmed session/shutdown cleanup retains bounded refusal evidence even after
a late reply or original-child exit. The complete Desktop inventory, other
trusted-extension resources and native-family qualification remain separate work.

An ordinary Host restart keeps the existing sidecar transport. Its explicit
`setHost()` rebind revokes old broker generations before changing authority,
retains original pending work/request slots, and marks only sessions with owner
extensions for retirement before their next idle launch. Old runtime IDs remain
rejected; a new runtime registers against a fresh launch. Matching Host/generation
bindings are a no-op, and closed admission refuses a new binding. In-flight
queries retain their original Host identity across this rebind. Sessions without
owner extensions, locale restoration and approved-plan drain order are preserved.

## Managed connection API

`net.connection` grants access to connections configured in the native plugin settings sheet. The user reviews endpoint, plaintext HTTP consent, optional private CA and exact relative route/method pairs there. Native IPC list/save/delete channels are excluded from desktop-control and plugin panel operations. The SDK exposes no save operation or secret getter.

```ts
await pi.connections.getCapabilities(); // { version: 1 }
const connections = await pi.connections.list(); // metadata only
const response = await pi.connections.request({
  connectionId, expectedRevision, requestId,
  path: '/mcp', method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(request), timeoutMs: 1500,
});
await pi.connections.cancel(requestId);
```

Metadata includes ID, owner plugin, label, normalized base URL, revision, credential/CA presence, HTTP consent and route declarations. Responses include status, allowlisted headers, bounded body text and connection revision. Configuration uses the existing encrypted Host secret store; no new SQLite owner, schema or credential format is introduced. Tokens never enter ordinary plugin settings. Undefined credential/CA input preserves a value; empty input clears it. Changing endpoint origin or base path requires credential re-entry. Saves increment revision; stale revisions fail and rotation/removal abort in-flight requests.

Disabling or reloading a plugin aborts its requests and retains connection configuration. Native uninstall first unloads the plugin, then deletes its entire encrypted connection record before deleting the plugin registration. Failed credential cleanup stops uninstall with an observable error. Reinstalling the same plugin ID does not inherit previous credentials. No remote data is deleted.

Only GET/POST methods and exact approved relative paths under the base URL are admitted. Redirects, URL credentials, fragments, traversal and caller-supplied auth/cookie/forwarding headers are refused. Non-loopback HTTP requires explicit consent. TLS verification remains enabled; private CA trust is connection-local and additive to public roots. Both normal requests and private-CA tunnels follow the application's configured direct/system/PAC/custom proxy and bypass routing. Request and response bodies are limited to 1 MiB, requests to 15 seconds, and concurrent requests to 128. The download proxy used by a developer does not become a connection setting.

The Host injects the stored bearer credential only after checking ownership, current grant, revision and destination. Returned text redacts exact credential values and transport failures expose fixed diagnostic codes. Plugins still treat all remote content as untrusted data. Request success does not imply exactly-once server persistence; domain adapters own reconciliation and write compatibility.

## Independent integrations

`local.ai-memory` is developed and packaged in the separate `PI-AI-Memory`
repository. Its source, upstream compatibility matrix, domain tests and release
workflow are owned there. Desktop retains only the generic owner-call, managed
connection, file-scope and lifecycle contracts and their synthetic host tests.
Installing or updating the plugin remains an explicit plugin installation;
Desktop does not bundle it or promise compatibility with arbitrary memory servers.

### Custom mode identity

Staged and user-defined modes retain their exact mode id in owner-call
registration and dispatch. Main accepts a custom id only when the durable
Host session and its outbound launch binding agree. Missing or changed mode
identity fails closed. This preserves the existing owner-service write rule:
only the builtin `agent` id permits mutating owner operations; Plan, Goal and
custom ids can call declared read-only operations. An agent-level custom stage
does not acquire additional plugin owner authority through this migration.
