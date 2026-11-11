#!/usr/bin/env node
/** Public-package consumer check. No Desktop, profile, listener or provider is started. */
import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { checkConnectionHealthConsumer } from "./e2e/command-center/connection-health-consumer.mjs";
import { checkMonitorSessionConsumer } from "./e2e/command-center/monitor-session-consumer.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const argumentsList = process.argv.slice(2);
assert.ok(argumentsList.length === 0 || (argumentsList.length === 1 && argumentsList[0] === "--built"), "Usage: check-command-center-foundations.mjs [--built]");
const built = argumentsList[0] === "--built";
const entryDirectory = built ? "dist" : "src";
const entryExtension = built ? "js" : "ts";
const shared = fileURLToPath(new URL("../packages/shared/src/index.ts", import.meta.url));
const json = async (name) => JSON.parse(await readFile(new URL(`../packages/shared/test/fixtures/${name}`, import.meta.url), "utf8"));

async function bundle(entry, platform, format, globalName) {
  const result = await build({
    absWorkingDir: root, entryPoints: [entry], bundle: true, write: false,
    platform, format, globalName, target: "es2022", logLevel: "silent", metafile: true,
    ...(built ? {} : { alias: { "@pi-desktop/shared": shared } }),
  });
  assert.equal(result.outputFiles.length, 1);
  if (platform === "browser") {
    for (const output of Object.values(result.metafile.outputs)) {
      assert.equal(output.imports.length, 0, "Browser entry must not retain Node or external imports");
    }
    for (const input of Object.keys(result.metafile.inputs)) {
      assert.doesNotMatch(input.replaceAll("\\", "/"), /packages\/(agent-host|host-runtime|racp)\//);
    }
  }
  return result.outputFiles[0].text;
}

const hostCode = await bundle(`packages/agent-host/${entryDirectory}/index.${entryExtension}`, "node", "esm");
const { MonitorSnapshotStore, MONITOR_SNAPSHOT_LIMITS: hostLimits } = await import(
  `data:text/javascript;base64,${Buffer.from(hostCode).toString("base64")}`
);
const sharedCode = await bundle(`packages/shared/${entryDirectory}/index.${entryExtension}`, "node", "esm");
const sharedApi = await import(`data:text/javascript;base64,${Buffer.from(sharedCode).toString("base64")}`);
const summaries = (await json("command-center-summary.json")).snapshot;
let now = Date.parse(summaries.generatedAt);
const store = new MonitorSnapshotStore({
  epoch: summaries.cursor.epoch, clock: { now: () => now }, tokens: { next: randomUUID },
  limits: { pageRows: 1, maxAgeMs: 50 },
});
const scopeKey = "authenticated-scope:1/filter:all";
const first = store.capture({ scopeKey, sequence: summaries.cursor.sequence, rows: summaries.rows });
assert.equal(first.rows.length, 1);
assert.ok(first.nextPage);
const label = summaries.rows[1].label;
summaries.rows[1].label = "Source changed after capture";
const next = { scopeKey, epoch: first.cursor.epoch, token: first.nextPage };
assert.equal(store.page({ ...next, scopeKey: "different-scope" }).status, "resync");
const second = store.page(next);
assert.equal(second.status, "page");
assert.equal(second.snapshot.rows[0].label, label);
assert.deepEqual(second.snapshot.cursor, first.cursor);
second.snapshot.rows[0].label = "Caller changed its copy";
assert.equal(store.page(next).snapshot.rows[0].label, label);
now += 50;
assert.equal(store.page(next).status, "resync");
store.dispose();
assert.equal(store.page(next).reason, "disposed");

const clientCode = await bundle(`packages/command-center-client/${entryDirectory}/index.${entryExtension}`, "browser", "iife", "CommandCenterClient");
// A separate realm with Web APIs and without process, Buffer, require or network.
// This proves package portability, not real-browser/mobile qualification.
const sandbox = { crypto: webcrypto, TextEncoder, TextDecoder, structuredClone, URL, URLSearchParams, AbortController };
runInNewContext(clientCode, sandbox, { timeout: 10_000 });
const client = sandbox.CommandCenterClient;
const control = await json("command-center-control.json");
const context = client.createCommandCenterObservationContext();
const attempt = await client.createCommandCenterInterventionAttempt(context, control.request);
assert.equal(attempt.getState().fingerprint, control.receipt.fingerprint);
assert.equal(attempt.observeReceipt(context, control.receipts.accepted).kind, "applied");
assert.equal(attempt.getState().settled, false);
attempt.markDisconnected(context);
assert.equal(attempt.getState().observation, "outcome_unknown");
assert.equal(attempt.getState().receipt.status, "accepted");
assert.equal(attempt.observeReceipt(context, control.receipts.completed).kind, "applied");
assert.equal(attempt.getState().settled, true);
assert.equal(attempt.observeReceipt(context, control.receipts.accepted).kind, "ignored_stale");
const foreign = client.createCommandCenterObservationContext();
assert.equal(attempt.observeReceipt(foreign, control.receipts.completed).kind, "rejected");
client.invalidateCommandCenterObservationContext(context);
assert.equal(attempt.getState().kind, "invalidated");
assert.equal(attempt.observeReceipt(context, control.receipts.completed).kind, "rejected");
attempt.dispose();
client.invalidateCommandCenterObservationContext(foreign);
// Join the actual Host page store to the browser-target reader through its
// injected read-only port. The adapter is a controlled transport boundary.
const manyRows = Array.from({ length: 205 }, (_, index) => ({
  ...summaries.rows[0], target: { kind: "session", sessionId: `s${index}` },
  execution: { kind: "session", sessionId: `s${index}`, turnId: `t${index}` },
}));
const paging = new MonitorSnapshotStore({ epoch: "page-join", clock: { now: () => now }, tokens: { next: randomUUID }, limits: { maxAgeMs: 50 } });
const monitorContext = client.createCommandCenterObservationContext();
client.bindCommandCenterObservationOwner(monitorContext, {
  hostId: control.request.hostId, expectedHostEpoch: control.request.expectedHostEpoch,
});
let expireNextPage = false;
let calls = 0;
const reader = client.createCommandCenterMonitorReader(monitorContext, async (token, signal) => {
  assert.equal(signal.aborted, false);
  calls += 1;
  if (token === undefined) return paging.capture({ scopeKey, sequence: 10, rows: manyRows });
  if (expireNextPage) now += 50;
  const result = paging.page({ scopeKey, epoch: "page-join", token });
  if (result.status === "resync") throw new Error("Page expired; explicit refresh required");
  return result.snapshot;
});
assert.equal((await reader.refresh()).kind, "published");
assert.equal(calls, 3);
assert.equal(reader.getState().projection.rows.length, 205);
assert.equal(reader.getState().projection.cursor.sequence, 10);
assert.equal(reader.getState().projection.rows[204].target.sessionId, "s204");
assert.equal(reader.getState().projection.nextPage, undefined);
const previousProjection = reader.getState().projection;
expireNextPage = true;
assert.equal((await reader.refresh()).kind, "failed");
assert.equal(calls, 5, "No automatic refresh after an expired continuation");
assert.equal(reader.getState().status, "error");
assert.equal(reader.getState().projection, previousProjection, "Partial refresh never replaces a complete projection");
// A published projection is then kept current by validated change envelopes.
const summary = client.createCommandCenterMonitorSummary(monitorContext, previousProjection);
const { epoch } = previousProjection.cursor;
const liveRow = { ...previousProjection.rows[1], target: { kind: "session", sessionId: "live-new" },
  execution: { kind: "session", sessionId: "live-new", turnId: "t-live" } };
assert.equal(summary.getState().status, "ready");
assert.equal(summary.apply({ version: 1, epoch, sequence: 11, type: "upsert",
  row: { ...previousProjection.rows[0], label: "Live label" } }), "applied");
assert.equal(summary.apply({ version: 1, epoch, sequence: 11, type: "upsert",
  row: { ...previousProjection.rows[0], label: "Live label" } }), "duplicate");
assert.equal(summary.apply({ version: 1, epoch, sequence: 12, type: "upsert", row: liveRow }), "applied");
assert.equal(summary.apply({ version: 1, epoch, sequence: 13, type: "remove",
  target: { kind: "session", sessionId: "s2" } }), "applied");
const live = summary.getState().projection;
assert.equal(live.rows.length, 205);
assert.equal(live.cursor.sequence, 13);
assert.equal(live.generatedAt, previousProjection.generatedAt, "Snapshot cut timestamp is not invented by deltas");
assert.equal(live.rows[0].label, "Live label");
assert.ok(live.rows.some((row) => row.target.sessionId === "live-new"));
assert.ok(!live.rows.some((row) => row.target.sessionId === "s2"));
// A gap cannot be silently bridged; the model retains its last consistent rows.
const gap = summary.apply({ version: 1, epoch, sequence: 15, type: "upsert", row: liveRow });
assert.equal(gap.resync, "sequence_gap");
assert.equal(summary.getState().status, "resync_required");
assert.deepEqual(summary.getState().projection.rows.length, 205, "Last consistent projection retained for stale display");
client.invalidateCommandCenterObservationContext(monitorContext);
assert.equal(summary.getState().projection, null);
assert.equal(summary.getState().status, "invalidated");
assert.equal(reader.getState().projection, null);
assert.equal(reader.getState().status, "invalidated");
reader.dispose();
summary.dispose();
paging.dispose();

// Default ceilings must compose: the Host allows 1,024 continuation tokens in
// addition to the initial page, so a legal 1,025-page generation must be
// readable without lowering any bound.
const tinyRows = Array.from({ length: 1025 }, (_, index) => ({
  ...summaries.rows[0],
  target: { kind: "session", sessionId: `tiny-${index}` },
  execution: { kind: "session", sessionId: `tiny-${index}`, turnId: `t-${index}` },
}));
const tinyStore = new MonitorSnapshotStore({
  epoch: "tiny-pages", clock: { now: () => now }, tokens: { next: randomUUID },
  limits: { pageRows: 1, maxAgeMs: 60_000 },
});
const tinyContext = client.createCommandCenterObservationContext();
client.bindCommandCenterObservationOwner(tinyContext, {
  hostId: control.request.hostId, expectedHostEpoch: control.request.expectedHostEpoch,
});
let tinyCalls = 0;
const tinyReader = client.createCommandCenterMonitorReader(tinyContext, async (token) => {
  tinyCalls += 1;
  if (token === undefined) return tinyStore.capture({ scopeKey, sequence: 1, rows: tinyRows });
  const result = tinyStore.page({ scopeKey, epoch: "tiny-pages", token });
  if (result.status !== "page") throw new Error(`Unexpected resync: ${result.reason}`);
  return result.snapshot;
});
assert.equal((await tinyReader.refresh()).kind, "published");
assert.equal(tinyCalls, 1025, "1,024 continuation tokens plus the initial page are all readable");
assert.equal(tinyReader.getState().projection.rows.length, 1025);
tinyReader.dispose();
tinyStore.dispose();
client.invalidateCommandCenterObservationContext(tinyContext);

// Documented cross-module limits must stay composed, not just individually bounded.
const clientLimits = client.COMMAND_CENTER_MONITOR_READER_LIMITS;
const summaryLimits = client.COMMAND_CENTER_MONITOR_SUMMARY_LIMITS;
assert.equal(hostLimits.maxTokens + 1, clientLimits.maxPages,
  "The Host token ceiling plus the initial page must equal the client page ceiling");
assert.ok(hostLimits.pageRows <= sharedApi.COMMAND_CENTER_MAX_SUMMARY_PAGE_ROWS,
  "The Host page row cap may not exceed the C1 contract page size");
assert.ok(hostLimits.pageBytes <= sharedApi.COMMAND_CENTER_MAX_SUMMARY_PAGE_BYTES,
  "The Host page byte cap may not exceed the C1 contract page bytes");
assert.equal(clientLimits.maxRows, hostLimits.maxRows);
assert.equal(summaryLimits.maxRows, hostLimits.maxRows);
assert.equal(summaryLimits.maxBytes, hostLimits.maxBytes);
assert.equal(clientLimits.maxPendingLoads, 2);
assert.equal(client.COMMAND_CENTER_HEALTH_PROBE_INTERVAL_MS, 2_000);
assert.equal(client.COMMAND_CENTER_HEALTH_STALE_AFTER_MS, 6_000);
assert.ok(clientLimits.maxPages >= 100, "At least 100 pages are needed for 10,000 rows at the 100-row page cap");

await checkConnectionHealthConsumer(client, {
  hostId: control.request.hostId, expectedHostEpoch: control.request.expectedHostEpoch,
}, (await json("command-center-summary.json")).snapshot);
await checkMonitorSessionConsumer(client, {
  hostId: control.request.hostId, expectedHostEpoch: control.request.expectedHostEpoch,
}, (await json("command-center-summary.json")).snapshot, MonitorSnapshotStore);
console.log(JSON.stringify({ status: "PASS", inputs: built ? "package-artifacts" : "current-source", checks: ["host-public-snapshot-pagination", "snapshot-isolation-expiry", "browser-target-bundle", "browser-realm-receipt-sequence", "auth-context-invalidation", "host-browser-multipage-join", "expired-page-without-retry", "connection-health-suspend-resync", "live-change-application", "host-reader-page-ceiling-composition", "monitor-session-composition", "documented-limit-composition"], liveProductQualification: false }));
