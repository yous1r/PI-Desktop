import { isPromise } from "node:util/types";
import type { AgentHost } from "@pi-desktop/agent-host";
import { inspectOwnerHandoff, type InflightCheckpointer, type OwnerInspectionBinding } from "@pi-desktop/host-runtime";
import { type OwnerHandoffInventory, OwnerHandoffInventorySchema } from "@pi-desktop/shared";
import * as Value from "typebox/value";
import type { AgentSidecar } from "../agent-sidecar";
import type { RemoteHostsBoot } from "../bootstrap/remote-hosts";
import type { BrowserHost } from "../browser-host";
import type { McpOAuthManager } from "../mcp-oauth";
import type { PersistenceOutbox } from "../persistence-outbox";
import type { PluginRuntime } from "../plugin-runtime";
import type { SpeechService } from "../services/speech-service";
import type { WorkspaceTerminalRegistry } from "../terminal/workspace-terminal-registry";
import type { UserMcpRuntime } from "../user-mcp";
import type { createEventPersistence } from "./event-persistence";
import type { DesktopHandoffAdmission } from "./handoff-admission";
import type { ModeRunCoordinator } from "./mode-runs";
import type { PlanRuntime } from "./plans";
import type { createScheduledRunner } from "./scheduled-runner";
import type { SessionCoordination } from "./session-coordination";

type ActivityOwner<T extends { getHandoffActivity: unknown }> = Pick<T, "getHandoffActivity">;
export type DesktopHandoffSources = {
  binding: OwnerInspectionBinding & { sidecar: Pick<AgentSidecar, "captureHostBinding" |
    "getExtensionOwnerActivity" | "getExtensionWorkspaceProcessActivity" | "getExtensionServiceActivity"> };
  admission: Pick<DesktopHandoffAdmission, "inFlightCount">;
  agentHost: Pick<AgentHost, "handoffBusyCounts">;
  plans: Pick<PlanRuntime, "inFlightCount">;
  modes: ActivityOwner<ModeRunCoordinator>;
  coordination: ActivityOwner<SessionCoordination>;
  events: ActivityOwner<ReturnType<typeof createEventPersistence>>;
  outbox: ActivityOwner<PersistenceOutbox>;
  checkpointer: ActivityOwner<InflightCheckpointer>;
  scheduler: Pick<ReturnType<typeof createScheduledRunner>, "inFlightCount">;
  scheduledRuns: ReadonlyMap<string, string>;
  activeTurns: ReadonlyMap<string, string>;
  activeTools: ReadonlyMap<string, unknown>;
  plugins: ActivityOwner<PluginRuntime>;
  remote: ActivityOwner<RemoteHostsBoot>;
  browser: ActivityOwner<BrowserHost>;
  terminals: ActivityOwner<WorkspaceTerminalRegistry>;
  userMcp: ActivityOwner<UserMcpRuntime>;
  mcpOAuth: ActivityOwner<McpOAuthManager>;
  speech: ActivityOwner<SpeechService>;
};

/** These are actual uncovered producers, not caller-supplied qualification flags.
 * Remove a gap only with its production owner/admission/native proof wired here.
 * Voice remains paused; reading other owners must not initialize its runtime. */
export const DESKTOP_HANDOFF_UNQUALIFIED_SOURCES = Object.freeze([
  "rust-background-admission", "native-resources-outside-execution-generation",
  "updater", "model-catalog", "vendor-oauth", "mcp-control", "personal-todos",
  "electron-surfaces-and-listeners", "worker-execution-classification", "voice-and-live-voice",
] as const);

const sourceKeys = ["admission", "agentHost", "plans", "modes", "coordination", "events", "outbox", "checkpointer",
  "scheduler", "scheduledRuns", "activeTurns", "activeTools", "plugins", "remote", "browser", "terminals", "userMcp", "mcpOAuth", "speech"] as const;
const externalKeys = ["operations", "resources", "uncontainedResources"] as const;
const writesKeys = ["writes", "uncontainedResources"] as const;
function failure(errorCode: string, source?: string): Error {
  return Object.assign(new Error(errorCode), { errorCode, source });
}
function unavailable(source: string): Error { return failure("HANDOFF_INVENTORY_UNAVAILABLE", source); }
function count(value: unknown, source: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw unavailable(source);
  return value;
}
function sum(...values: number[]): number {
  return values.reduce((total, value) => count(total + count(value, "sum"), "sum"), 0);
}
function read<T>(source: string, action: () => T): T {
  try { return action(); }
  catch { throw unavailable(source); }
}
/** Copy only data properties. Promises, accessors, missing/extra fields and
 * non-safe integers cannot silently become an idle source. */
function report<K extends string>(source: string, action: () => unknown, keys: readonly K[]): Record<K, number> {
  return read(source, () => {
    const value = action();
    if (isPromise(value)) {
      // Observe invalid async work without accepting late evidence or extending
      // this sample. The caller still receives a classified source refusal.
      void Promise.prototype.then.call(value, undefined, () => undefined);
      throw unavailable(source);
    }
    if (!value || typeof value !== "object" || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length) {
      throw unavailable(source);
    }
    return Object.fromEntries(keys.map(key => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !("value" in property)) throw unavailable(source);
      return [key, count(property.value, source)];
    })) as Record<K, number>;
  });
}
function size(source: string, map: ReadonlyMap<string, unknown>): number {
  return read(source, () => count(map.size, source));
}

/** Read original Rust authority, then synchronously sample current Desktop
 * owners. This is a conservative obstruction inventory, never an execution
 * capacity total, an admission hold, or native closure certification.
 * OwnerHandoffCoordinator separately merges the Sidecar protocol report. */
export async function inspectDesktopHandoff(current: () => DesktopHandoffSources | null): Promise<OwnerHandoffInventory> {
  const initial = current();
  if (!initial?.binding) throw failure("HANDOFF_OWNER_UNAVAILABLE");
  const sources = { ...initial }, binding = { ...initial.binding };
  for (const key of sourceKeys) if (!sources[key]) throw unavailable(key);
  if (!binding.host || !binding.sidecar) throw failure("HANDOFF_OWNER_UNAVAILABLE");
  const hostGeneration = binding.host.generation;
  const sidecarCurrent = read("sidecar", () => binding.sidecar.captureHostBinding(binding.host));
  const assertCurrent = () => {
    const live = current(), owner = live?.binding;
    if (!live || !owner || owner.host !== binding.host || owner.sidecar !== binding.sidecar ||
        owner.sourceEpoch !== binding.sourceEpoch || owner.profileId !== binding.profileId || owner.generation !== binding.generation ||
        binding.host.generation !== hostGeneration || !binding.host.isAvailable() || !sidecarCurrent() ||
        sourceKeys.some(key => live[key] !== sources[key])) throw failure("HANDOFF_OWNER_CHANGED");
  };
  assertCurrent();
  try {
    const rust = await inspectOwnerHandoff(() => { assertCurrent(); return binding; });
    assertCurrent();
    if (rust.native.state !== "running" || rust.native.confirmed || rust.native.rootExited || rust.native.activeProcesses < 1) {
      throw failure("HANDOFF_OWNER_CHANGED");
    }
    const agent = report("agentHost", () => sources.agentHost.handoffBusyCounts(), ["turns", "queuedTurns", "admissions", "approvals", "inputs"]);
    const modes = report("modes", () => sources.modes.getHandoffActivity(), ["operations", "turns", "queuedTurns", "uncontainedResources"]);
    const coordination = report("coordination", () => sources.coordination.getHandoffActivity(), ["admissions", "finalizations", "writes", "uncontainedResources"]);
    const events = report("events", () => sources.events.getHandoffActivity(), ["finalizations", "writes", "uncontainedResources"]);
    const outbox = report("outbox", () => sources.outbox.getHandoffActivity(), writesKeys);
    const checkpoint = report("checkpointer", () => sources.checkpointer.getHandoffActivity(), writesKeys);
    const plugins = report("plugins", () => sources.plugins.getHandoffActivity(), ["operations", "plugins", "schedules", "uncontainedResources"]);
    const remote = report("remote", () => sources.remote.getHandoffActivity(), externalKeys);
    const browser = report("browser", () => sources.browser.getHandoffActivity(), ["operations", "pages", "uncontainedResources"]);
    const terminals = report("terminals", () => sources.terminals.getHandoffActivity(), ["terminals", "uncontainedResources"]);
    const userMcp = report("userMcp", () => sources.userMcp.getHandoffActivity(), ["mcp", "uncontainedResources"]);
    const oauth = report("mcpOAuth", () => sources.mcpOAuth.getHandoffActivity(), externalKeys);
    const speech = report("speech", () => sources.speech.getHandoffActivity(), externalKeys);
    const extensions = report("sidecar.extensions", () => binding.sidecar.getExtensionOwnerActivity(), ["operations", "runtimes", "uncontainedResources"]);
    const processes = report("sidecar.processes", () => binding.sidecar.getExtensionWorkspaceProcessActivity(), ["operations", "processes", "uncontainedResources"]);
    const services = report("sidecar.services", () => binding.sidecar.getExtensionServiceActivity(), ["operations", "inputs", "uncontainedResources"]);
    const admissions = read("admission", () => count(sources.admission.inFlightCount(), "admission"));
    const plans = read("plans", () => count(sources.plans.inFlightCount(), "plans"));
    const schedules = read("scheduler", () => count(sources.scheduler.inFlightCount(), "scheduler"));
    const durable = rust.durable, runtime = rust.runtime, activity = rust.activity;
    const result: OwnerHandoffInventory = {
      clients: sum(remote.resources, Number(runtime.remoteExecutions)),
      turns: sum(agent.turns, modes.turns, size("activeTurns", sources.activeTurns), Number(durable.turns)),
      queuedTurns: sum(agent.queuedTurns, modes.queuedTurns, Number(durable.queuedTurns)),
      plans: sum(plans, Number(durable.plans), Number(durable.modeClaims), Number(durable.modeWaits)),
      tools: sum(size("activeTools", sources.activeTools), Number(runtime.tools)),
      processes: sum(processes.processes, Number(runtime.backgroundProcesses)),
      terminals: terminals.terminals,
      plugins: sum(plugins.plugins, extensions.runtimes, Number(runtime.pluginExecutions)),
      admissions: sum(admissions, agent.admissions, modes.operations, coordination.admissions,
        plugins.operations, remote.operations, browser.operations, oauth.operations, speech.operations,
        extensions.operations, processes.operations, services.operations, activity.requests, activity.backgroundTasks, Number(durable.worktrees)),
      // Event and coordination finalizations can overlap; both retain work the
      // other cannot see. Their sum is an obligation bound, not turn occupancy.
      finalizations: sum(coordination.finalizations, events.finalizations),
      writes: sum(coordination.writes, events.writes, outbox.writes, checkpoint.writes, activity.writes),
      // The coordinator merges Sidecar children/native sessions. Independent
      // Worker classification and other native families remain unqualified.
      children: 0, workers: 0, nativeSessions: 0,
      schedules: sum(schedules, size("scheduledRuns", sources.scheduledRuns), plugins.schedules, Number(durable.scheduledRuns), Number(runtime.configSync)),
      approvals: sum(agent.approvals, Number(durable.approvals), Number(runtime.permissions)),
      inputs: sum(agent.inputs, services.inputs),
      mcp: sum(userMcp.mcp, oauth.resources),
      uncontainedResources: sum(DESKTOP_HANDOFF_UNQUALIFIED_SOURCES.length, Number(activity.uncertain),
        ...[modes, coordination, events, outbox, checkpoint, plugins, remote, browser, terminals, userMcp, oauth, speech,
          extensions, processes, services].map(value => value.uncontainedResources), browser.pages, speech.resources),
    };
    if (!Value.Check(OwnerHandoffInventorySchema, result)) throw unavailable("inventory");
    return result;
  } finally { assertCurrent(); }
}
