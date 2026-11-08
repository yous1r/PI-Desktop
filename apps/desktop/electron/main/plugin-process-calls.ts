import type { LoadedPlugin, PluginPanelBridgeContext } from "./plugin-runtime";

export type PendingPluginCall = {
  teardown: boolean;
  retirement: boolean;
  signal: AbortSignal;
  owner?: PluginPanelBridgeContext;
  resolve(value: unknown): void;
  reject(error: Error, answered?: boolean): void;
  timer: ReturnType<typeof setTimeout>;
};

const callError = (code: string, message: string): Error & { code: string } => Object.assign(new Error(message), { code });

/** One original child owns each request, its deadline and cancellation signal. */
export async function sendPluginProcessCall(
  loaded: LoadedPlugin,
  message: Record<string, unknown>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  owner: PluginPanelBridgeContext | undefined,
  uncertain: () => void,
  retirement = false,
): Promise<unknown> {
  const child = loaded.child;
  if (!child) throw callError("NOT_FOUND", `plugin host process gone: ${loaded.manifest.id}`);
  if (signal?.aborted) throw signal.reason;
  const id = `h${loaded.nextCallId++}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const controller = new AbortController();
    const cancelChild = (error: Error) => {
      const cancellation = typeof message.invocationId === "string" ? { invocationId: message.invocationId } : { callId: id };
      try { child.postMessage({ t: "cancel", ...cancellation, reason: error.message }); }
      catch { /* The process may already be gone; the host still revokes the call. */ }
    };
    const abort = () => {
      const error = signal?.reason instanceof Error ? signal.reason : callError("PLUGIN_TOOL_ABORTED", "Plugin tool execution aborted");
      loaded.pending.get(id)?.reject(error);
      cancelChild(error);
    };
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      loaded.pending.delete(id);
      signal?.removeEventListener("abort", abort);
    };
    const timer = setTimeout(() => {
      const error = callError("TIMEOUT", `plugin ${loaded.manifest.id} did not answer ${String(message.t)}`);
      loaded.pending.get(id)?.reject(error);
      cancelChild(error);
    }, timeoutMs);
    loaded.pending.set(id, {
      teardown: message.t === "call" && (message.method === "lifecycle.unload" || message.method === "service.stop"),
      retirement,
      signal: controller.signal, owner,
      resolve: value => { if (settled) return; cleanup(); resolve(value); },
      reject: (error, answered = false) => { if (settled) return; if (!answered) uncertain(); cleanup(); controller.abort(error); reject(error); },
      timer,
    });
    signal?.addEventListener("abort", abort, { once: true });
    try { child.postMessage({ ...message, id }); }
    catch (error) { loaded.pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error))); }
  });
}
