import {
  clonePluginExtensionData, PLUGIN_EXTENSION_OWNER_TIMEOUT_MS,
  type PluginExtensionCallContext, type PluginExtensionOperation,
} from "@pi-desktop/shared";
import type { PluginToolInvocations } from "./plugin-tool-invocations";

type Owner = {
  disposing: boolean;
  permissions: Set<string>;
  manifest: { id: string; contributes?: { agentExtensionOperations?: PluginExtensionOperation[] } };
};
type Send = (message: {
  t: "call"; method: string; invocationId: string;
  payload: { operation: string; payload: unknown; context: Omit<PluginExtensionCallContext, "signal"> };
}, timeoutMs: number, signal: AbortSignal) => Promise<unknown>;

/** Owner calls share the existing invocation authority and descendant cancellation. */
export async function dispatchPluginExtension(
  owner: Owner, invocations: PluginToolInvocations, send: Send,
  operation: string, payload: unknown, context: PluginExtensionCallContext & { signal: AbortSignal },
): Promise<unknown> {
  const declaration = owner.manifest.contributes?.agentExtensionOperations?.find((item) => item.name === operation);
  if (owner.disposing || !owner.permissions.has("agent.extension") || !declaration ||
      (context.mode !== "agent" && !declaration.readOnly)) throw new Error("Extension owner operation is not authorized");
  const { signal, ...wireContext } = context;
  const invocation = invocations.begin(owner, { pluginId: owner.manifest.id,
    sessionId: context.sessionId, turnId: context.turnId, toolName: `extension:${operation}`, signal });
  try {
    const result = await send({ t: "call", method: "extension.owner", invocationId: invocation.id,
      payload: { operation, payload: clonePluginExtensionData(payload), context: wireContext } },
    PLUGIN_EXTENSION_OWNER_TIMEOUT_MS, invocation.signal);
    invocation.signal.throwIfAborted();
    return clonePluginExtensionData(result);
  } finally {
    invocations.finish(invocation);
  }
}
