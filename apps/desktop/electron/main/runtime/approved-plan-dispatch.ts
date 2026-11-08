import { executionFromResponse, executionListFromResponse, planExecutionFromUnknown } from "@pi-desktop/host-runtime";
import { ErrorCodes, type PlanExecution, type PlanExecutionFinishStatus } from "@pi-desktop/shared";
import type { RuntimeState } from "./context";
import type { FinishTurn, PlanRuntimeDependencies } from "./plans";

type Dependencies = Pick<PlanRuntimeDependencies,
  "runtimeState" | "planState" | "logger" | "coordination" | "planSubmissionTurnIds" |
  "approvedExecutionIdsBySession" | "claimedExecutionSessions" | "approvedExecutionTurns" |
  "startedApprovedExecutions" | "finishedApprovedExecutions" | "dispatchingApprovedExecutions" |
  "pendingExecutionFinishes" | "inFlightExecutionFinishes" | "acquireSessionOperation" |
  "resolveAgentRuntimeLaunch" | "isQuitting"
> & { finishTurn: FinishTurn };

type Binding = {
  host: NonNullable<RuntimeState["host"]>;
  sidecar: NonNullable<RuntimeState["sidecar"]>;
  bridge: RuntimeState["agentHostBridge"];
  generation: string;
};
type ExecutionOwner = Binding & {
  sessionId: string;
  turnId?: string;
  turnSettled: boolean;
  uncertain: boolean;
};

/** Owns local admission and cleanup of existing Rust execution records. These
 * bindings are process references, never a second durable execution ledger. */
export function createApprovedPlanDispatcher({
  runtimeState, planState, logger, coordination, planSubmissionTurnIds,
  approvedExecutionIdsBySession, claimedExecutionSessions, approvedExecutionTurns,
  startedApprovedExecutions, finishedApprovedExecutions, dispatchingApprovedExecutions,
  pendingExecutionFinishes, inFlightExecutionFinishes, acquireSessionOperation,
  resolveAgentRuntimeLaunch, isQuitting, finishTurn,
}: Dependencies) {
  const { activeTurns, activeTurnUsages, waitForTurnSettlement, planSubmissionTurnKey } = coordination;
  const admission = runtimeState.handoffAdmission;
  const owners = new Map<string, ExecutionOwner>();
  const retries = new Map<string, ReturnType<typeof setTimeout>>();
  const finishes = new Map<string, Promise<void>>();
  let queries = 0;
  let disposed = false;
  const blocked = () => disposed || isQuitting() || admission.isClosed();
  const capture = (): Binding | undefined => {
    const { host, sidecar, agentHostBridge: bridge } = runtimeState;
    return host && sidecar ? { host, sidecar, bridge, generation: host.generation } : undefined;
  };
  const current = (binding: Binding) => !blocked() && runtimeState.host === binding.host &&
    runtimeState.sidecar === binding.sidecar && binding.host.generation === binding.generation;
  const requireCurrent = (binding: Binding, executionId: string) => {
    if (!current(binding) || pendingExecutionFinishes.has(executionId) || finishedApprovedExecutions.has(executionId)) {
      throw Object.assign(new Error("approved plan admission or execution ended"), {
      errorCode: ErrorCodes.PLAN_EXECUTION_INTERRUPTED,
    });
    }
  };

  function releaseOwner(executionId: string): void {
    const owner = owners.get(executionId);
    if (!owner || owner.uncertain || (owner.turnId && !owner.turnSettled) ||
        !finishedApprovedExecutions.has(executionId) || dispatchingApprovedExecutions.has(executionId)) return;
    if (approvedExecutionIdsBySession.get(owner.sessionId) === executionId) approvedExecutionIdsBySession.delete(owner.sessionId);
    approvedExecutionTurns.delete(executionId);
    claimedExecutionSessions.delete(executionId);
    owners.delete(executionId);
  }

  function turnOwner(sessionId: string, turnId: string): ExecutionOwner | undefined {
    return [...owners.values()].find(owner => owner.sessionId === sessionId && owner.turnId === turnId);
  }

  function confirmTurnSettlement(sessionId: string, turnId: string): void {
    for (const [id, owner] of owners) {
      if (owner.sessionId !== sessionId || owner.turnId !== turnId) continue;
      owner.turnSettled = true;
      releaseOwner(id);
    }
  }

  function finishApprovedExecution(executionId: string, status: PlanExecutionFinishStatus, errorCode?: string): Promise<void> {
    if (finishedApprovedExecutions.has(executionId)) return Promise.resolve();
    const existing = finishes.get(executionId);
    if (existing) return existing;
    if (!pendingExecutionFinishes.has(executionId)) pendingExecutionFinishes.set(executionId, { status, errorCode });
    // Missing ownership cannot be repaired by borrowing a replacement Host.
    const owner = owners.get(executionId);
    if (!owner) return Promise.resolve();
    inFlightExecutionFinishes.add(executionId);
    const completion = Promise.resolve().then(async () => {
      try {
        const pending = pendingExecutionFinishes.get(executionId) ?? { status, errorCode };
        const response = await owner.host.call("plans.finishExecution", {
          executionId, status: pending.status, ...(pending.errorCode ? { errorCode: pending.errorCode } : {}),
        });
        const finished = executionFromResponse(response);
        if (!finished || finished.id !== executionId || finished.sessionId !== owner.sessionId || finished.state !== pending.status) {
          throw new Error("approved plan finalization was not acknowledged");
        }
        finishedApprovedExecutions.add(executionId);
        startedApprovedExecutions.delete(executionId);
        pendingExecutionFinishes.delete(executionId);
      } catch (error) {
        logger.app("runtime", "warn", "approved plan execution finalization failed", { data: { executionId, error: String(error) } });
      } finally {
        inFlightExecutionFinishes.delete(executionId);
        finishes.delete(executionId);
        releaseOwner(executionId);
      }
    });
    finishes.set(executionId, completion);
    return completion;
  }

  function retry(initial: PlanExecution, binding: Binding): void {
    if (!current(binding) || retries.has(initial.id)) return;
    const timer = setTimeout(() => {
      retries.delete(initial.id);
      if (!current(binding)) return;
      void dispatchApprovedPlan(initial).catch(error => {
        logger.app("runtime", "warn", "approved plan retry failed", { data: { executionId: initial.id, error: String(error) } });
      });
    }, 250);
    timer.unref?.();
    retries.set(initial.id, timer);
  }

  async function closeUnstartedTurn(executionId: string, owner: ExecutionOwner, errorCode: string): Promise<void> {
    try {
      const result = await owner.host.call<{ ok: boolean }>("session.endTurn", {
        turnId: owner.turnId, status: "error", errorCode, createNotification: false,
      });
      if (result?.ok !== true) throw new Error("approved plan turn cleanup was not acknowledged");
      owner.turnSettled = true;
    } catch (error) {
      logger.app("persistence", "warn", "unstarted approved plan turn cleanup failed", { data: { executionId, error: String(error) } });
    }
  }

  async function dispatchApprovedPlan(rawExecution: unknown): Promise<void> {
    if (blocked()) return;
    const initial = planExecutionFromUnknown(rawExecution);
    if (!initial) {
      logger.app("runtime", "warn", "approved plan execution descriptor was invalid");
      return;
    }
    if (initial.state !== "queued" || owners.has(initial.id) || startedApprovedExecutions.has(initial.id) ||
        finishedApprovedExecutions.has(initial.id) || pendingExecutionFinishes.has(initial.id) || dispatchingApprovedExecutions.has(initial.id)) return;
    const binding = capture();
    if (!binding) return;
    const previousRetry = retries.get(initial.id);
    if (previousRetry) clearTimeout(previousRetry);
    retries.delete(initial.id);
    // Register before the first await, including time waiting for the session lock.
    dispatchingApprovedExecutions.add(initial.id);
    try {
      await admission.run(async () => {
        const releaseSessionOperation = await acquireSessionOperation(initial.sessionId);
        let owner: ExecutionOwner | undefined;
        let claimed = false;
        let turnPublished = false;
        try {
          if (!current(binding)) return;
          const activeTurnId = activeTurns.get(initial.sessionId);
          if (activeTurnId && planSubmissionTurnIds.has(planSubmissionTurnKey(initial.sessionId, activeTurnId))) {
            await waitForTurnSettlement(initial.sessionId, activeTurnId);
          }
          if (!current(binding)) return;
          if (activeTurns.has(initial.sessionId)) { retry(initial, binding); return; }
          owner = { ...binding, sessionId: initial.sessionId, turnSettled: false, uncertain: true };
          owners.set(initial.id, owner);
          const response = await binding.host.call("plans.claimExecution", { executionId: initial.id });
          const execution = executionFromResponse(response);
          if (!execution || execution.id !== initial.id || execution.sessionId !== initial.sessionId || execution.state !== "running") {
            throw new Error("approved plan claim was not acknowledged");
          }
          claimed = true;
          owner.uncertain = false;
          claimedExecutionSessions.set(execution.id, execution.sessionId);
          requireCurrent(binding, initial.id);
          // Both reads remain owned even when one fails before its peer settles.
          const [settings, session] = await Promise.allSettled([
            binding.host.call("settings.get"),
            binding.host.call<{ session?: Record<string, unknown> }>("session.get", { id: execution.sessionId }),
          ]);
          requireCurrent(binding, initial.id);
          if (settings.status === "rejected") throw settings.reason;
          if (session.status === "rejected") throw session.reason;
          if (!session.value.session) throw Object.assign(new Error("Session not found"), { errorCode: ErrorCodes.NOT_FOUND });
          const launch = await resolveAgentRuntimeLaunch(execution.sessionId, session.value.session, settings.value, { mode: "agent" });
          requireCurrent(binding, initial.id);
          owner.uncertain = true;
          const turn = await binding.host.call<{ turnId: string }>("session.beginTurn", {
            sessionId: execution.sessionId, providerId: launch.providerId, modelId: launch.modelId,
          });
          const turnId = typeof turn?.turnId === "string" ? turn.turnId.trim() : "";
          if (!turnId) throw new Error("execution turn was not created");
          owner.turnId = turnId;
          owner.uncertain = false;
          requireCurrent(binding, initial.id);
          activeTurns.set(execution.sessionId, turnId);
          coordination.recordTurnStart(execution.sessionId, turnId);
          activeTurnUsages.delete(execution.sessionId);
          approvedExecutionIdsBySession.set(execution.sessionId, execution.id);
          approvedExecutionTurns.set(execution.id, { sessionId: execution.sessionId, turnId });
          startedApprovedExecutions.add(execution.id);
          turnPublished = true;
          owner.uncertain = true;
          const accepted = await binding.sidecar.call<{ accepted: boolean }>("agent.executeApprovedPlan", {
            ...launch.sidecarParams, mode: "agent", turnId, execution,
          });
          if (typeof accepted?.accepted !== "boolean") throw new Error("approved plan acceptance was not acknowledged");
          owner.uncertain = false;
          if (!accepted.accepted) throw new Error("approved plan execution was not accepted");
          logger.app("runtime", "info", "approved plan execution started", {
            sessionId: execution.sessionId, data: { executionId: execution.id, turnId },
          });
        } catch (error) {
          const failure = error as { data?: { errorCode?: string }; errorCode?: string } | null;
          const errorCode = failure?.data?.errorCode || failure?.errorCode || ErrorCodes.PLAN_EXECUTION_INTERRUPTED;
          try {
            if (owner?.turnId) {
              if (turnPublished) await finishTurn(initial.sessionId, "error", errorCode, { turnId: owner.turnId });
              else await closeUnstartedTurn(initial.id, owner, errorCode);
            }
          } finally {
            if (claimed) await finishApprovedExecution(initial.id, "interrupted", errorCode);
          }
          logger.app("runtime", "warn", "approved plan execution failed to start", {
            sessionId: initial.sessionId, data: { executionId: initial.id, error: String(error) },
          });
        } finally { releaseSessionOperation(); }
      });
    } finally {
      dispatchingApprovedExecutions.delete(initial.id);
      releaseOwner(initial.id);
    }
  }

  async function drainApprovedPlanExecutions(): Promise<void> {
    if (blocked()) return;
    if (planState.approvedExecutionDrain) return planState.approvedExecutionDrain;
    const binding = capture();
    if (!binding) return;
    const drain = admission.run(async () => {
      for (const [executionId, finish] of pendingExecutionFinishes) {
        if (!current(binding)) return;
        await finishApprovedExecution(executionId, finish.status, finish.errorCode);
      }
      if (!current(binding)) return;
      const response = await binding.host.call("plans.queuedExecutions");
      for (const execution of executionListFromResponse(response)) {
        if (!current(binding)) return;
        if (execution.state === "queued") await dispatchApprovedPlan(execution);
      }
    });
    planState.approvedExecutionDrain = drain;
    try { await drain; }
    finally { if (planState.approvedExecutionDrain === drain) planState.approvedExecutionDrain = null; }
  }

  async function dispatchExecutionForProposal(proposalId: string): Promise<void> {
    if (blocked()) return;
    const binding = capture();
    if (!binding) return;
    queries += 1;
    try {
      await admission.run(async () => {
        const response = await binding.host.call("plans.queuedExecutions");
        if (!current(binding)) return;
        const execution = executionListFromResponse(response).find(candidate => candidate.proposalId === proposalId);
        if (execution?.state === "queued") await dispatchApprovedPlan(execution);
      });
    } catch (error) {
      logger.app("runtime", "warn", "approved plan lookup after resolution failed", { data: String(error) });
    } finally { queries -= 1; }
  }

  return {
    dispatchApprovedPlan, drainApprovedPlanExecutions, dispatchExecutionForProposal,
    finishApprovedExecution, turnOwner, confirmTurnSettlement,
    inFlightCount: () => new Set([...owners.keys(), ...dispatchingApprovedExecutions, ...startedApprovedExecutions,
      ...inFlightExecutionFinishes, ...pendingExecutionFinishes.keys(), ...retries.keys()]).size + queries +
      (planState.approvedExecutionDrain ? 1 : 0),
    dispose: () => {
      disposed = true;
      for (const timer of retries.values()) clearTimeout(timer);
      retries.clear();
      // Disposal does not prove that a claimed execution or native work ended.
    },
  };
}
