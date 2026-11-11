import { createHash } from "node:crypto";
import {
  RacpError, parseCommandCenterRequest, parseCommandCenterRepositoryResult,
  type CommandCenterBinding, type CommandCenterMethod, type CommandCenterRepository,
  type CommandCenterRepositoryContext, type CommandCenterRequests, type CommandCenterResults,
  type HostRpcPort,
} from "@pi-desktop/agent-host";
import { commandCenterCanonicalPayload, commandCenterReceiptBindsRequest, type CommandCenterInterventionRequest } from "@pi-desktop/shared";

/** Private Node -> Rust stdio adapter. The external IPC/RACP schema must never
 * expose `auth` or `binding`. Auth is minted only by CommandCenterControl after
 * authenticated transport roles and scope checks; Rust independently checks
 * these against its current owner and transactional C2 fences. */
export class RustCommandCenterRepository implements CommandCenterRepository {
  constructor(private readonly transport: HostRpcPort, private readonly hostIdentity: () => CommandCenterBinding) {}

  async call<M extends CommandCenterMethod>(method: M, input: CommandCenterRequests[M], context: CommandCenterRepositoryContext): Promise<CommandCenterResults[M]> {
    const request = parseCommandCenterRequest(method, input);
    const binding = { ...context.binding };
    const assertCurrent = () => {
      const current = this.hostIdentity();
      if (current.hostId !== binding.hostId || current.hostEpoch !== binding.hostEpoch) {
        throw new RacpError("CONFLICT", "command-center repository owner changed; reconcile the request", { retriable: false });
      }
    };
    assertCurrent();
    let response: unknown;
    try {
      // One transport attempt only. A lost response may follow a durable commit;
      // neither this adapter nor a caller should automatically resend mutations.
      response = await this.transport.call(`commandCenter.${method.replace("/", ".")}`, {
        binding,
        auth: { ...context.auth, roles: [...context.auth.roles], sessionIds: [...context.auth.sessionIds], workspaceIds: [...context.auth.workspaceIds] },
        input: request,
      });
    } catch (error) {
      assertCurrent();
      const message = error instanceof Error ? error.message : "";
      const code = /\bCC_([A-Z_]+):/.exec(message)?.[1];
      if (!code) throw error;
      const family = code.startsWith("INVALID") ? "INVALID_ARGUMENT"
        : code === "FORBIDDEN" ? "FORBIDDEN"
        : code === "CAPABILITY_UNAVAILABLE" ? "CAPABILITY_UNAVAILABLE"
        : code === "HOST_BUSY" ? "HOST_BUSY"
        : code.includes("QUOTA") || code.includes("LIMIT") ? "RESOURCE_EXHAUSTED"
        : code.includes("NOT_FOUND") ? "NOT_FOUND"
        : code.includes("CONFLICT") || code.includes("STALE") || code.includes("LIVE") || code.includes("DISABLED") || code.includes("EXISTS") ? "CONFLICT"
        : "INTERNAL";
      // Storage diagnostics stay in Host logs; never relay SQL, paths or another
      // principal's identity through a transport error message.
      throw new RacpError(family, "command-center repository refused the operation", { retriable: false });
    }
    assertCurrent();
    const result = parseCommandCenterRepositoryResult(method, response);
    if (method === "intervention/record") {
      const outcome = result as CommandCenterResults["intervention/record"];
      const intervention = request as CommandCenterInterventionRequest;
      const fingerprint = createHash("sha256").update(commandCenterCanonicalPayload(intervention)).digest("hex");
      if (!commandCenterReceiptBindsRequest(outcome.entry.receipt, intervention) || outcome.entry.receipt.fingerprint !== fingerprint ||
          outcome.entry.hostId !== binding.hostId || outcome.entry.hostEpoch !== binding.hostEpoch ||
          outcome.entry.commandWorkspaceId !== intervention.commandWorkspaceId || outcome.entry.membershipRevision !== intervention.expectedMembershipRevision) {
        throw new RacpError("INTERNAL", "command-center repository returned an unrelated receipt", { retriable: false });
      }
    }
    return result;
  }
}
