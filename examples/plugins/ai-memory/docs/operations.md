# Operations

## Setup and everyday use

Use native plugin connection settings for the endpoint, token and optional private CA. Allow only POST `/mcp` and `/hook`; do not add `/handoff`. LAN HTTP requires explicit host approval. Endpoint and credential changes increment the connection revision; queued events remain tied to their original revision.

Bind the current Desktop project in the Memory panel. Enter both remote workspace and project. A root marker can provide validation and capture exclusions:

```toml
workspace = "team"
project = "project-a"
[capture]
ignore_paths = ["private/**", "**/*.pem"]
```

No automatic git guess is used for authorization. Worktrees use the host's actual workspace root for marker reads and the durable project identity for the explicit binding. Remote marker errors pause operations; local cwd is never a substitute.

Windows drive/UNC project paths are compared with normalized separators and drive letters, so the native panel and Host session resolve the same binding. POSIX case and remote project identifiers remain distinct; normalization never chooses a different project.

The content checkboxes control prompt, tool argument, tool result and final assistant text capture. All are initially off. Metadata includes session/turn/sequence, tool name/call ID, errors, cancellation and lifecycle. Attachments, environment variables, full native transcripts, known credential fields and protected paths are excluded. Redaction is conservative pattern filtering, not a promise to detect arbitrary secrets; keep sensitive paths excluded and body categories disabled when unsuitable.

Opted-in arguments/results/assistant text persist as explicitly labelled plugin extension observations because the native parser omits some of those fields. Native tool outcomes remain available separately. Compaction and runtime retirement do not trigger server consolidation or automatic handoffs. See the [wire mapping](compatibility.md).

Explicit Desktop session closure marks the local session closed and persists a `session-close` boundary observation. It does not call upstream native `session-end`, which can create an automatic handoff. The upstream session therefore remains unended; users create a handoff only through the explicitly confirmed action.

Automatic recall queries the bound project, reads selected page bodies and lists handoffs without accepting them. Historical memory is untrusted. `aim_acceptHandoff` requires the exact listed ID and confirmation. `aim_writePage` requires create-only or a current page version. The plugin does not perform paid synthesis or consolidation automatically.

## Coexist and migration

Coexist mode is the default. Existing `mem` remains unchanged; this plugin's managed tools are hidden. Capture of existing manual `mem` tools follows the user's selected content policy. Before enabling automatic capture, turn off duplicate upstream lifecycle hooks only through the normal user-managed configuration flow. Never run both capture implementations unintentionally.

Enable managed mode explicitly, then reload/reopen the conversation runtime. Check query/read, a synthetic page create/read, a conflicting update refusal, handoff preview/accept and restart recovery using an isolated server. Only after these pass should the user disable the old `mem` tool configuration. The plugin never removes that configuration or runs an upstream installer.

## Diagnostics and recovery

| Code / state | Action |
| --- | --- |
| HOST_UPGRADE_REQUIRED / unsupported | Use a candidate host with owner v1 and connection v1; inspect granted permissions |
| PROJECT_UNBOUND | Bind the current project to a connection/workspace/project |
| BINDING_CONFLICT / MARKER_INVALID | Correct the marker or explicit binding; no automatic scope choice is made |
| REMOTE_MARKER_UNAVAILABLE | Upgrade/reconnect the remote Host; do not copy local marker data |
| WRITES_NOT_VERIFIED / CAPTURE_NOT_VERIFIED | Use supported 3.3.2/3.3.3 with matching schemas or a reviewed adapter update; do not bypass the gate |
| SESSION_START_CONSUMED_HANDOFF | Pause; enter the exact event ID and review the retained legacy response; reconcile the server handoff without accepting another row |
| AUTH_REQUIRED | Reauthorize through native connection settings; inspect old queue revision before choosing Retry |
| remote-queued | The server admitted the event asynchronously; read-only observation polling confirms persistence. Do not replay it |
| CONNECTION_CHANGED / quarantined | Reconcile or discard old events; never retarget them to new credentials/origin |
| delivery-uncertain | Use Check persisted observations for read-only reconciliation. Mark delivered only with evidence, or discard the local event. Blind replay is refused |
| PAGE_CONFLICT | Read the current page; review changes and issue a newly confirmed revision using its page ID |
| QUEUE_FULL / retention-expired | Review retained events. New events are rejected rather than silently deleting old events |
| STATE_VERSION_UNSUPPORTED / STATE_CORRUPT | Keep the canonical file intact; restore a compatible plugin/backup after investigation |
| STATE_LOCKED | Ensure no second plugin process owns this data directory; do not delete a live writer's lock |
| RECALL_DEADLINE / offline | Chat continues without a new packet; check the connection and retry on the next task |
| MCP_SESSION_EXPIRED | Reads reinitialize once after an expired stateful MCP session; mutations are never automatically replayed. Reconcile uncertain writes before issuing a new intent |
| STATE_UNWRITABLE | Keep the existing snapshot; check private-directory permissions/locks/free space. Transient Windows rename locks receive bounded retries without deleting the canonical file |

The panel displays queue count, oldest age, bounded event IDs, retry attempts, errors, capability fingerprints and recent recall source paths. Export contains metadata only, never bodies, handoff content, endpoint, absolute project paths or credentials. A retained accidental claim response is deliberately separate from diagnostic export.

A queued local receipt means the journal accepted the event, not that the server committed it. A `remote-queued` receipt means the server replied `202 queued`; this does not prove storage. A delivered receipt records every expected native/detail observation, including complete detail bodies, or a separately labelled operator reconciliation. There is no distributed transaction between server mutation and local recovery storage, and no exactly-once network claim.

## Storage, retention, upgrades and removal

The private path is `<plugin.getDataPath()>/memory-v1/state-v1.json`. It can contain allowed project text and accepted handoff recovery data. Protect it like project data; it is not encrypted by the plugin. Default bounds are 2,000 events, 16 MiB canonical state, 2,000 session mappings and 500 mutation records. Unsent events older than seven days are held for explicit review. Delivered/discarded receipts and completed mutation recovery records are pruned after seven days; unresolved records are never silently removed. Windows filesystem ACLs are inherited from the host private data directory.

Pause stops new capture/recall and uploads. Disable/unload cancels outstanding host requests and stops the resident worker while retaining local configuration. In this candidate Host, uninstall deletes plugin-private data and its encrypted connection record, then removes the registration. Reconcile/export anything needed before uninstalling; reinstall requires new connection setup. Uninstall never calls a server delete or migration. Local discard cannot undo an already committed server write.

Before upgrading, stop the plugin and back up its private state and settings. This initial release uses state schema 1 and has no prior format to migrate. Future migrations must back up, validate and atomically switch; older plugins refuse newer schema versions. A rollback retains old adapter/version metadata and cannot blindly replay uncertain events. Do not delete application data to make an upgrade pass.

## Integration and packaging

The public main exports are `onLoad`, `onUnload`, `onAgentExtensionCall` and `onPanelInvoke`. The extension default export is a synchronous factory. Parent integration must wire the manifest owner-operation grant list and immutable host context into the former, expose connection v1, and route `fs.readPreview('.ai-memory.toml', {workspacePath: context.projectPath})` under the owner session's true root.

Run the commands in the [README](../README.md). Build `dist/`, run current plugin-devkit `check` and `pack` there, then validate that exact package with an isolated candidate Desktop profile. Real-server compatibility and installed Desktop tests must be recorded separately from the offline plugin tests. This candidate has no automatic install, publish or deployment step.
