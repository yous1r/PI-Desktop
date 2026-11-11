/** H5 composition root for the Desktop command-center successor.
 *
 * There is no separate feature flag or installation identity here: startup
 * creates the root, and it only observes a host after the existing owner-handoff
 * command path registers one prepared transfer. Registration must carry the
 * original Host authority, the prepared claim, the committed target build, the
 * observed session and the target's real live event epoch. The original record
 * reader is derived from that same authority binding. A missing part is refused
 * with an explicit code; no record, epoch or identity is ever fabricated.
 *
 * Shutdown disposes the root, which stops every restricted target child before
 * the paired remote hosts close.
 */
import { parseOwnerHandoffBootstrapCommand, type OwnerHandoffBuild } from "@pi-desktop/shared";
import {
  OwnerHandoffSuccessor,
  launchOwnerHandoffTarget,
  readOwnerHandoffTransfer,
  type OwnerAttachmentTarget,
  type OwnerHandoffSuccessorLaunch,
  type OwnerHandoffSuccessorLaunchContext,
  type OwnerHandoffTargetClaim,
  type OwnerSourceBinding,
} from "@pi-desktop/host-runtime";
import { resolveHostBinary } from "../host-process";
import type { RemoteHostClient } from "../remote/remote-host-connection.js";
import type { RemoteHandoffAttachmentRequest } from "./remote-hosts.js";

export const HANDOFF_SUCCESSOR_AUTHORITY_UNAVAILABLE = "HANDOFF_SUCCESSOR_AUTHORITY_UNAVAILABLE";
export const HANDOFF_SUCCESSOR_CLAIM_UNAVAILABLE = "HANDOFF_SUCCESSOR_CLAIM_UNAVAILABLE";
export const HANDOFF_SUCCESSOR_EPOCH_UNAVAILABLE = "HANDOFF_SUCCESSOR_EPOCH_UNAVAILABLE";
export const HANDOFF_SUCCESSOR_BUILD_UNAVAILABLE = "HANDOFF_SUCCESSOR_BUILD_UNAVAILABLE";
export const HANDOFF_SUCCESSOR_ALREADY_REGISTERED = "HANDOFF_SUCCESSOR_ALREADY_REGISTERED";
export const HANDOFF_SUCCESSOR_DISPOSED = "HANDOFF_SUCCESSOR_DISPOSED";

/** Everything the existing owner-handoff command must bind for one successor. */
export type CommandCenterHandoffBinding = {
  /** Paired Host entry that represents the successor target. */
  hostKey: string;
  /** Original Host authority retained by the handoff command. */
  authority: OwnerSourceBinding;
  /** Prepared claim committed by the source/handoff command. */
  claim: OwnerHandoffTargetClaim;
  /** Target build committed by the prepared transfer. */
  targetBuild: OwnerHandoffBuild;
  /** Host session the attachment observes (viewer only). */
  sessionId: string;
  /** Real live host event-stream epoch of the target; never synthesized. */
  eventEpoch(signal: AbortSignal): Promise<string | null>;
  /** Optional launcher override; production uses `launchOwnerHandoffTarget`. */
  launch?: OwnerHandoffSuccessorLaunch;
};

export type CommandCenterHandoffRegistration = {
  readonly hostKey: string;
  readonly successor: OwnerHandoffSuccessor;
  dispose(): Promise<void>;
};

export type CommandCenterHandoffBootOptions = {
  dataDir: string;
  /** Test seam; production resolves the packaged host-core next to the app. */
  binaryPath?: string;
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
};

export type CommandCenterHandoffBootState = "idle" | "active" | "disposed";

export type CommandCenterHandoffBoot = {
  readonly state: CommandCenterHandoffBootState;
  /** Stable resolver for `createRemoteHostsBoot`; undefined until a matching
   * transfer is registered and its target is still live. */
  handoffAttachment(host: { hostKey: string; client: RemoteHostClient }): RemoteHandoffAttachmentRequest | undefined;
  /** Register one prepared successor. Throws an explicit HANDOFF_* code. */
  register(binding: CommandCenterHandoffBinding): CommandCenterHandoffRegistration;
  registrations(): readonly CommandCenterHandoffRegistration[];
  dispose(): Promise<void>;
};

type Registration = CommandCenterHandoffRegistration & {
  readonly target: OwnerAttachmentTarget;
  readonly sessionId: string;
};

function failure(code: string): Error & { code: string; errorCode: string } {
  return Object.assign(new Error(code), { code, errorCode: code });
}

function validateAuthority(binding: CommandCenterHandoffBinding): OwnerSourceBinding {
  const authority = binding?.authority;
  if (!binding || typeof binding.hostKey !== "string" || binding.hostKey.length === 0 ||
      !authority || typeof authority !== "object" ||
      !authority.host || typeof authority.host.call !== "function" ||
      typeof authority.host.isAvailable !== "function" ||
      typeof authority.sourceEpoch !== "string" || authority.sourceEpoch.length === 0 ||
      typeof authority.profileId !== "string" || authority.profileId.length === 0) {
    throw failure(HANDOFF_SUCCESSOR_AUTHORITY_UNAVAILABLE);
  }
  return authority;
}

function validateClaim(binding: CommandCenterHandoffBinding, authority: OwnerSourceBinding): OwnerHandoffTargetClaim {
  let parsed: OwnerHandoffTargetClaim;
  try {
    const command = parseOwnerHandoffBootstrapCommand(binding.claim);
    if (command.operation !== "claim" || command.source_epoch !== authority.sourceEpoch) {
      throw new Error("not this authority's claim");
    }
    parsed = { ...command, operation: "claim" };
  } catch {
    throw failure(HANDOFF_SUCCESSOR_CLAIM_UNAVAILABLE);
  }
  return Object.freeze({ ...parsed });
}

export function createCommandCenterHandoffBoot(options: CommandCenterHandoffBootOptions): CommandCenterHandoffBoot {
  const log = options.log ?? (() => undefined);
  const registrations = new Map<string, Registration>();
  let disposal: Promise<void> | undefined;
  let stateValue: CommandCenterHandoffBootState = "idle";
  const launch = (context: OwnerHandoffSuccessorLaunchContext) => launchOwnerHandoffTarget({
    binaryPath: options.binaryPath ?? resolveHostBinary(),
    dataDir: options.dataDir,
    profileId: context.profileId,
    targetBuild: context.targetBuild,
    claim: context.claim,
    onStderr: text => log("warn", "owner-target stderr", { text: text.slice(0, 2_000) }),
  });

  return {
    get state() { return stateValue; },
    handoffAttachment(host) {
      if (stateValue !== "active") return undefined;
      const registration = registrations.get(host.hostKey);
      if (!registration) return undefined;
      if (registration.successor.state === "disposed") {
        registrations.delete(host.hostKey);
        return undefined;
      }
      return { target: registration.target, sessionId: registration.sessionId, successor: registration.successor };
    },
    register(binding) {
      if (stateValue === "disposed") throw failure(HANDOFF_SUCCESSOR_DISPOSED);
      const authority = validateAuthority(binding);
      const claim = validateClaim(binding, authority);
      if (typeof binding.sessionId !== "string" || binding.sessionId.length === 0 ||
          typeof binding.eventEpoch !== "function") {
        throw failure(HANDOFF_SUCCESSOR_EPOCH_UNAVAILABLE);
      }
      if (!binding.targetBuild || typeof binding.targetBuild !== "object") {
        throw failure(HANDOFF_SUCCESSOR_BUILD_UNAVAILABLE);
      }
      if (registrations.has(binding.hostKey)) throw failure(HANDOFF_SUCCESSOR_ALREADY_REGISTERED);
      const target: OwnerAttachmentTarget = {
        transferId: claim.transfer_id,
        sourceEpoch: authority.sourceEpoch,
        profileId: authority.profileId,
      };
      const retained = Object.freeze({ ...authority });
      const successor = new OwnerHandoffSuccessor({
        target,
        claim,
        targetBuild: binding.targetBuild,
        readOriginal: async (requested, signal) => {
          signal.throwIfAborted();
          if (requested.transferId !== target.transferId) throw failure(HANDOFF_SUCCESSOR_CLAIM_UNAVAILABLE);
          const value = await readOwnerHandoffTransfer(() => retained, requested.transferId);
          signal.throwIfAborted();
          return value;
        },
        eventEpoch: binding.eventEpoch,
        launch: binding.launch ?? launch,
      });
      let registrationDisposal: Promise<void> | undefined;
      const registration: Registration = {
        hostKey: binding.hostKey,
        target,
        sessionId: binding.sessionId,
        successor,
        dispose() {
          registrationDisposal ??= (async () => {
            try { await successor.dispose(); }
            finally { if (registrations.get(binding.hostKey) === registration) registrations.delete(binding.hostKey); }
          })();
          return registrationDisposal;
        },
      };
      registrations.set(binding.hostKey, registration);
      stateValue = "active";
      log("info", "command-center handoff successor registered", { hostKey: binding.hostKey, transferId: claim.transfer_id });
      return registration;
    },
    registrations: () => [...registrations.values()],
    dispose() {
      if (disposal) return disposal;
      stateValue = "disposed";
      disposal = (async () => {
        const outcomes = await Promise.allSettled([...registrations.values()].map(registration => registration.dispose()));
        const failures = outcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
        if (failures.length) throw new AggregateError(failures, "command-center handoff cleanup could not be confirmed");
      })();
      return disposal;
    },
  };
}

let activeCommandCenterHandoffBoot: CommandCenterHandoffBoot | null = null;
export function setActiveCommandCenterHandoffBoot(boot: CommandCenterHandoffBoot | null): void {
  activeCommandCenterHandoffBoot = boot;
}
export function getActiveCommandCenterHandoffBoot(): CommandCenterHandoffBoot | null {
  return activeCommandCenterHandoffBoot;
}

/**
 * The existing owner-handoff command uses this entry to register its prepared
 * successor on the startup-owned root. Missing startup root refuses explicitly.
 */
export function registerCommandCenterHandoffTransfer(
  binding: CommandCenterHandoffBinding,
): CommandCenterHandoffRegistration {
  const boot = activeCommandCenterHandoffBoot;
  if (!boot) throw failure(HANDOFF_SUCCESSOR_AUTHORITY_UNAVAILABLE);
  return boot.register(binding);
}

/**
 * Shutdown ordering: successor children own restricted target processes, so
 * they stop before the paired remote hosts close their sockets. A failed
 * successor cleanup still closes the hosts and is reported afterwards.
 */
export async function disposeCommandCenterHandoffBeforeRemoteHosts(
  handoff: Pick<CommandCenterHandoffBoot, "dispose"> | null | undefined,
  closeRemoteHosts: () => Promise<unknown>,
): Promise<void> {
  let failure: unknown;
  try { await handoff?.dispose(); }
  catch (error) { failure = error; }
  try { await closeRemoteHosts(); }
  catch (error) { failure ??= error; }
  if (failure !== undefined) throw failure;
}
