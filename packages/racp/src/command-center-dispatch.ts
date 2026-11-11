import { RacpError, COMMAND_CENTER_METHODS, type CommandCenterControl, type CommandCenterMethod, type Principal } from "@pi-desktop/agent-host";

/** Only a server-created OperationContext/RacpConnection may supply this value.
 * It is never a field of external JSON params or caller `context`. */
export type CommandCenterTransportContext = { principal: Principal };

/** Registration-neutral dispatcher. Parent registers these names in the shared
 * RACP catalog and server handler map after wiring the real service. This does
 * not advertise runtime availability or register methods as an import effect. */
export function createCommandCenterDispatch(service: CommandCenterControl) {
  return {
    methods: COMMAND_CENTER_METHODS.map((method) => `commandCenter/${method}`),
    async dispatch(operation: string, params: unknown, context: CommandCenterTransportContext): Promise<unknown> {
      const prefix = "commandCenter/";
      const method = operation.startsWith(prefix) ? operation.slice(prefix.length) : "";
      if (!COMMAND_CENTER_METHODS.includes(method as CommandCenterMethod)) {
        throw new RacpError("METHOD_NOT_FOUND", "unknown command-center operation");
      }
      return service.call(method as CommandCenterMethod, params, context.principal);
    },
  };
}
