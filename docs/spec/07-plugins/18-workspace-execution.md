# 18. Local and SSH Workspace Execution

Status: Implemented candidate; native Linux SSH and mounted Desktop acceptance remain release gates.
Decision: [ADR 0340](../../adr/0340-workspace-plugin-execution.md).

## Execution placement

Views, dialogs, clipboard, model configuration, OAuth and session persistence remain
on Desktop. Workspace backends run beside the files: a local child for a local
project, or a Node child of the paired `pi-host` for an SSH project. No remote
Agent session is required for a plugin, structured process or workspace PTY.

```json
{"main":"main.js","execution":{"main":"workspace"}}
```

Omitting `execution` preserves the legacy Desktop backend. A dual-entry plugin uses:

```json
{"main":"desktop.js","execution":{"main":"desktop","workspaceMain":"worker.cjs"}}
```

Normal panel messages call the Desktop entry. `pi.workspace.invoke(channel, payload)`
or the panel channel `workspace.invoke` with `{channel, payload}` calls the worker's
`onWorkspaceInvoke`. A worker cannot recursively invoke itself.
`pi.workspace.isAvailable()` reports whether that call can reach a backend now. It
never prompts and never starts plugin code; a not-yet-decided Host approval reports
`true` so the first real call can ask once. A refused approval, a disconnected Host
or a Host without `workspacePlugins` reports `false` until the package is unloaded.
If a bound page polls `workspace.get` and the backend is unavailable for one of those
reasons, it receives the legacy Desktop workspace shape so older consumers can keep
their documented fallback. Page `workspace.get`
uses the bound workspace entry; native Desktop `workspace.get` preserves the
Desktop/legacy remote metadata shape. Workspace entries receive real execution-host
paths and `executionContext`; `workspace.getContext()` provides the explicit identity.
Never pass a `remote-project:*` identity to an OS filesystem or process API.

Providers, device integrations, Agent extensions, renderer callbacks and composer
transforms require a Desktop main. Split native workspace work into a companion.
Resident services follow `execution.main`: companions do not duplicate Desktop
services. Workspace service status includes `instanceId` and `workspaceId`.

MCP `execution: "desktop" | "workspace"` defaults to main placement. A companion's
workspace MCP must opt in. Stdio resolution uses the execution host's PATH, with
package cwd so relative bundled scripts still work. `PI_WORKSPACE_ROOT`,
`PI_WORKSPACE_ID`, `PI_PLUGIN_ROOT` and literal `${workspaceRoot}` / `${pluginRoot}`
argv/env substitution provide explicit workspace references. Only own settings
referenced by that server are transferred. HTTP egress policy covers redirects.

Tools are discovered per originating session, including MCP-only plugins before a
panel opens. Workspace catalogs and clients are instance-owned. A workspace tool
wins over the same plugin's Desktop tool with the same name; different plugins
remain namespaced. Dispatch re-resolves the invoking session and verifies the tool
exists in that workspace's admitted catalog.

## Identity and lifecycle

The Host generates `WorkspaceExecutionContext`: workspace/project IDs, authority,
registered roots, platform, connection state and generation. Plugins cannot choose
another Host by supplying roots or IDs. Retained surfaces, reverse calls, commands,
tools and resources capture their origin. Selecting another project only changes
new entrances. Project removal, rebinding, Host replacement or an incompatible
connection generation invalidates the old binding.

The installation and each workspace instance are separate. Instances are keyed by
plugin installation, workspace authority/identity and generation; packages are
verified by digest. A surface has an opaque token, session and tab owner, so delayed
hide/close responses cannot affect another surface. The Host validates parent-call
IDs; callbacks after completion/cancellation are rejected. `session.getActive()` in
a bound invocation returns the originating session snapshot, even when another
session is selected. Legacy hosts without the snapshot service return null rather
than another session's state.

Disconnect never switches execution to Desktop and never replays saves, commits,
commands, terminal input or MCP calls. A response lost after dispatch may mean the
operation completed: refresh state before deciding whether to repeat it. Only an
explicit terminal replay/reattach admits a replacement connection. Plugin calls,
MCP clients, process handles, resource servers and port forwards close on owner
teardown. Native authorization is rechecked on calls and every five idle seconds.
Trusted extension processes also recheck disablement/ownership every five seconds.

## Authorization and package admission

Native plugins execute with the OS privileges of the SSH account. Neither a child
process nor SDK scopes form an OS sandbox. Desktop presents an explicit native-code
consent in a theme-aware application dialog; Rust host-core stores approvals by
plugin, Host and package SHA-256. Main owns the pending binding and accepts only
an explicit answer for the active request from the main window's top frame.
Requests are queued until the renderer subscribes and shown one at a time. Deny
is initially focused; Escape and a backdrop click deny. Navigation, renderer loss,
window closure, plugin unload and service disposal cancel pending decisions.
There is no automatic approval or native-dialog fallback. The dialog uses the
shared overlay tokens and blocks embedded plugin views while visible.
Changed package content requires approval again. SDK file/process/terminal/MCP
calls still intersect installed and declared permissions. Model keys, SSH keys and
Desktop environment secrets are not copied to the remote child.

RACP owner-only capabilities are `workspacePlugins: 1`, `workspaceProcesses: 1` and
`workspaceTerminal: true`; operations are `workspace/plugin`, `workspace/process`,
`workspace/terminal`, with reverse plugin/terminal events. Missing capability fails
explicitly. The shared runner lives in `packages/host-runtime/plugin-host-process.mjs`;
Desktop bundles it through its compatibility entry and pi-host copies it verbatim.

Admission uses bounded begin/chunk/commit, canonical paths, SHA-256 and atomic rename.
Limits: 2,000 files, 50 MiB raw / 72 MiB transfer per package; 64 cached/reserved
artifacts and 512 MiB per run; one upload per connection, four total, two-minute
expiry. Managed abandoned run caches are recovered on startup. Traversal, symlinks,
credential paths, Windows reserved/colliding paths and `.node` files are rejected.
`.git`, `.pi`, `.agents`, `.memories` and `node_modules` are excluded. Arbitrary native
dependency installation and target-specific package selection are not implemented;
ship portable/self-contained JS or wait for matching target-package support.

Plugin messages use ordered 64 KiB frames, at most 36 MiB assembled and a 60-second
assembly lifetime. Byte arrays have a stable wire representation. There are at most
64 plugin instances, 16 per device, and 64 concurrent reverse workspace API calls per
instance. Delivery acknowledgements do not wait for long MCP completion, allowing
cancellation to arrive without deadlock.

## SDK process and terminal APIs

Permissions: `workspace.exec` for processes; `workspace.terminal` for PTYs.

```js
const result = await pi.workspace.exec({
  command: "git", args: ["status", "--short"], cwd: ".", timeoutMs: 30_000,
  signal, onOutput: chunk => console.log(chunk.stream, chunk.text),
});
const process = await pi.workspace.process.start({command:"node",args:["worker.js"]});
await pi.workspace.process.end(process.processId);
const page = await pi.workspace.process.read(process.processId, 0, 1000);
await pi.workspace.process.close(process.processId);
const {shells} = await pi.workspace.terminal.list();
const terminal = await pi.workspace.terminal.create({shellId:shells[0].id,cols:100,rows:30});
await pi.workspace.terminal.write(terminal.terminalId, "pwd\r");
const replay = await pi.workspace.terminal.replay(terminal.terminalId, 65536);
await pi.workspace.terminal.close(terminal.terminalId);
```

Process `start/read/write/end/cancel/close` uses literal argv (`shell:false`), in-root
canonical cwd, filtered environment and connection-owned handles. Default timeout
120 seconds, maximum ten minutes; 64 processes total / 16 per device. Retained
output/input is bounded at 1 MiB, reads at 256 KiB, input frames at 64 KiB, and polls
at four per handle / 20 seconds. Exit does not imply the output is drained: continue
while `more` is true. SDK exec bounds collected output at 8 MiB and stdin at 1 MiB.
Cancellation terminates the process tree; a cancelled parent call closes SDK handles
even if process admission raced cancellation. Completed handles expire after 60 seconds.

PTY shell discovery runs on the target Host. Output has sequence numbers, bounded
replay and backpressure; accepted data drains before exit. There are at most 64 PTYs
and eight per device. Detached terminals expire after five minutes. SDK PTY output uses replay/buffer polling, not a subscription
API. The built-in terminal receives live events and subscribes before creation.
Missing node-pty returns a capability error. A disconnected terminal never queues
keystrokes or starts a local shell as a substitute.

Trusted Agent extension `pi.exec` routes default/relative/workspace cwd to the
session's remote workspace. `target:"local"` and legacy explicit absolute outside-root
helper cwd remain local; `target:"workspace"` forces workspace enforcement. Raw Node
fs in an Agent extension remains local and is not intercepted.

## Files, resources and localhost

SDK reads/writes resolve on the admitted host with credential/protected-root checks,
manifest scopes and explicit out-of-scope consent. Text/range maximum is 8 MiB;
listing is capped at 1,000 results and scans at 20,000 entries/depth 32. Writes use a
temporary sibling and rename. SDK own-delete tracking is instance-local, nonrecursive,
and has a confirmation brake after 20 deletions/minute. A picker or dropped-file
Desktop grant cannot be reinterpreted as a remote absolute path.

- `fs.openDefault` on a remote file asks to download and open a local copy. A native
  save dialog chooses a new filename; exclusive creation never overwrites an
  existing Desktop file. Reads use 1 MiB chunks, with size/mtime verification and
  partial-copy cleanup. Complete copies belong to the user and survive unload;
  changes never write back automatically. Maximum file size is 64 MiB.
- `fs.reveal` validates the file and opens its location in the originating session's
  File Manager. It does not launch a graphical file manager on the SSH Host.
- `fs.openInBrowser` serves HTML and sibling resources through a random, loopback-only
  URL. Each read revalidates authority, permission and instance. Host/header/path
  checks, no-store/no-referrer, bounded reads and restrictive CSP apply. Preview is
  limited to the HTML directory and descendants, eight leases, four reads per lease,
  64 MiB per resource and 30 minutes. Parent-directory assets, external network
  dependencies, automatic live reload and HTTP range streaming are not supported.
- `workspace.openPort({port,path})` explicitly previews a workspace HTTP service.
  It requires both `workspace.exec` and `browser.cdp`, an originating session, port
  1024–65535 and a path on the forwarded origin. SSH forwards target remote
  `127.0.0.1`, reuse the paired metadata and never expose the paired Host control
  port. Direct non-SSH peers fail explicitly. At most eight 30-minute forwards;
  disconnect closes immediately and ownership is rechecked every five seconds.
  The API does not rewrite arbitrary HTML localhost URLs or start a web server.

The bundled File Manager uses a Desktop main plus workspace companion. Native
project operations preserve its containment, credential deny list, optimistic save
conflicts, atomic write and audit behavior. Remote graphical editor launch is
unavailable. When `isAvailable()` is false (old Host or refused native approval), the
Desktop entry uses the existing scoped read-only remote gateway without prompting again.
Host-opened session scratch/attachment files stay local, under a host-created,
30-minute single-file grant. `external:true` alone is not authorization. Views are
unchanged generated upstream artifacts; backend hotfix provenance and checksums
are in the bundled `UPSTREAM.md`.

## Verification and release gates

`apps/desktop/test/workspace-plugin-files-git.test.mjs` runs actual bundled File
Manager and candidate Git plugin subprocesses, local and remote service transports,
real filesystem effects, Git hunk stage/commit, resource opens and no replay.
Set `PI_GIT_PLUGIN_PATH` to the candidate plugin; omission explicitly skips Git cases.
`workspace-plugin-mcp.test.mjs` covers four placement combinations with real MCP,
SDK subprocesses, PTYs and cancellation. RACP suites use actual authorization and
protocol handlers; direct/memory transports are not SSH evidence.

Before release, run the same candidate Desktop and complete pi-host bundle on Linux
x64 and arm64 SSH hosts, with two same-named but distinct projects. Verify edit →
hunk stage → commit → terminal log, bare-remote fetch/pull/push, media, case/symlink
boundaries, disconnect at each mutation phase, revocation, reconnect and cleanup.
Run mounted Desktop view/terminal journeys only with task authorization. Record
base/head, bundle digests, Node ABI, node-pty presence, target platform and results.
A Windows build cannot produce or accept a native Linux pi-host release bundle.
