import { commandCenterWithinBytes, parseCommandCenterReceipt, parseCommandCenterWorkspaceList, COMMAND_CENTER_QUOTA } from "@pi-desktop/shared";
import { RacpError } from "../errors.js";
import {
  hostId, integer, record, strictKeys, text, uuid,
  type CommandCenterMethod, type CommandCenterRepositoryMethod, type CommandCenterRepositoryResults, type CommandCenterResults,
} from "./contracts.js";

function workspace(value: unknown): void {
  parseCommandCenterWorkspaceList({ version: 1, workspaces: [value], quota: COMMAND_CENTER_QUOTA });
}
function membership(value: unknown): void {
  const item = record(value);
  strictKeys(item, ["sessionId", "commandWorkspaceId", "revision"]);
  text(item.sessionId, 128); uuid(item.commandWorkspaceId); integer(item.revision, 1);
}
function entry(value: unknown): void {
  const item = record(value);
  strictKeys(item, ["receipt", "hostId", "hostEpoch", "commandWorkspaceId", "membershipRevision", "sequence"]);
  parseCommandCenterReceipt(item.receipt); hostId(item.hostId); uuid(item.hostEpoch); uuid(item.commandWorkspaceId);
  integer(item.membershipRevision, 1); integer(item.sequence, 1);
}
function array(value: unknown, validate: (item: unknown) => void): void {
  if (!Array.isArray(value) || value.length > 100) throw new Error("invalid page");
  for (const item of value) validate(item);
}
/** Treat the Rust transport response as untrusted until its producer contract is
 * checked. Do not turn a malformed persistence response into apparent success. */
export function parseCommandCenterRepositoryResult<M extends CommandCenterRepositoryMethod>(
  method: M, value: unknown,
): CommandCenterRepositoryResults[M] {
  try {
    if (!commandCenterWithinBytes(value, 256 * 1024)) throw new Error("page budget");
    if (method === "intervention/ack") {
      const result = record(value);
      strictKeys(result, ["entry", "replayed"]);
      entry(result.entry);
      if (typeof result.replayed !== "boolean") throw new Error("invalid replay result");
      return value as CommandCenterRepositoryResults[M];
    }
    return parsePublicResult(method as CommandCenterMethod, value) as CommandCenterRepositoryResults[M];
  } catch {
    throw new RacpError("INTERNAL", "invalid command-center repository response", { retriable: false });
  }
}

function parsePublicResult<M extends CommandCenterMethod>(method: M, value: unknown): CommandCenterResults[M] {
  if (!commandCenterWithinBytes(value, 256 * 1024)) throw new Error("page budget");
  if (method === "workspace/get") { if (value !== null) workspace(value); }
  else if (["workspace/create", "workspace/rename", "workspace/setEnabled"].includes(method)) workspace(value);
  else if (method === "membership/get") { if (value !== null) membership(value); }
  else if (method === "membership/bind") membership(value);
  else if (method === "receipt/get") { if (value !== null) entry(value); }
  else {
    const result = record(value);
    switch (method) {
      case "workspace/list":
        strictKeys(result, ["workspaces"]);
        array(result.workspaces, workspace);
        parseCommandCenterWorkspaceList({ version: 1, workspaces: result.workspaces, quota: COMMAND_CENTER_QUOTA });
        break;
      case "workspace/delete":
        strictKeys(result, ["deleted"]);
        if (result.deleted !== true) throw new Error("invalid deletion");
        break;
      case "membership/list":
        strictKeys(result, ["memberships", "nextAfterSessionId"]);
        array(result.memberships, membership);
        if (result.nextAfterSessionId !== null) text(result.nextAfterSessionId, 128);
        break;
      case "receipt/list":
        strictKeys(result, ["entries", "nextAfterSequence"]);
        array(result.entries, entry);
        if (result.nextAfterSequence !== null) integer(result.nextAfterSequence, 1);
        break;
      case "intervention/record":
        strictKeys(result, ["entry", "replayed"]);
        entry(result.entry);
        if (typeof result.replayed !== "boolean") throw new Error("invalid replay result");
        break;
      default: throw new Error("unsupported response");
    }
  }
  return value as CommandCenterResults[M];
}
