import {
  CommandCenterControl,
  type CommandCenterAccess,
  type CommandCenterAdmissionPort,
  type CommandCenterBinding,
  type CommandCenterRuntimeHandoff,
  type HostRpcPort,
  type Principal,
} from "@pi-desktop/agent-host";
import type { CommandCenterAdmissionSnapshot } from "@pi-desktop/shared";

import { RustCommandCenterRepository } from "./command-center-repository.js";
import { createRustCommandCenterAdmissionPort } from "./command-center-admission.js";

/**
 * Structural mirror of `@pi-desktop/racp`'s `CommandCenterDispatch`.
 *
 * The host-runtime package deliberately does not depend on the transport
 * package, so the RACP dispatcher factory is an explicit composition port. In
 * production the composition root passes `createCommandCenterDispatch`; the
 * concrete shape is checked here and by the adapter's own tests.
 */
export type CommandCenterDispatchPort = {
  readonly methods: readonly string[];
  readonly disposed: boolean;
  dispatch(operation: string, params: unknown, context: { principal: Principal }): Promise<unknown>;
  dispose(): Promise<void>;
};

export type CommandCenterDispatchOptions = { onDispose?: () => void | Promise<void> };

export type CommandCenterDispatchFactory = (
  control: CommandCenterControl,
  options?: CommandCenterDispatchOptions,
) => CommandCenterDispatchPort;

/** Explicit clock port; tests pass a controlled clock, production passes Date. */
export type CommandCenterHostClock = { now(): number };

/**
 * Whether this Host must have a real exact-target runtime consumer.
 *
 * - `record-only` (default): no dispatch seam is required; the control service
 *   records and reconciles receipts but never reports dispatch success.
 * - `required`: construction fails closed unless `runtime.dispatch` exists; the
 *   Host is asserting it can actually execute the control path.
 */
export type CommandCenterRuntimeMode = "record-only" | "required";

/**
 * Everything the in-repo command-center composition needs. Every port is
 * explicit and required except `runtime`/`runtimeMode` (default record-only).
 */
export type CommandCenterHostPorts = {
  /** Rust host-core stdio transport used by `RustCommandCenterRepository`. */
  transport: HostRpcPort;
  /** Current installation identity; re-read for every call and every await fence. */
  hostIdentity: () => CommandCenterBinding;
  /** Session/workspace ACL policy for authenticated principals. */
  authorizer: (principal: Principal, access: CommandCenterAccess) => Promise<boolean>;
  /** The same MaintenanceAdmission instance every other execution entry point uses. */
  mutationsClosed: () => boolean;
  clock: CommandCenterHostClock;
  /** Production passes `createCommandCenterDispatch` from `@pi-desktop/racp`. */
  createDispatch: CommandCenterDispatchFactory;
  /** Exact-target runtime consumer. Omitted keeps the C3 record-only boundary. */
  runtime?: CommandCenterRuntimeHandoff;
  /**
   * Shared admission/reservation authority (12/workspace, 36/Host, exactly-once
   * release). Required when `runtimeMode` is `required`; without a real C2-backed
   * implementation the Host must not claim it can execute the control path.
   */
  admission?: CommandCenterAdmissionPort;
  /** Explicit dispatch requirement; see `CommandCenterRuntimeMode`. */
  runtimeMode?: CommandCenterRuntimeMode;
  dispatchTimeoutMs?: number;
};

export type CommandCenterHost = {
  readonly repository: RustCommandCenterRepository;
  readonly control: CommandCenterControl;
  /** The effective dispatch mode; never silently promoted to `required`. */
  readonly runtimeMode: CommandCenterRuntimeMode;
  /** The injected admission authority, or null when the Host is record-only. */
  readonly admission: CommandCenterAdmissionPort | null;
  /** Current live counts and limits, read through the admission authority. */
  admissionState(principal: Principal, workspaceIds?: readonly string[]): Promise<CommandCenterAdmissionSnapshot>;
  /** One host-owned dispatcher bound to this control. */
  readonly dispatch: CommandCenterDispatchPort;
  /** Create an additional connection-scoped dispatcher; dispose covers all. */
  createDispatch(options?: CommandCenterDispatchOptions): CommandCenterDispatchPort;
  dispose(): Promise<void>;
};

function requiredPort<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) {
    throw new Error(`command-center host requires the ${name} port`);
  }
  return value;
}

function requiredFunction<T>(value: T | null | undefined, name: string): T {
  if (typeof value !== "function") throw new Error(`command-center host requires the ${name} port`);
  return value;
}

/**
 * Compose the in-repo command-center control path:
 *
 *   RustCommandCenterRepository -> CommandCenterControl -> CommandCenterDispatch
 *
 * Missing ports fail closed at construction. A Host that never binds this
 * factory keeps today's behavior: no `commandCenter/*` operation is reachable
 * and no capability is advertised.
 */
export function createCommandCenterHost(ports: CommandCenterHostPorts): CommandCenterHost {
  if (!ports || typeof ports !== "object") throw new Error("command-center host requires the ports object");
  const transport = requiredPort(ports.transport, "transport");
  if (typeof transport.call !== "function") throw new Error("command-center host requires the transport port");
  const hostIdentity = requiredFunction(ports.hostIdentity, "hostIdentity");
  const authorizer = requiredFunction(ports.authorizer, "authorizer");
  const mutationsClosed = requiredFunction(ports.mutationsClosed, "mutationsClosed");
  const clock = requiredPort(ports.clock, "clock");
  if (typeof clock.now !== "function") throw new Error("command-center host requires the clock port");
  const dispatchFactory = requiredFunction(ports.createDispatch, "createDispatch");
  const runtimeMode: CommandCenterRuntimeMode = ports.runtimeMode ?? "record-only";
  if (runtimeMode !== "record-only" && runtimeMode !== "required") {
    throw new Error(`command-center host received an unknown runtime mode: ${String(runtimeMode)}`);
  }
  const runtime = ports.runtime;
  if (runtime !== undefined && typeof runtime.canRecord !== "function") {
    throw new Error("command-center host requires a valid runtime canRecord port");
  }
  const admission = ports.admission ?? (runtimeMode === "required"
    ? createRustCommandCenterAdmissionPort(transport, hostIdentity)
    : undefined);
  if (admission !== undefined) {
    for (const method of ["reserve", "hold", "release", "snapshot"] as const) {
      if (typeof admission[method] !== "function") {
        throw new Error(`command-center host requires a valid admission ${method} port`);
      }
    }
  }
  if (runtimeMode === "required") {
    if (runtime === undefined) throw new Error("command-center host requires a runtime dispatch consumer");
    if (typeof runtime.dispatch !== "function") {
      throw new Error("command-center host requires a runtime dispatch consumer");
    }
    if (admission === undefined) throw new Error("command-center host requires an admission port");
  }

  const repository = new RustCommandCenterRepository(transport, hostIdentity);
  const control = new CommandCenterControl({
    repository,
    hostIdentity,
    mutationsClosed,
    authorize: authorizer,
    now: () => clock.now(),
    ...(ports.dispatchTimeoutMs === undefined ? {} : { dispatchTimeoutMs: ports.dispatchTimeoutMs }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(admission === undefined ? {} : { admission }),
  });

  const dispatches = new Set<CommandCenterDispatchPort>();
  const create = (options: CommandCenterDispatchOptions = {}): CommandCenterDispatchPort => {
    const dispatch = dispatchFactory(control, options);
    if (!dispatch || typeof dispatch.dispatch !== "function" || typeof dispatch.dispose !== "function") {
      throw new Error("command-center host received an invalid dispatch factory result");
    }
    dispatches.add(dispatch);
    return dispatch;
  };

  const dispatch = create();
  return {
    repository,
    control,
    runtimeMode,
    admission: admission ?? null,
    admissionState: (principal: Principal, workspaceIds?: readonly string[]) =>
      control.admissionState(principal, workspaceIds),
    dispatch,
    createDispatch: create,
    async dispose(): Promise<void> {
      await Promise.all([...dispatches].map((item) => item.dispose()));
      dispatches.clear();
    },
  };
}
