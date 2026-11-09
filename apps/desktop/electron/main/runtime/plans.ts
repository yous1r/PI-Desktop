import { modeContinuationSettlementOwner } from "./mode-continuation-owner";
import { IPC, type AgentEventEnvelope, type AppNotification, type MessageUsage, type PlanExecutionFinishStatus, type UiMessage } from "@pi-desktop/shared";
import { createApprovedPlanDispatcher } from "./approved-plan-dispatch";
import type { RuntimeState } from "./context";
import type {
  SessionCoordination,
  TurnEndedPayload,
  TurnEndReason,
} from "./session-coordination";

/**
 * Identity and per-call switches of one turn finalization. `turnId` is
 * required: a terminal event, an abort, a crash or a failed start must name the
 * turn it belongs to, and the finalizer never infers it from whichever turn
 * happens to be active.
 */
export type FinishTurnOptions = {
  turnId: string;
  createNotification?: boolean;
  recoverInflight?: boolean;
};

/**
 * The single entry point every terminal path funnels through, so exactly one
 * announcement is made per host turn and the turn's state is released once.
 */
export type FinishTurn = (
  sessionId: string,
  status: TurnEndReason,
  errorCode: string | undefined,
  options: FinishTurnOptions,
) => Promise<void>;

export type PlanRuntimeState = {
  approvedExecutionDrain: Promise<void> | null;
};

export type PlanRuntimeDependencies = {
  runtimeState: RuntimeState;
  planState: PlanRuntimeState;
  logger: { app: (...args: any[]) => void };
  sendToRenderer: (channel: string, payload: unknown) => void;
  /**
   * The single turn coordination instance: active turns, their usage, the
   * finalization records, the abort locks and the identity queries all come
   * from here, so this module never keeps a second copy of that state.
   */
  coordination: SessionCoordination;
  scheduledRunsBySession: Map<string, string>;
  activeToolCalls: Map<string, any>;
  planSubmissionTurnIds: Set<string>;
  approvedExecutionIdsBySession: Map<string, string>;
  claimedExecutionSessions: Map<string, string>;
  approvedExecutionTurns: Map<string, any>;
  startedApprovedExecutions: Set<string>;
  finishedApprovedExecutions: Set<string>;
  dispatchingApprovedExecutions: Set<string>;
  inFlightExecutionFinishes: Set<string>;
  pendingExecutionFinishes: Map<string, any>;
  /**
   * Announce a finished turn to the plugin surfaces. Composed by the plugin
   * services factory; this module never reaches a global plugin instance.
   */
  announceTurnEnded: (payload: TurnEndedPayload) => void;
  emitAgentEvent: (envelope: AgentEventEnvelope) => void;
  acquireSessionOperation: (sessionId: string) => Promise<() => void>;
  resolveAgentRuntimeLaunch: (...args: any[]) => Promise<any>;
  isQuitting: () => boolean;
  onTurnSettled?: (sessionId: string, turnId: string) => Promise<void>;
  /**
   * Every finalized turn, whether or not its durable end persisted. Mode runs
   * release their claim here so a failed persistence cannot strand a run.
   */
  onTurnEnded?: (sessionId: string, turnId: string, end: { reason: TurnEndReason; usage?: MessageUsage; errorCode?: string }) => Promise<void>;
};

export function createPlanRuntime({
  runtimeState,
  planState,
  logger,
  sendToRenderer,
  coordination,
  scheduledRunsBySession,
  activeToolCalls,
  planSubmissionTurnIds,
  approvedExecutionIdsBySession,
  claimedExecutionSessions,
  approvedExecutionTurns,
  startedApprovedExecutions,
  finishedApprovedExecutions,
  dispatchingApprovedExecutions,
  inFlightExecutionFinishes,
  pendingExecutionFinishes,
  announceTurnEnded,
  emitAgentEvent,
  acquireSessionOperation,
  resolveAgentRuntimeLaunch,
  isQuitting,
  onTurnSettled,
  onTurnEnded,
}: PlanRuntimeDependencies): {
  finishTurn: FinishTurn;
  finishApprovedExecution: (executionId: string, status: PlanExecutionFinishStatus, errorCode?: string) => Promise<void>;
  dispatchApprovedPlan: (rawExecution: unknown) => Promise<void>;
  drainApprovedPlanExecutions: () => Promise<void>;
  dispatchExecutionForProposal: (proposalId: string) => Promise<void>;
  inFlightCount: () => number;
  dispose: () => void;
} {
// Read the shared turn state once, by the names the finalizer below uses. The
// instance is owned by the coordination factory; this module only reads it.
const {
  activeTurns,
  activeTurnUsages,
  turnFinalizations,
  turnSettlements,
  planSubmissionTurnKey,
  shouldCreateTaskNotification,
  isActiveTurn,
  peekAbortReason,
  clearAbortReason,
  releaseTurnClaims,
} = coordination;
/** The Agent Host turn state for one settled turn. */
function hostTurnStatus(
  reason: TurnEndReason,
): "completed" | "failed" | "interrupted" {
  if (reason === "aborted") return "interrupted";
  return reason === "error" ? "failed" : "completed";
}

/**
 * The error a settled failing turn carries into Agent Host. The terminal event
 * owns the real message; this path only runs when that event never landed, so the
 * code the settlement recorded is the best available description.
 */
function hostTurnError(
  reason: TurnEndReason,
  errorCode: string | undefined,
): { code: string; message: string; retriable: boolean; traceId: string } | undefined {
  if (reason !== "error") return undefined;
  const code = errorCode ?? "TURN_ERROR";
  return { code, message: code, retriable: false, traceId: "" };
}

/**
 * Settle one host turn: attempt its durable end, release its local state,
 * announce it to the plugin surfaces, then release the claim.
 *
 * The order is part of the contract. Ownership is claimed and the terminal
 * reason frozen synchronously, before any await, so that a concurrent terminal
 * event joins this finalization instead of starting a second one, and so that a
 * cancellation recorded earlier cannot be restated as a completion later.
 */
function finishTurn(
  sessionId: string,
  status: TurnEndReason,
  errorCode: string | undefined,
  options: FinishTurnOptions,
): Promise<void> {
  const id = sessionId.trim();
  // A missing identity cannot be attributed to any turn, so it settles nothing:
  // inferring it from whichever turn is active would let a late event close a
  // turn it does not own. Callers still persist the event as history.
  const turnId = String(options?.turnId ?? "").trim();
  if (!id || !turnId) return Promise.resolve();
  // Freeze the original execution owner before the deferred finalization body.
  const owner = dispatcher.turnOwner(id, turnId);
  const continuationOwner = modeContinuationSettlementOwner();
  const host = owner?.host ?? continuationOwner?.host ?? runtimeState.host;
  const bridge = owner ? owner.bridge : continuationOwner?.bridge ?? runtimeState.agentHostBridge;

  const finalizationKey = planSubmissionTurnKey(id, turnId);
  // A second call joins the first claim. That is what stops a late abort from
  // restating a completion, and what makes the announcement fire once per turn
  // when both agent_end and error arrive.
  const existing = turnFinalizations.get(finalizationKey);
  if (existing) return existing;
  // A turn that no longer owns its session was already settled by whoever took
  // it over. Recreating a record here would release the newer turn's queue, so
  // the settlement is refused — but this turn can no longer finalize itself
  // either, so its records are dropped rather than left behind: its settlement
  // waiters would never resolve, and a later turn on this session would inherit
  // its cancellation lock.
  if (!isActiveTurn(id, turnId)) {
    planSubmissionTurnIds.delete(finalizationKey);
    releaseTurnClaims(id, turnId);
    return Promise.resolve();
  }

  // Set once the durable end settled, so the collaboration hook below only runs
  // for a turn whose durable row really was closed.
  let settledTurnId: string | undefined;

  // Freeze the reason and snapshot the session-keyed data synchronously.
  // Nothing below may read or delete state by session id again: a newer turn can
  // start while this one unwinds, and everything keyed by the session alone is
  // then its data.
  const reason = peekAbortReason(id, turnId) ?? status;
  const turnUsage = activeTurnUsages.get(id);
  activeTurnUsages.delete(id);
  const runId = scheduledRunsBySession.get(id);
  if (runId) scheduledRunsBySession.delete(id);
  const wasPlanSubmission = planSubmissionTurnIds.has(finalizationKey);
  const createNotification =
    options.createNotification ??
    (!wasPlanSubmission && shouldCreateTaskNotification(id));
  const recoverInflight = options.recoverInflight === true;

  const runFinalization = async (): Promise<void> => {
    try {
      if (host) {
        try {
          const result = await host.call<{
            ok: boolean;
            notification?: AppNotification;
            recovered?: UiMessage;
          }>("session.endTurn", {
            turnId,
            status: reason,
            errorCode,
            createNotification,
            ...(turnUsage ? { usage: turnUsage } : {}),
            // The reply can no longer finish on its own: promote its last
            // checkpoint instead of waiting for a final row that never comes.
            ...(recoverInflight ? { recoverInflight: true } : {}),
          });
          if (owner && result?.ok !== true) throw new Error("approved plan turn finalization was not acknowledged");
          dispatcher.confirmTurnSettlement(id, turnId);
          settledTurnId = turnId;
          if (result.notification) {
            sendToRenderer(IPC.event.notificationChanged, {
              notification: result.notification,
            });
          }
          if (result.recovered) {
            // Settle the renderer's streaming row the same way a final
            // message_end would have, so it does not stay "streaming" forever.
            emitAgentEvent({
              sessionId: id,
              turnId,
              ts: Date.now(),
              event: { type: "message_end", message: result.recovered },
            } satisfies AgentEventEnvelope);
          }
        } catch (e) {
          logger.app("persistence", "warn", "endTurn failed", {
            sessionId: id,
            data: String(e),
          });
        }
      }

      if (runId && host) {
        await host
          .call("scheduled.finishRun", { runId, status: reason, errorCode })
          .catch((e) =>
            logger.app("persistence", "warn", "finishRun failed", {
              sessionId: id,
              data: String(e),
            }),
          );
      }
    } finally {
      // Do not release local ownership until the durable endTurn request above
      // has settled. Ownership is checked by identity, so this teardown can
      // never release a newer turn.
      if (activeTurns.get(id) === turnId) activeTurns.delete(id);
      planSubmissionTurnIds.delete(finalizationKey);
      // A host tool can finish shortly after the turn is aborted. Keep metadata
      // long enough for a late tool_end to persist a readable historical row,
      // but never clear a newer turn's long-running tools (TaskWait may span
      // this window).
      const toolPrefix = `${id}:`;
      setTimeout(() => {
        for (const [key, call] of activeToolCalls) {
          if (key.startsWith(toolPrefix) && call.turnId === turnId) {
            activeToolCalls.delete(key);
          }
        }
      }, 5 * 60 * 1000).unref();
    }

    // The turn can no longer start a plugin tool, and its finalization record
    // still holds the queue, so the announcement observes a settled turn. Every
    // delivery failure is isolated inside the announcement itself.
    announceTurnEnded({ sessionId: id, turnId, reason });
  };

  let record: Promise<void> | undefined;
  /**
   * Release the claim last, so that a failed persistence attempt or a throwing
   * announcement cannot leave the queue held forever. Only the record this call
   * registered may be removed.
   */
  const releaseFinalization = (): void => {
    if (!record || turnFinalizations.get(finalizationKey) !== record) return;
    turnFinalizations.delete(finalizationKey);
    // The turn is over: its cancellation lock must not outlive it, or a later
    // turn on this session would inherit a stale cancellation.
    clearAbortReason(id, turnId);
    const waiters = turnSettlements.get(finalizationKey);
    if (waiters) {
      turnSettlements.delete(finalizationKey);
      for (const resolve of waiters) resolve();
    }
    // Main is authoritative about the turn's end: the terminal event may have
    // been dropped as stale (`isStaleTerminalEvent`) or never emitted at all, and
    // a turn left active in Agent Host holds that session's queue forever. So the
    // settlement closes the turn in the module, which also releases the queue it
    // was holding. `kick` stays as the belt-and-braces retry for a turn the module
    // never saw.
    if (!isQuitting()) {
      bridge?.endTurn(
        id,
        turnId,
        hostTurnStatus(reason),
        hostTurnError(reason, errorCode),
      );
      if (runtimeState.agentHostBridge === bridge) bridge?.agentHost.kick(id);
    }
    if (!isQuitting() && typeof onTurnEnded === "function") {
      void onTurnEnded(id, turnId, {
        reason,
        ...(turnUsage ? { usage: turnUsage } : {}),
        ...(errorCode ? { errorCode } : {}),
      }).catch((error: unknown) => {
        logger.app("session", "warn", "mode run settlement failed", {
          sessionId: id,
          data: String(error),
        });
      });
    }
    // Settlement of the durable turn is the trigger for the collaborators that
    // follow it; a turn with no durable end has nothing to settle.
    if (!isQuitting() && !runtimeState.handoffAdmission.isClosed() && runtimeState.host === host &&
        settledTurnId && typeof onTurnSettled === "function") {
      void onTurnSettled(id, settledTurnId).catch((error: unknown) => {
        logger.app("persistence", "warn", "session collaboration settlement failed", {
          sessionId: id,
          data: String(error),
        });
      });
    }
  };
  // Register the record before the body runs, so a concurrent caller observes
  // the same promise even when this turn had no persistence step to await.
  // `finally` releases the claim after the body settles without swallowing a
  // rejected body: a caller that awaits this promise still sees the failure.
  const finalization = Promise.resolve()
    .then(runFinalization)
    .finally(releaseFinalization);
  record = finalization;
  turnFinalizations.set(finalizationKey, finalization);
  return finalization;
}

async function finishApprovedExecution(
  executionId: string,
  status: PlanExecutionFinishStatus,
  errorCode?: string,
): Promise<void> {
  await dispatcher.finishApprovedExecution(executionId, status, errorCode);
}

  const dispatcher = createApprovedPlanDispatcher({
    runtimeState, planState, logger, coordination, planSubmissionTurnIds,
    approvedExecutionIdsBySession, claimedExecutionSessions, approvedExecutionTurns,
    startedApprovedExecutions, finishedApprovedExecutions, dispatchingApprovedExecutions,
    pendingExecutionFinishes, inFlightExecutionFinishes, acquireSessionOperation, resolveAgentRuntimeLaunch,
    isQuitting, finishTurn,
  });
  const { turnOwner: _turnOwner, confirmTurnSettlement: _confirmTurnSettlement, ...operations } = dispatcher;
  return { ...operations, finishTurn, finishApprovedExecution };
}

export type PlanRuntime = ReturnType<typeof createPlanRuntime>;
