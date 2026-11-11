import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { currentSourceAliases } from "./helpers/current-source-vite.mjs";

/**
 * Pure view model of the V3 command-center surface.
 *
 * The fixtures are the committed C1 producer vectors, so the tests read the
 * same workspace, summary and receipt shapes a real Host adapter must pass.
 * Focus, drafts and local recall history are device state only: no step here
 * may invent, reassign or settle a task.
 */
const root = fileURLToPath(new URL("../../..", import.meta.url));
const summaryFixture = JSON.parse(
  await readFile(new URL("../../../packages/shared/test/fixtures/command-center-summary.json", import.meta.url), "utf8"),
);
const controlFixture = JSON.parse(
  await readFile(new URL("../../../packages/shared/test/fixtures/command-center-control.json", import.meta.url), "utf8"),
);

async function loadView(t) {
  const server = await createServer({
    root: `${root}/apps/desktop`,
    configFile: false,
    logLevel: "silent",
    resolve: { alias: currentSourceAliases(root) },
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const view = await server.ssrLoadModule("/src/components/command-center/view/command-center-view.ts");
  const shared = await server.ssrLoadModule("@pi-desktop/shared");
  return { view, shared };
}

const workspaces = summaryFixture.workspaces.workspaces;
const snapshot = summaryFixture.snapshot;
const [delivery, research] = workspaces;

function historyEntry(target, label, visitedAt, workspaceId = delivery.id) {
  return { target, label, workspaceId, workspaceName: "Delivery", visitedAt };
}

const sessionA = { kind: "session", sessionId: "sess-main-1" };
const sessionB = { kind: "session", sessionId: "sess-other" };
const delegationA = { kind: "delegation", parentSessionId: "sess-parent-1", delegationId: "del-chain-7" };

test("workspace previews come from real workspace data and live counts", async (t) => {
  const { view } = await loadView(t);
  const entries = view.selectWorkspaceEntries(workspaces, snapshot);
  assert.deepEqual(
    entries.map((entry) => [entry.letter, entry.name, entry.activeAgents, entry.maxAgents]),
    [
      ["A", "Delivery", 2, 12],
      ["B", "Research", 0, 12],
      ["C", "Operations", 0, 12],
    ],
    "A/B/C are design positions; names and counts come from the C1 data",
  );
  assert.ok(
    entries.every((entry) => entry.workspaceId === workspaces[["A", "B", "C"].indexOf(entry.letter)].id),
  );
  assert.ok(!entries.some((entry) => entry.name === "Payments"), "no fixed sample project may leak into the UI");
  assert.equal(
    view.selectWorkspaceEntries(workspaces, snapshot).length,
    3,
    "the disabled archive workspace is not previewed",
  );
  assert.deepEqual(view.selectWorkspaceEntries([], snapshot), []);
});

test("only capacity-occupying states count as live and rows lead with attention", async (t) => {
  const { view } = await loadView(t);
  const rows = view.selectTaskRows(snapshot);
  assert.deepEqual(
    rows.map((row) => [row.status, row.label, row.needsHuman, row.active]),
    [
      ["waiting_human", "Review child fixtures", true, true],
      ["running", "Deliver control contracts", false, true],
      ["completed", "Settled audit", false, false],
    ],
  );
  const settled = view.selectWorkspaceView({ workspaceId: research.id, workspaces, snapshot });
  assert.equal(settled.liveAgents, 0, "a completed row releases its slot");
  assert.equal(settled.attentionCount, 0);
  const focused = view.selectWorkspaceView({ workspaceId: delivery.id, workspaces, snapshot });
  assert.equal(focused.liveAgents, 2);
  assert.equal(focused.attentionCount, 1);
  assert.deepEqual(focused.entries.map((entry) => entry.letter), ["A", "B", "C"]);
  assert.equal(view.selectWorkspaceView({ workspaceId: "not-a-workspace", workspaces, snapshot }), undefined);
});

test("the overview previews a bounded monitor list", async (t) => {
  const { view } = await loadView(t);
  const overview = view.selectOverviewView(snapshot);
  assert.deepEqual(
    { total: overview.totalTasks, active: overview.activeTasks, attention: overview.attentionCount, rows: overview.rows.length },
    { total: 3, active: 2, attention: 1, rows: 3 },
  );
  assert.deepEqual(view.selectOverviewView(undefined), { totalTasks: 0, activeTasks: 0, attentionCount: 0, rows: [] });
  const many = { ...snapshot, rows: [...snapshot.rows, ...snapshot.rows, ...snapshot.rows] };
  assert.equal(view.selectOverviewView(many).rows.length, 3, "the overview never renders an unbounded list");
});

test("focus navigation is local, reversible and never rewrites execution identity", async (t) => {
  const { view } = await loadView(t);
  let state = view.createCommandCenterViewState();
  const stateKeys = Object.keys(state).sort();
  assert.deepEqual(state.destination, { kind: "overview" });

  state = view.reduceCommandCenterView(state, { type: "open-workspace", workspaceId: delivery.id });
  assert.deepEqual(state.destination, { kind: "workspace", workspaceId: delivery.id });
  assert.equal(state.lastWorkspaceId, delivery.id);

  const draftKey = view.commandCenterDraftKey(delivery.id);
  state = view.reduceCommandCenterView(state, { type: "update-draft", key: draftKey, text: "Keep the API stable" });
  assert.equal(state.drafts[draftKey], "Keep the API stable");

  state = view.reduceCommandCenterView(state, { type: "open-overview" });
  assert.deepEqual(state.destination, { kind: "overview" }, "Overview returns without changing ownership");
  assert.equal(state.lastWorkspaceId, delivery.id, "the focused workspace is remembered");
  assert.equal(state.drafts[draftKey], "Keep the API stable", "returning to the overview keeps the draft");

  const unchanged = view.reduceCommandCenterView(state, { type: "open-workspace", workspaceId: "" });
  assert.equal(unchanged, state, "an empty workspace id is ignored");
  assert.deepEqual(Object.keys(state).sort(), stateKeys, "the surface owns no execution state");
  assert.deepEqual(state.history, []);
});

test("drafts are JSON-tuple scoped, bounded and removable", async (t) => {
  const { view, shared } = await loadView(t);
  const taskKey = shared.commandCenterTaskKey(delegationA);
  assert.equal(view.commandCenterDraftKey("ws-1"), JSON.stringify(["draft", "ws-1"]));
  assert.equal(view.commandCenterDraftKey("ws-1", taskKey), JSON.stringify(["draft", "ws-1", taskKey]));

  let state = view.createCommandCenterViewState();
  state = view.reduceCommandCenterView(state, {
    type: "update-draft",
    key: "k",
    text: "x".repeat(view.COMMAND_CENTER_MAX_DRAFT_CHARS + 25),
  });
  assert.equal(state.drafts.k.length, view.COMMAND_CENTER_MAX_DRAFT_CHARS);

  const same = view.reduceCommandCenterView(state, { type: "update-draft", key: "k", text: state.drafts.k });
  assert.equal(same, state, "an unchanged draft does not re-render the page");

  state = view.reduceCommandCenterView(state, { type: "update-draft", key: "k", text: "" });
  assert.equal(state.drafts.k, undefined, "an emptied draft is dropped");
  assert.equal(view.reduceCommandCenterView(state, { type: "update-draft", key: "", text: "x" }), state);
});

test("recall history merges by canonical task identity, not display text", async (t) => {
  const { view, shared } = await loadView(t);
  assert.equal(shared.commandCenterTaskKey(delegationA), '["delegation","sess-parent-1","del-chain-7"]');
  assert.equal(shared.commandCenterTaskKey(sessionA), '["session","sess-main-1"]');

  let history = view.mergeCommandCenterHistory([], [historyEntry(sessionA, "First", 1), historyEntry(sessionB, "Other", 2)]);
  assert.deepEqual(history.map((entry) => entry.label), ["Other", "First"], "latest visit first");

  history = view.mergeCommandCenterHistory(history, [historyEntry(sessionA, "Renamed", 3)]);
  assert.deepEqual(history.map((entry) => entry.label), ["Renamed", "Other"], "revisiting updates instead of duplicating");

  history = view.mergeCommandCenterHistory(history, [historyEntry(sessionA, "Stale replay", 2)]);
  assert.deepEqual(history.map((entry) => entry.label), ["Renamed", "Other"], "an older visit cannot roll the row back");

  const continued = view.mergeCommandCenterHistory(history, [historyEntry(delegationA, "Chain", 4)]);
  assert.equal(continued.length, 3, "a distinct delegation chain is a distinct entry");

  const many = view.mergeCommandCenterHistory(
    [],
    Array.from({ length: view.COMMAND_CENTER_HISTORY_LIMIT + 7 }, (_, index) =>
      historyEntry({ kind: "session", sessionId: `sess-${index}` }, `Task ${index}`, index + 1),
    ),
  );
  assert.equal(many.length, view.COMMAND_CENTER_HISTORY_LIMIT);
  assert.equal(many[0].label, `Task ${view.COMMAND_CENTER_HISTORY_LIMIT + 6}`);
});

test("recording and reopening history entries only changes the local view", async (t) => {
  const { view } = await loadView(t);
  let state = view.createCommandCenterViewState();
  state = view.reduceCommandCenterView(state, { type: "open-workspace", workspaceId: delivery.id });
  state = view.reduceCommandCenterView(state, {
    type: "record-visit",
    entry: { target: sessionA, label: "Deliver control contracts", workspaceId: delivery.id, workspaceName: "Delivery" },
  });
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].visitedAt, 1);

  state = view.reduceCommandCenterView(state, {
    type: "record-visit",
    entry: { target: sessionA, label: "Deliver control contracts", workspaceId: delivery.id },
  });
  assert.equal(state.history.length, 1, "a second visit merges");
  assert.equal(state.visitSequence, 2);

  state = view.reduceCommandCenterView(state, { type: "open-history" });
  assert.deepEqual(state.destination, { kind: "history" });
  state = view.reduceCommandCenterView(state, { type: "open-history-entry", entry: state.history[0] });
  assert.deepEqual(state.destination, { kind: "workspace", workspaceId: delivery.id });
  assert.equal(state.lastWorkspaceId, delivery.id);
  assert.equal(state.history.length, 1);
  assert.equal(state.visitSequence, 3, "reopening an entry is one more local visit");
});

test("receipts show the newest revision per request and keep lifecycle states distinct", async (t) => {
  const { view } = await loadView(t);
  const lifecycle = controlFixture.receipts;
  const latest = view.selectReceiptViews([lifecycle.accepted, lifecycle.consumed, lifecycle.completed]);
  assert.deepEqual(
    latest.map((entry) => [entry.status, entry.revision, entry.tone]),
    [["completed", 4, "success"]],
    "a delayed older event cannot roll the visible status back",
  );

  const distinct = ["recorded", "accepted", "consumed", "completed"].map((status, index) => ({
    ...lifecycle.accepted,
    requestId: `request-${index}`,
    status,
    revision: index + 1,
  }));
  const views = view.selectReceiptViews(distinct);
  assert.deepEqual(views.map((entry) => entry.status), ["completed", "consumed", "accepted", "recorded"]);
  assert.deepEqual(views.map((entry) => entry.tone), ["success", "neutral", "neutral", "neutral"]);
  assert.deepEqual(
    view.selectReceiptViews([{ ...lifecycle.accepted, status: "conflicted", error: { code: "CONFLICT", message: "x" } }]).map(
      (entry) => entry.tone,
    ),
    ["error"],
  );
  assert.equal(view.selectReceiptViews([], 3).length, 0);
  assert.equal(view.selectReceiptViews(distinct, 2).length, 2);
});

test("controls stay unavailable while no capability path is implemented", async (t) => {
  const { view } = await loadView(t);
  assert.deepEqual(view.commandCenterControlAvailability(undefined), {
    monitor: false,
    workspaceList: false,
    interventions: false,
  });
  assert.deepEqual(view.commandCenterControlAvailability({ monitor: true, interventions: true }), {
    monitor: false,
    workspaceList: false,
    interventions: false,
  }, "C1 implements no capability, so an advertised flag cannot enable a control");

  const unavailable = view.commandCenterControlAvailability(undefined);
  assert.deepEqual(view.commandCenterDraftSubmission(unavailable, () => {}), {
    available: false,
    blocker: "capability",
  });
  const implemented = { monitor: true, workspaceList: true, interventions: true };
  assert.deepEqual(view.commandCenterDraftSubmission(implemented, undefined), {
    available: false,
    blocker: "handler",
  });
  assert.deepEqual(view.commandCenterDraftSubmission(implemented, () => {}), { available: true });
});
