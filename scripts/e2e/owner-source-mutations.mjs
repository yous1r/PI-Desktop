/**
 * Real Desktop composition for the original-source negative path.
 *
 * This helper owns only the Desktop side of one framed `--owner-source`
 * mutation: the production `bindOwnerHandoffExchange` subscription, the real
 * `DesktopHandoffCoordinator`, and the real `inspectDesktopHandoff` inventory.
 * Every non-native Desktop owner is an explicit idle fixture, exactly as in
 * `scripts/e2e/desktop-handoff-inventory.mjs`; the ten declared qualification
 * gaps stay declared. Only the host object handed to production code is a
 * delegating view, so the actual notification and completion RPCs can be
 * observed without replacing the coordinator.
 *
 * Scope: source -> stdio -> Desktop negative only. Nothing here qualifies full
 * Desktop startup, handoff readiness or native closure.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDesktopHandoffService } from "../../apps/desktop/electron/main/runtime/handoff-service.ts";
import { DesktopHandoffAdmission } from "../../apps/desktop/electron/main/runtime/handoff-admission.ts";
import {
  DESKTOP_HANDOFF_UNQUALIFIED_SOURCES,
  inspectDesktopHandoff,
} from "../../apps/desktop/electron/main/runtime/handoff-inventory.ts";
import { PersistenceOutbox } from "../../apps/desktop/electron/main/persistence-outbox.ts";
import { InflightCheckpointer } from "../../packages/host-runtime/src/inflight-checkpoint.ts";

export { DESKTOP_HANDOFF_UNQUALIFIED_SOURCES };
export const OWNER_SOURCE_MUTATION_SCOPE =
  "original Rust source -> authenticated framed stdio -> real Rust exchange -> Desktop coordinator negative path only; no handoff is completed, no native closure is certified and no Sidecar is acquired";

/**
 * @param {object} options
 * @param {import("../../packages/host-runtime/src/host-process.ts").HostProcess} options.host
 * @param {string} options.directory scratch directory for idle Desktop owners
 * @param {{ sourceEpoch: string, profileId: string, generation: string }} options.binding
 */
export function createOwnerSourceDesktop({ host, directory, binding }) {
  const counts = { notifications: 0, completions: 0, sidecarCalls: 0, inspections: 0, inspectionWaits: 0 };
  const notifications = [];
  const completions = [];
  const acks = [];
  let held; // controlled delay for the lost-waiter case; it never invents results

  // The only non-production object here: a delegating view of the real original
  // HostProcess, so the actual notify/completion transport is counted.
  const hostView = {
    get generation() { return host.generation; },
    isAvailable: () => host.isAvailable(),
    call: async (method, params, timeoutMs) => {
      if (method === "ownerHandoff.completeQuiescence") {
        counts.completions += 1;
        completions.push(params);
      }
      if (method === "ownerHandoff.inspect") {
        counts.inspections += 1;
        const waiting = held;
        if (waiting) { counts.inspectionWaits += 1; await waiting.promise; }
      }
      const reply = timeoutMs === undefined ? await host.call(method, params) : await host.call(method, params, timeoutMs);
      // Production validates this ACK itself; retain the raw reply so the test
      // can assert the original Rust owner accepted the completion.
      if (method === "ownerHandoff.completeQuiescence") acks.push(reply);
      return reply;
    },
    onNotification: handler => host.onNotification((method, params) => {
      if (method === "ownerHandoff.quiescence") { counts.notifications += 1; notifications.push(params); }
      handler(method, params);
    }),
    onExit: handler => host.onExit(handler),
  };

  const sidecar = {
    captureHostBinding: owner => () => owner === hostView && hostView.isAvailable(),
    executionStatus: () => hostView.call("executionFence.status", { generation: binding.generation }),
    // The ten declared gaps must refuse before any Sidecar hold is requested.
    call: async () => {
      counts.sidecarCalls += 1;
      assert.fail("an unqualified source must never acquire a Sidecar hold");
    },
    getExtensionOwnerActivity: () => ({ operations: 0, runtimes: 0, uncontainedResources: 0 }),
    getExtensionWorkspaceProcessActivity: () => ({ operations: 0, processes: 0, uncontainedResources: 0 }),
    getExtensionServiceActivity: () => ({ operations: 0, inputs: 0, uncontainedResources: 0 }),
  };
  const admission = new DesktopHandoffAdmission();
  const outbox = new PersistenceOutbox(join(directory, "persistence"), () => undefined);
  const checkpointer = new InflightCheckpointer(async () => undefined);
  const reporter = value => ({ getHandoffActivity: () => ({ ...value }) });
  const external = () => reporter({ operations: 0, resources: 0, uncontainedResources: 0 });
  const sources = {
    binding: { ...binding, host: hostView, sidecar }, admission,
    backends: { retainedSidecars: () => [sidecar], getHandoffActivity: () => ({ operations: 0, retiredSidecars: 0, uncontainedResources: 0 }) },
    agentHost: { handoffBusyCounts: () => ({ turns: 0, queuedTurns: 0, admissions: 0, approvals: 0, inputs: 0 }) },
    plans: { inFlightCount: () => 0 }, modes: reporter({ operations: 0, turns: 0, queuedTurns: 0, uncontainedResources: 0 }),
    coordination: reporter({ admissions: 0, finalizations: 0, writes: 0, uncontainedResources: 0 }),
    events: reporter({ finalizations: 0, writes: 0, uncontainedResources: 0 }), outbox, checkpointer,
    scheduler: { inFlightCount: () => 0 }, scheduledRuns: new Map(), activeTurns: new Map(), activeTools: new Map(),
    plugins: reporter({ operations: 0, plugins: 0, schedules: 0, uncontainedResources: 0 }), remote: external(),
    browser: reporter({ operations: 0, pages: 0, uncontainedResources: 0 }),
    terminals: reporter({ terminals: 0, uncontainedResources: 0 }), userMcp: reporter({ mcp: 0, uncontainedResources: 0 }),
    mcpOAuth: external(), speech: external(),
    modelCatalog: external(), updater: external(), mcpControl: external(),
    vendorOAuth: external(), personalTodos: external(), collaboration: external(),
    surfaces: external(),
  };
  const current = () => ({ ...sources, host: hostView, sidecar });
  const service = createDesktopHandoffService(admission, current, () => hostView);
  service.wireHost(hostView);

  return {
    counts, notifications, completions, acks, admission, sources,
    /** Real inventory sample through the production inspector. */
    inspect: () => inspectDesktopHandoff(current),
    /** Real gate probe: the production admission may not hand out a hold. */
    async probeGate() {
      try {
        const hold = await admission.gate.acquireHandoff(randomUUID(), () => inspectDesktopHandoff(current));
        hold.cancel();
        return "ACQUIRED";
      } catch (error) {
        return error?.code ?? error?.errorCode ?? "UNKNOWN";
      }
    },
    /** Delay every later real inventory RPC; used only by the lost-waiter case. */
    deferInspection() {
      if (held) throw new Error("inspection is already deferred");
      held = Promise.withResolvers();
    },
    releaseInspection() {
      const waiting = held;
      held = undefined;
      waiting?.resolve();
    },
    dispose() {
      try { service.dispose(); } finally {
        admission.dispose();
        checkpointer.dispose();
      }
    },
  };
}
