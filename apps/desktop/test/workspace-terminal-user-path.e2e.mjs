import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire, register } from "node:module";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
register(new URL("./helpers/current-source-import-hooks.mjs", import.meta.url));
const { WorkspaceTerminalRegistry } = await import("../electron/main/terminal/workspace-terminal-registry.ts");
const { DesktopHandoffAdmission } = await import("../electron/main/runtime/handoff-admission.ts");
const { registerTerminalIpc } = await import("../electron/main/ipc/terminal-ipc.ts");
const { IPC, terminalWorkspaceId } = await import("@pi-desktop/shared");
const ptyModule = createRequire(import.meta.url)("node-pty");

for (const sessionId of ["session", undefined]) {
  test(`terminal IPC owns a real shell through handoff refusal and closure ${sessionId ? "with" : "without"} a session`, { timeout: 20_000 }, async t => {
    const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "terminal-user-path-"));
    const stored = root.replaceAll("\\", "/");
    let selected = root;
    const host = { generation: randomUUID(), call: async method => {
      if (method === "session.get") return { session: { projectPath: stored } };
      assert.equal(method, "project.groups.list");
      return { groups: [{ id: "project", name: "Project", primaryPath: stored, roots: [{ path: stored, name: "Project", position: 0 }] }] };
    } };
    const handlers = new Map(), sender = {};
    const registry = new WorkspaceTerminalRegistry(), admission = new DesktopHandoffAdmission();
    const exit = Promise.withResolvers(), cursorResponses = new Set(), cursorErrors = [];
    let terminalId, nativePty, rootExited = false, output = "";
    const waiters = new Set();
    const router = registry.create({
      isAdmissionClosed: () => admission.isClosed(), getHost: () => host, currentWorkspacePath: () => selected,
      remoteClient: () => { throw Error("Unexpected remote lookup"); },
      loadPty: () => ({ spawn(file, _args, options) {
        const env = {};
        for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
          if (process.env[key] !== undefined) env[key] = process.env[key];
        }
        Object.assign(env, { HOME: root, USERPROFILE: root, TEMP: root, TMP: root, APPDATA: root, LOCALAPPDATA: root, TERM: "xterm-256color" });
        nativePty = ptyModule.spawn(file, process.platform === "win32" ? ["/d"] : ["--noprofile", "--norc"], { ...options, env });
        nativePty.onExit(() => { rootExited = true;exit.resolve(); });
        return nativePty;
      } }),
      emit: event => {
        if ("data" in event) {
          const data = Buffer.from(event.data, "base64").toString("utf8");
          output += data;
          // ConPTY asks a terminal emulator for its cursor before starting cmd.
          if (data.includes("\x1b[6n") && terminalId && !admission.isClosed()) {
            const response = call("terminalWrite", { terminalId, data: "\x1b[1;1R" });
            cursorResponses.add(response);
            void response.catch(error => cursorErrors.push(error)).finally(() => cursorResponses.delete(response));
          }
        }
        for (const wake of waiters) wake();
      },
    });
    registerTerminalIpc({ router: () => router, registrar: {
      handleWithEvent: (channel, handler) => handlers.set(channel, handler),
      assertMainWindowSender: event => assert.equal(event, sender),
    } });
    const call = (name, input) => handlers.get(IPC.invoke[name])(sender, input);
    const text = () => stripVTControlCharacters(output).replaceAll("\r", "");
    const waitFor = predicate => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(wake);reject(Error("Terminal output deadline exceeded")); }, 10_000);
      const wake = () => { if (predicate()) { clearTimeout(timer);waiters.delete(wake);resolve(); } };
      waiters.add(wake);wake();
    });
    const confirmExit = async () => {
      let timer;
      try { await Promise.race([exit.promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("Original fixture PTY exit was not observed")), 5000);
      })]); } finally { clearTimeout(timer); }
    };
    // Other families are absent in this isolated terminal fixture, not a Desktop inventory adapter.
    const inspect = async () => ({ clients: 0, turns: 0, queuedTurns: 0, plans: 0, tools: 0,
      processes: 0, plugins: 0, admissions: 0, finalizations: 0, writes: 0, children: 0,
      workers: 0, schedules: 0, approvals: 0, inputs: 0, nativeSessions: 0, mcp: 0, ...registry.getHandoffActivity() });
    try {
      const target = { sessionId, workspaceId: terminalWorkspaceId({ path: root }), tabId: "terminal-tab" };
      const { shells } = await call("terminalListShells", { target });
      const shell = shells.find(item => item.id === (process.platform === "win32" ? "cmd" : "bash"));
      assert.ok(shell, "The isolated fixture shell must be discoverable");
      assert.deepEqual(registry.getHandoffActivity(), { terminals: 0, uncontainedResources: 0 });
      const empty = await admission.gate.acquireHandoff(randomUUID(), inspect);empty.cancel();
      ({ terminalId } = await call("terminalCreate", { target, shellId: shell.id, cols: 120, rows: 30 }));
      await assert.rejects(admission.gate.acquireHandoff(randomUUID(), inspect), { code: "HOST_BUSY" });
      if (output.includes("\x1b[6n")) await call("terminalWrite", { terminalId, data: "\x1b[1;1R" });
      await call("terminalWrite", { terminalId, data: process.platform === "win32" ? "set /a 734000+19\r" : "echo $((734000+19))\r" });
      await waitFor(() => text().includes("734019"));
      await call("terminalResize", { terminalId, cols: 100, rows: 28 });
      const replay = await call("terminalReplay", { terminalId });
      assert.ok(Buffer.from(replay.data, "base64").toString("utf8").includes("734019"));
      selected = join(root, "other-project");
      await call("terminalWrite", { terminalId, data: process.platform === "win32" ? "set /a 845000+23\r" : "echo $((845000+23))\r" });
      await waitFor(() => text().includes("845023"));
      await call("terminalClose", { terminalId });
      assert.deepEqual(await call("terminalReplay", { terminalId }), { data: null });
      await confirmExit();
      await registry.retire(router);
      assert.deepEqual(registry.getHandoffActivity(), { terminals: 0, uncontainedResources: 1 });
      await assert.rejects(admission.gate.acquireHandoff(randomUUID(), inspect), { code: "HOST_BUSY" });
      const next = registry.create({ isAdmissionClosed: () => admission.isClosed(), getHost: () => host,
        currentWorkspacePath: () => root, remoteClient: () => { throw Error("Unexpected remote lookup"); }, emit() {},
        loadPty: () => { throw Error("Closed admission must not load PTY"); } });
      admission.dispose();
      await assert.rejects(next.create({ target, shellId: shell.id, cols: 80, rows: 24 }), { errorCode: "HOST_BUSY" });
      await Promise.allSettled([...cursorResponses]);assert.deepEqual(cursorErrors, []);
    } finally {
      admission.dispose();await registry.dispose();
      if (nativePty) await confirmExit();
      await rm(root, { recursive: true, force: true });
      t.diagnostic(JSON.stringify({ rootExitObserved: rootExited, qualifiedNativeFamilyClosure: false,
        retainedUncontainedResources: registry.getHandoffActivity().uncontainedResources }));
    }
  });
}
