/**
 * Electron main coordination for staged mode runs (ADR mode-definitions).
 *
 * host-core owns the run state machine. Main only maps turns to runs: it
 * claims a run for a durable turn before the sidecar starts it, settles the
 * claim when the turn ends, and starts the Host-requested continuation turn.
 *
 * Continuation authority travels by object identity, as in PR #2141 by
 * new-Beginner: a request object registered here carries the origin, and a
 * JSON/structured-clone copy (renderer, plugin, remote client) never does.
 */
import type {
  MessageUsage,
  ModeClaimResult,
  ModeControlRequest,
  ModeDefinition,
  ModeResolveRequest,
  ModeRunResult,
  ModeSettleResult,
  ModeTurnContext,
  ModeTurnOrigin,
  ModeUpdateRequest,
} from "@pi-desktop/shared";
import type { ModeCatalogService } from "./mode-catalog";
import type { Logger } from "../logger";

import { ModeRunLifetime, type ModeRunOwner } from "./mode-run-lifetime";

/** `modes.settleReturn` answer: the return mode still pending, or the one applied. */
type ModeSettleReturnResult = { pending: string | null; applied: string | null };

/** Builtins whose Host semantics need no snapshot. */
function isPlainMode(mode: string): boolean {
  return mode === "agent" || mode === "plan";
}

/** Model-facing content of a Host-started turn. It is never persisted as a
 * user message; the stage brief in the system prompt carries the details. */
export const MODE_CONTINUATION_CONTENT =
  "Continue the current stage of the active mode run. Follow the stage brief in the system instructions.";

const continuationOrigins = new WeakMap<object, Exclude<ModeTurnOrigin, "user">>();

export function modeContinuationRequest<T extends object>(request: T, origin: Exclude<ModeTurnOrigin, "user">): T {
  continuationOrigins.set(request, origin);
  return request;
}

export function modeContinuationOrigin(request: object): Exclude<ModeTurnOrigin, "user"> | undefined {
  return continuationOrigins.get(request);
}

export type PreparedModeTurn = { modeTurn: ModeTurnContext; definition: ModeDefinition };

export type ModeTurnEnd = { reason: "completed" | "aborted" | "error"; usage?: MessageUsage; errorCode?: string };

function totalTokens(usage: MessageUsage | undefined): number {
  if (!usage) return 0;
  const total = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return Number.isSafeInteger(total) && total > 0 ? total : 0;
}

/** Sidecar `agent.modeTurnNotice` payload (without session and turn ids). */
export type ModeTurnNotice =
  | { runId: string; action: "closeout" }
  | { runId: string; action: "release"; mode: string; modeDefinition?: ModeDefinition };

export type ModeRunCoordinator = ReturnType<typeof createModeRunCoordinator>;

export function createModeRunCoordinator(deps: {
  getOwner(): ModeRunOwner | null;
  catalog: ModeCatalogService;
  logger: Pick<Logger, "app">;
  isQuitting(): boolean;
  isAdmissionClosed(): boolean;
}) {
  type Claim = { sessionId: string; runId: string; owner: ModeRunOwner; settlement?: Promise<void> };
  const turnRuns = new Map<string, Claim>();
  const lifetime = new ModeRunLifetime({ ...deps, warn(sessionId, error) {
    deps.logger.app("session", "warn", "mode continuation was not started", {
      sessionId, data: String((error as { errorCode?: string })?.errorCode ?? error),
    });
  } });
  const schedule = (owner: ModeRunOwner, sessionId: string, origin: Exclude<ModeTurnOrigin, "user">) =>
    lifetime.schedule(owner, sessionId, origin, MODE_CONTINUATION_CONTENT);

  function settleTurn(sessionId: string, turnId: string, end: ModeTurnEnd): Promise<void> {
    const entry = turnRuns.get(turnId);
    if (!entry || entry.sessionId !== sessionId) return Promise.resolve();
    // Install the shared completion before the Host can reenter this method.
    entry.settlement ??= lifetime.track(() => Promise.resolve().then(async () => {
      try {
        const result = await entry.owner.host.call<ModeSettleResult>("modes.settleTurn", {
          sessionId, runId: entry.runId, turnId, tokens: totalTokens(end.usage), outcome: end.reason,
          ...(end.reason === "error" && end.errorCode ? { error: end.errorCode } : {}),
        });
        if (turnRuns.get(turnId) === entry) turnRuns.delete(turnId);
        if (result.continue) schedule(entry.owner, sessionId, "host");
      } catch (error) {
        lifetime.markUncertain();
        throw error;
      }
    }));
    return entry.settlement;
  }

  return {
    definitionForPrompt(modeId: string): Promise<ModeDefinition | undefined> {
      return lifetime.track(async () => {
        const owner = lifetime.capture();
        const definition = await deps.catalog.definition(modeId);
        lifetime.assertCurrent(owner);
        if (!definition && !isPlainMode(modeId)) {
          throw Object.assign(new Error("Mode is not available"), { errorCode: "MODE_NOT_FOUND" });
        }
        return definition;
      });
    },
    canContinue(sessionId: string): Promise<boolean> {
      return lifetime.track(async () => {
        const owner = lifetime.capture();
        const { run } = await owner.host.call<ModeRunResult>("modes.get", { sessionId });
        lifetime.assertCurrent(owner);
        return Boolean(run && run.state === "running" && !run.activeTurnId);
      });
    },

    /** Claim the original Host's durable turn. A stale successful claim is
     * abandoned before returning; uncertain settlement remains observable. */
    prepareTurn(input: {
      sessionId: string; turnId: string; sessionMode: string; content: string; origin: ModeTurnOrigin;
    }): Promise<PreparedModeTurn | undefined> {
      return lifetime.track(async () => {
        const owner = lifetime.capture();
        const selected = await deps.catalog.definition(input.sessionMode);
        lifetime.assertCurrent(owner);
        if (!selected || selected.stages.length === 0) {
          if (input.origin !== "user") throw Object.assign(new Error("mode run is not staged"), { errorCode: "MODE_NOT_STAGED" });
          return undefined;
        }
        const { run } = await owner.host.call<ModeRunResult>("modes.get", { sessionId: input.sessionId });
        lifetime.assertCurrent(owner);
        let claim: ModeClaimResult;
        if (!run && input.origin !== "user") throw Object.assign(new Error("no open mode run"), { errorCode: "MODE_RUN_NOT_FOUND" });
        if (run && run.modeId !== input.sessionMode) {
          if (input.origin !== "user") throw Object.assign(new Error("mode run belongs to another mode"), { errorCode: "MODE_RUN_ACTIVE" });
          return undefined;
        }
        try {
          claim = run
            ? await owner.host.call<ModeClaimResult>("modes.claimTurn", {
              sessionId: input.sessionId, runId: run.id, expectedRevision: run.revision,
              turnId: input.turnId, origin: input.origin,
            })
            : await owner.host.call<ModeClaimResult>("modes.start", {
              sessionId: input.sessionId, input: input.content, turnId: input.turnId,
            });
        } catch (error) { lifetime.markUncertain(); throw error; }
        if (claim.claimed && claim.run) {
          turnRuns.set(input.turnId, { sessionId: input.sessionId, runId: claim.run.id, owner });
        }
        try { lifetime.assertCurrent(owner); } catch (error) {
          if (claim.claimed && claim.run) {
            try { await settleTurn(input.sessionId, input.turnId, { reason: "aborted" }); }
            catch (cleanupError) { throw new AggregateError([error, cleanupError], "MODE_CLAIM_CLEANUP_UNCONFIRMED"); }
          }
          throw error;
        }
        if (!claim.claimed || !claim.run) {
          if (input.origin !== "user") throw Object.assign(new Error("mode run claim rejected"), { errorCode: "MODE_CLAIM_REJECTED" });
          return undefined;
        }
        return { definition: claim.definition ?? selected, modeTurn: {
          runId: claim.run.id, stageId: claim.run.stageId, origin: input.origin,
          enteredStage: claim.enteredStage, input: claim.run.input, artifactPaths: claim.run.artifactPaths,
        } };
      });
    },

    abandonTurn(sessionId: string, turnId: string): Promise<void> {
      return settleTurn(sessionId, turnId, { reason: "aborted" });
    },
    settleTurn,

    get(sessionId: string): Promise<ModeRunResult> {
      return lifetime.track(async () => {
        const owner = lifetime.capture();
        const result = await owner.host.call<ModeRunResult>("modes.get", { sessionId });
        lifetime.assertCurrent(owner);
        return result;
      });
    },

    control(request: ModeControlRequest): Promise<ModeSettleResult> {
      return lifetime.track(async () => {
        const owner = lifetime.capture();
        const active = [...turnRuns.entries()].find(([, entry]) => entry.owner === owner &&
          entry.sessionId === request.sessionId && entry.runId === request.runId);
        const result = await owner.host.call<ModeSettleResult>("modes.control", request);
        const warn = (message: string) => (error: unknown) => {
          lifetime.markUncertain();
          deps.logger.app("session", "warn", message, { sessionId: request.sessionId, data: String(error) });
        };
        if (active) {
          const [turnId, entry] = active;
          if (request.action === "stop") {
            await entry.owner.abortTurn(request.sessionId, turnId).catch(warn("mode run stop could not abort the turn"));
          } else if (request.action === "pause" && result.run?.state === "paused" && result.run.revision !== request.expectedRevision) {
            await entry.owner.notifyTurn(request.sessionId, turnId, { runId: request.runId, action: "closeout" })
              .catch(warn("mode run pause could not close out the turn"));
          } else if (request.action === "remove") {
            await (async () => {
              const definition = result.run ? await deps.catalog.definition(result.run.modeId) : undefined;
              const returnTo = definition?.returnTo ?? "agent";
              const returnDefinition = await deps.catalog.definition(returnTo);
              const mode = returnDefinition || isPlainMode(returnTo) ? returnTo : "agent";
              const modeDefinition = mode === returnTo ? returnDefinition : undefined;
              await entry.owner.notifyTurn(request.sessionId, turnId, {
                runId: request.runId, action: "release", mode, ...(modeDefinition ? { modeDefinition } : {}),
              });
            })().catch(warn("mode run remove could not release the turn"));
          }
        }
        if (result.continue) schedule(owner, request.sessionId, "approval");
        return result;
      });
    },

    update(request: ModeUpdateRequest): Promise<ModeSettleResult> {
      return lifetime.track(() => lifetime.capture().host.call<ModeSettleResult>("modes.update", request));
    },

    resolve(request: ModeResolveRequest): Promise<ModeSettleResult> {
      return lifetime.track(async () => {
        const owner = lifetime.capture();
        const result = await owner.host.call<ModeSettleResult>("modes.resolve", request);
        if (result.continue) schedule(owner, request.sessionId, "approval");
        return result;
      });
    },

    settleReturn(sessionId: string, run: { id: string; state: string }): Promise<boolean> {
      if (run.state !== "finished" && run.state !== "stopped") return Promise.resolve(false);
      return lifetime.track(async () => {
        const owner = lifetime.capture();
        const { pending } = await owner.host.call<ModeSettleReturnResult>("modes.settleReturn", { sessionId, runId: run.id });
        if (!pending) return false;
        const modeSnapshot = await deps.catalog.definition(pending);
        lifetime.assertCurrent(owner);
        const { applied } = await owner.host.call<ModeSettleReturnResult>("modes.settleReturn", {
          sessionId, runId: run.id, mode: pending, ...(modeSnapshot ? { modeSnapshot } : {}),
        });
        if (applied && applied !== pending) {
          deps.logger.app("session", "warn", "mode run return mode no longer exists; session uses agent", { sessionId, data: pending });
        }
        return Boolean(applied);
      });
    },

    claimedTurns: (): ReadonlyMap<string, { sessionId: string; runId: string }> => turnRuns,
    getHandoffActivity: () => lifetime.snapshot(turnRuns.size),
    drain: () => lifetime.drain(),
    dispose: () => lifetime.dispose(),
  };
}
