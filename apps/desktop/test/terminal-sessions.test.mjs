import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

/**
 * The tab-to-terminal registry decides whether a shell survives a view change.
 *
 * Detaching on unmount is what keeps a background command running across a tab,
 * project, or session switch; closing is only for an explicit tab close. These
 * tests pin that split, because a regression either leaks a shell per tab switch
 * or kills work the user still needs.
 */

function loadRegistry() {
  const { outputText } = ts.transpileModule(
    readFileSync(new URL("../src/lib/terminal-sessions.ts", import.meta.url), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  );
  const closed = [];
  const failing = new Set();
  const imports = {
    "./api": {
      api: {
        terminalClose: async (terminalId) => {
          closed.push(terminalId);
          if (failing.has(terminalId)) throw new Error("terminal is gone");
          return { ok: true };
        },
      },
    },
  };
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      assert.ok(Object.hasOwn(imports, id), `Unexpected import: ${id}`);
      return imports[id];
    },
    module.exports,
    module,
  );
  return { registry: module.exports, closed, failing };
}

const TARGET = { sessionId: "session-a", workspaceId: "local:/work/app", tabId: "terminal:1" };
const handle = (terminalId, target = TARGET) => ({ terminalId, target, cols: 80, rows: 24 });

test("a handle remembers the target the terminal was created for", () => {
  const { registry } = loadRegistry();
  registry.setTerminalHandle("terminal:1", handle("term_1"));

  const stored = registry.terminalHandleFor("terminal:1");
  assert.equal(stored.terminalId, "term_1");
  assert.deepEqual(stored.target, TARGET);
  assert.deepEqual(registry.terminalTabIds(), ["terminal:1"]);
  assert.equal(registry.terminalHandleFor("terminal:2"), undefined);
});

test("forgetting a tab detaches without ending the shell", () => {
  const { registry, closed } = loadRegistry();
  registry.setTerminalHandle("terminal:1", handle("term_1"));

  registry.forgetTerminalHandle("terminal:1");

  assert.equal(registry.terminalHandleFor("terminal:1"), undefined);
  assert.deepEqual(closed, [], "a detach must not send a close request");
});

test("closing a tab ends its shell exactly once", () => {
  const { registry, closed } = loadRegistry();
  registry.setTerminalHandle("terminal:1", handle("term_1"));

  registry.closeTerminalForTab("terminal:1");
  registry.closeTerminalForTab("terminal:1");

  assert.deepEqual(closed, ["term_1"]);
  assert.equal(registry.terminalHandleFor("terminal:1"), undefined);
});

test("closing a tab that never opened a shell is a no-op", () => {
  const { registry, closed } = loadRegistry();
  registry.closeTerminalForTab("terminal:never");
  assert.deepEqual(closed, []);
});

test("close-others and close-all end every shell they drop", () => {
  const { registry, closed } = loadRegistry();
  registry.setTerminalHandle("terminal:1", handle("term_1"));
  registry.setTerminalHandle("terminal:2", handle("term_2"));
  registry.setTerminalHandle("terminal:3", handle("term_3"));

  registry.closeTerminalForTabs(["terminal:1", "terminal:3"]);

  assert.deepEqual(closed, ["term_1", "term_3"]);
  assert.deepEqual(registry.terminalTabIds(), ["terminal:2"]);
});

test("a deleted session ends its terminals, including remote ones", () => {
  // A remote terminal is bound to its session but has no work-panel context, so
  // the sweep by session id is what stops a shell nobody can reach any more.
  const { registry, closed } = loadRegistry();
  registry.setTerminalHandle("terminal:local", handle("term_local"));
  registry.setTerminalHandle(
    "remote-terminal:session-b",
    handle("term_remote_b", { sessionId: "session-b", workspaceId: "ssh:host-a:/srv", tabId: "remote-terminal:session-b" }),
  );
  registry.setTerminalHandle(
    "remote-terminal:session-a",
    handle("term_remote_a", { sessionId: "session-a", workspaceId: "ssh:host-a:/work", tabId: "remote-terminal:session-a" }),
  );

  registry.closeTerminalForSession("session-a");

  assert.deepEqual(closed, ["term_local", "term_remote_a"]);
  assert.deepEqual(registry.terminalTabIds(), ["remote-terminal:session-b"]);
});

test("a failing close request still drops the handle", () => {
  const { registry, closed, failing } = loadRegistry();
  registry.setTerminalHandle("terminal:1", handle("term_1"));
  failing.add("term_1");

  registry.closeTerminalForTab("terminal:1");

  assert.deepEqual(closed, ["term_1"]);
  assert.equal(registry.terminalHandleFor("terminal:1"), undefined);
});

test("the registry never keeps a dead tab's terminal after teardown", () => {
  const { registry, closed } = loadRegistry();
  registry.setTerminalHandle("terminal:1", handle("term_1"));

  registry.forgetAllTerminalHandles();

  assert.deepEqual(registry.terminalTabIds(), []);
  assert.deepEqual(closed, [], "teardown does not speak to main");
});
