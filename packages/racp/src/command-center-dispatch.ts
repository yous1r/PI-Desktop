import { RacpError, COMMAND_CENTER_METHODS, type CommandCenterControl, type CommandCenterMethod, type Principal } from "@pi-desktop/agent-host";

/** Single wire namespace shared by the RACP catalog and this dispatcher. */
export const COMMAND_CENTER_RACP_PREFIX = "commandCenter/" as const;

/** Only a server-created OperationContext/RacpConnection may supply this value.
 * It is never a field of external JSON params or caller `context`. */
export type CommandCenterTransportContext = { principal: Principal };

/** Every command-center operation name registered in the shared RACP catalog. */
export const COMMAND_CENTER_OPERATIONS: readonly `commandCenter/${CommandCenterMethod}`[] = Object.freeze(
  COMMAND_CENTER_METHODS.map((method): `commandCenter/${CommandCenterMethod}` => `${COMMAND_CENTER_RACP_PREFIX}${method}`),
);

const COMMAND_CENTER_OPERATION_SET: ReadonlySet<string> = new Set(COMMAND_CENTER_OPERATIONS);

/** True only for the exact catalog names this module dispatches. */
export function isCommandCenterOperation(operation: string): boolean {
  return COMMAND_CENTER_OPERATION_SET.has(operation);
}

export type CommandCenterDispatchOptions = {
  /** Release whatever the dispatcher owns. Runs at most once. */
  onDispose?: () => void | Promise<void>;
};

/** One connection's command-center transport. The connection owns it for its
 * lifetime and `dispose()` is the only release path; a disposed dispatcher
 * refuses work so a late request cannot reach the control service. */
export type CommandCenterDispatch = {
  readonly methods: readonly string[];
  readonly disposed: boolean;
  dispatch(operation: string, params: unknown, context: CommandCenterTransportContext): Promise<unknown>;
  dispose(): Promise<void>;
};

/** Registration-neutral dispatcher. Parent registers these names in the shared
 * RACP catalog and server handler map after wiring the real service. This does
 * not advertise runtime availability or register methods as an import effect. */
export function createCommandCenterDispatch(
  service: CommandCenterControl,
  options: CommandCenterDispatchOptions = {},
): CommandCenterDispatch {
  let disposed = false;
  let disposal: Promise<void> | null = null;
  return {
    methods: COMMAND_CENTER_OPERATIONS,
    get disposed() {
      return disposed;
    },
    async dispatch(operation: string, params: unknown, context: CommandCenterTransportContext): Promise<unknown> {
      if (disposed) throw new RacpError("AGENT_UNAVAILABLE", "the command-center dispatcher is disposed");
      const method = operation.startsWith(COMMAND_CENTER_RACP_PREFIX) ? operation.slice(COMMAND_CENTER_RACP_PREFIX.length) : "";
      if (!COMMAND_CENTER_METHODS.includes(method as CommandCenterMethod)) {
        throw new RacpError("METHOD_NOT_FOUND", "unknown command-center operation");
      }
      return service.call(method as CommandCenterMethod, params, context.principal);
    },
    dispose(): Promise<void> {
      if (!disposal) {
        disposed = true;
        disposal = Promise.resolve().then(() => options.onDispose?.()).then(() => undefined);
      }
      return disposal;
    },
  };
}
