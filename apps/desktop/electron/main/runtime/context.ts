import type { AgentHostBridge } from "../agent-host-bridge";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import type { DesktopHandoffAdmission } from "./handoff-admission";

/** Mutable process handles shared by the runtime adapters and lifecycle code. */
export type RuntimeState = {
  readonly handoffAdmission: DesktopHandoffAdmission;
  host: HostProcess | null;
  sidecar: AgentSidecar | null;
  agentHostBridge: AgentHostBridge | null;
};
