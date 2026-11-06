import { ErrorCodes } from "@pi-desktop/shared";
import type { AgentSidecar } from "./agent-sidecar";
import type { HostProcess } from "./host-process";
import type { createSessionLaunchRuntime } from "./runtime/session-launch";

type CommandInput = { sessionId: string; name: string; args: string };

type CommandDependencies = {
  getHost: () => Pick<HostProcess, "call"> | null;
  getSidecar: () => Pick<AgentSidecar, "call" | "setProjectInstructionRoot"> | null;
  acquireSessionOperation: (sessionId: string) => Promise<() => void>;
  resolveAgentRuntimeLaunch: ReturnType<typeof createSessionLaunchRuntime>["resolveAgentRuntimeLaunch"];
};

/** Prepare the session without opening a turn, then run the extension outside the admission lock. */
export async function runAgentExtensionCommand(
  input: CommandInput,
  deps: CommandDependencies,
): Promise<{ handled: boolean }> {
  if (input.sessionId.startsWith("native-pi:")) {
    throw Object.assign(new Error("Operation is unsupported for native Pi sessions"), {
      errorCode: "NATIVE_PI_UNSUPPORTED",
    });
  }
  const release = await deps.acquireSessionOperation(input.sessionId);
  let sidecar: ReturnType<CommandDependencies["getSidecar"]> = null;
  try {
    const host = deps.getHost();
    sidecar = deps.getSidecar();
    if (!host || !sidecar) throw new Error("backend unavailable");
    const { status } = await sidecar.call<{ status: { isRunning: boolean } }>(
      "agent.getStatus", { sessionId: input.sessionId },
    );
    // Commands may steer or abort a running turn. Do not reconfigure its runtime.
    if (!status.isRunning) {
      const [detail, settings] = await Promise.all([
        host.call<{ session?: Record<string, unknown> }>("session.get", {
          id: input.sessionId,
          messageLimit: 1,
        }),
        host.call<Record<string, unknown>>("settings.get"),
      ]);
      if (!detail.session) {
        throw Object.assign(new Error("Session not found"), { errorCode: ErrorCodes.NOT_FOUND });
      }
      const launch = await deps.resolveAgentRuntimeLaunch(input.sessionId, detail.session, settings);
      sidecar.setProjectInstructionRoot(input.sessionId, launch.workspaceRoot ?? launch.projectPath);
      await sidecar.call("extensions.command.prepare", launch.sidecarParams);
    }
  } finally {
    release();
  }
  // UI prompts and sendUserMessage can wait for another session operation.
  // Holding the admission lock during the handler would prevent that progress.
  return sidecar.call<{ handled: boolean }>("extensions.command.run", input);
}
