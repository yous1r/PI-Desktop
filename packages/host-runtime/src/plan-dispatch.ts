import { ErrorCodes, type PlanExecution, type PlanExecutionFinishStatus } from "@pi-desktop/shared";

import type { HostRpc } from "./host-ports.js";
import type { LaunchResolver } from "./launch-resolver.js";
import { executionFromResponse, executionListFromResponse, planExecutionFromUnknown } from "./plan-execution.js";
import type { RuntimeLogger, RuntimeService, RuntimeSidecarLink } from "./runtime-service.js";

export type PlanExecutionDispatcherOptions = {
  getHost: () => HostRpc | null;
  getSidecar: () => RuntimeSidecarLink | null;
  launch: LaunchResolver;
  runtime: Pick<RuntimeService, "withSessionOperation" | "beginTurn" | "finishTurn" | "activeTurnId" | "onTurnEnded">;
  log: RuntimeLogger;
  sleep?: (ms: number) => Promise<void>;
  /** Maintenance admission; a closed gate never claims or starts a plan execution. */
  gate?: { isClosed(): boolean };
};

/**
 * Approved Plan/Goal executions on a headless Host (D189). host-core owns the
 * approval row and its execution state; this dispatcher claims a queued
 * execution, opens the turn that runs it, hands it to the sidecar, and closes
 * the execution when that turn ends. Nothing is replayed: a row the host
 * already reports as running belongs to a previous process.
 */
export class PlanExecutionDispatcher {
  private readonly approvedExecutionIdsBySession = new Map<string, string>();
  private readonly executionTurns = new Map<string, { sessionId: string; turnId: string }>();
  private readonly started = new Set<string>();
  private readonly finished = new Set<string>();
  private readonly dispatching = new Set<string>();
  private readonly inFlightFinishes = new Set<string>();
  private readonly pendingFinishes = new Map<string, { status: PlanExecutionFinishStatus; errorCode?: string }>();
  private drain: Promise<void> | null = null;
  private readonly detach: () => void;
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(private readonly options: PlanExecutionDispatcherOptions) {
    this.detach = options.runtime.onTurnEnded((info) => {
      const executionId = this.approvedExecutionIdsBySession.get(info.sessionId);
      if (!executionId) return;
      const turn = this.executionTurns.get(executionId);
      if (turn?.turnId !== info.turnId) return;
      void this.finishApprovedExecution(
        executionId,
        info.reason === "completed" ? "completed" : "interrupted",
        info.reason === "completed" ? undefined : info.errorCode ?? "PLAN_EXECUTION_INTERRUPTED",
      );
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.detach();
  }

  /** The execution a session is currently running, if any. */
  executionForSession(sessionId: string): string | undefined {
    return this.approvedExecutionIdsBySession.get(sessionId);
  }

  /** Work including lock waiters, retry timers and unacknowledged finalization. */
  inFlightCount(): number {
    return new Set([...this.dispatching, ...this.started, ...this.inFlightFinishes,
      ...this.pendingFinishes.keys(), ...this.retryTimers.keys()]).size + (this.drain ? 1 : 0);
  }

  async finishApprovedExecution(
    executionId: string,
    status: PlanExecutionFinishStatus,
    errorCode?: string,
  ): Promise<void> {
    if (this.finished.has(executionId) || this.inFlightFinishes.has(executionId)) return;
    if (!this.pendingFinishes.has(executionId)) this.pendingFinishes.set(executionId, { status, errorCode });
    this.inFlightFinishes.add(executionId);
    const host = this.options.getHost();
    if (!host) {
      this.inFlightFinishes.delete(executionId);
      return;
    }
    try {
      const pending = this.pendingFinishes.get(executionId) ?? { status, errorCode };
      await host.call("plans.finishExecution", {
        executionId,
        status: pending.status,
        ...(pending.errorCode ? { errorCode: pending.errorCode } : {}),
      });
      this.finished.add(executionId);
      this.started.delete(executionId);
      this.pendingFinishes.delete(executionId);
      const turn = this.executionTurns.get(executionId);
      if (turn && this.approvedExecutionIdsBySession.get(turn.sessionId) === executionId) {
        this.approvedExecutionIdsBySession.delete(turn.sessionId);
      }
      this.executionTurns.delete(executionId);
    } catch (error) {
      this.options.log("warn", "approved plan execution finalization failed", { executionId, error: String(error) });
    } finally {
      this.inFlightFinishes.delete(executionId);
    }
  }

  async dispatchApprovedPlan(rawExecution: unknown): Promise<void> {
    if (this.disposed || this.options.gate?.isClosed()) return;
    const initial = planExecutionFromUnknown(rawExecution);
    if (!initial) {
      this.options.log("warn", "approved plan execution descriptor was invalid");
      return;
    }
    if (initial.state !== "queued" || this.started.has(initial.id) ||
        this.finished.has(initial.id) || this.dispatching.has(initial.id)) return;
    // Own the admission before waiting on another session operation.
    this.dispatching.add(initial.id);
    await this.options.runtime.withSessionOperation(initial.sessionId, async () => {
      if (
        this.disposed || this.options.gate?.isClosed() ||
        this.started.has(initial.id) || this.finished.has(initial.id)
      ) {
        return;
      }
      const host = this.options.getHost();
      const sidecar = this.options.getSidecar();
      if (!host || !sidecar) return;
      if (this.options.runtime.activeTurnId(initial.sessionId)) {
        // The submitting turn is still finalizing; look again shortly.
        if (!this.retryTimers.has(initial.id)) {
          const timer = setTimeout(() => {
            this.retryTimers.delete(initial.id);
            void this.dispatchApprovedPlan(initial).catch((error: unknown) => {
              this.options.log("warn", "approved plan retry failed", { executionId: initial.id, error: String(error) });
            });
          }, 250);
          timer.unref?.();
          this.retryTimers.set(initial.id, timer);
        }
        return;
      }
      let claimed = false;
      let turnId: string | undefined;
      try {
        const claimResponse = await host.call("plans.claimExecution", { executionId: initial.id });
        const claimedExecution = executionFromResponse(claimResponse);
        if (claimedExecution && claimedExecution.state !== "running") {
          // Interrupted or completed rows are durable outcomes, never replayed.
          return;
        }
        const execution: PlanExecution = { ...(claimedExecution ?? initial), state: "running" };
        claimed = true;
        const [settings, sessionResult] = await Promise.all([
          host.call<Record<string, unknown>>("settings.get"),
          host.call<{ session?: Record<string, unknown> | null }>("session.get", { id: execution.sessionId }),
        ]);
        if (!sessionResult.session) {
          throw Object.assign(new Error("Session not found"), { errorCode: ErrorCodes.NOT_FOUND });
        }
        const launch = await this.options.launch.resolve(execution.sessionId, sessionResult.session, settings ?? {}, {
          mode: "agent",
        });
        // Already admitted work stays counted until dispatch/finalization ends.
        // A concurrent idle inspection must refuse; do not strand a claimed row.
        if (this.disposed) throw Object.assign(new Error("plan dispatcher disposed"), { errorCode: "HOST_UNAVAILABLE" });
        turnId = await this.options.runtime.beginTurn(execution.sessionId, launch.providerId, launch.modelId);
        if (this.disposed) throw Object.assign(new Error("plan dispatcher disposed"), { errorCode: "HOST_UNAVAILABLE" });
        this.approvedExecutionIdsBySession.set(execution.sessionId, execution.id);
        this.executionTurns.set(execution.id, { sessionId: execution.sessionId, turnId });
        this.started.add(execution.id);
        sidecar.setProjectInstructionRoot(execution.sessionId, launch.projectPath);
        const accepted = await sidecar.call<{ accepted: boolean }>("agent.executeApprovedPlan", {
          ...launch.sidecarParams,
          mode: "agent",
          turnId,
          execution,
        });
        if (accepted?.accepted !== true) throw new Error("approved plan execution was not accepted");
        this.options.log("info", "approved plan execution started", {
          sessionId: execution.sessionId,
          executionId: execution.id,
          turnId,
        });
      } catch (error) {
        const errorCode =
          (error as { data?: { errorCode?: string } })?.data?.errorCode ||
          (error as { errorCode?: string })?.errorCode ||
          "PLAN_EXECUTION_INTERRUPTED";
        if (turnId) await this.options.runtime.finishTurn(initial.sessionId, "error", errorCode, { turnId });
        if (claimed) await this.finishApprovedExecution(initial.id, "interrupted", errorCode);
        this.options.log("warn", "approved plan execution failed to start", {
          sessionId: initial.sessionId,
          executionId: initial.id,
          error: String(error),
        });
      }
    }).finally(() => this.dispatching.delete(initial.id));
  }

  /** Dispatch every queued execution the host restored, once, on boot or after a restart. */
  async drainApprovedPlanExecutions(): Promise<void> {
    if (this.disposed || this.options.gate?.isClosed()) return;
    if (this.drain) return this.drain;
    this.drain = (async () => {
      const host = this.options.getHost();
      if (!host || !this.options.getSidecar()) return;
      for (const [executionId, finish] of this.pendingFinishes) {
        await this.finishApprovedExecution(executionId, finish.status, finish.errorCode);
      }
      const response = await host.call("plans.queuedExecutions");
      for (const execution of executionListFromResponse(response)) {
        if (execution.state !== "queued") continue;
        await this.dispatchApprovedPlan(execution);
      }
    })();
    try {
      await this.drain;
    } finally {
      this.drain = null;
    }
  }

  /** After an approval resolved, run the execution it produced. */
  async dispatchExecutionForProposal(proposalId: string): Promise<void> {
    if (this.disposed || this.options.gate?.isClosed()) return;
    const host = this.options.getHost();
    if (!host) return;
    try {
      const response = await host.call("plans.queuedExecutions");
      const execution = executionListFromResponse(response).find((candidate) => candidate.proposalId === proposalId);
      if (execution?.state === "queued") await this.dispatchApprovedPlan(execution);
    } catch (error) {
      this.options.log("warn", "approved plan lookup after resolution failed", { proposalId, error: String(error) });
    }
  }
}
