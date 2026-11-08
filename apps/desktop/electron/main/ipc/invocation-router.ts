import { err, ErrorCodes, ok, type Result } from "@pi-desktop/shared";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { type BackendRouter, ROUTE_LOCAL } from "../remote/backend-router";
import type { DesktopHandoffAdmission } from "../runtime/handoff-admission";

async function wrap<T>(operation: () => Promise<T>): Promise<Result<T>> {
  try { return ok(await operation()); }
  catch (error) {
    const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
    const data = value.data && typeof value.data === "object" ? value.data as Record<string, unknown> : undefined;
    const code = data?.errorCode || value.errorCode;
    return err(typeof code === "string" ? code : ErrorCodes.INTERNAL,
      error instanceof Error ? error.message : String(error),
      { retriable: data?.retriable === true, details: value.data });
  }
}

/** Routes renderer traffic before local admission. Internal callers use the
 * same admitted handler, while event-bearing handlers keep their sender checks. */
export function createIpcInvocationRouter(options: {
  ipcMain: Pick<IpcMain, "handle">;
  admission: DesktopHandoffAdmission;
  getBackendRouter?: () => BackendRouter | null;
  observeInvoke(channel: string): void;
}) {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const handle = <Args extends unknown[], T>(channel: string, fn: (...args: Args) => Promise<T>): void => {
    const handler = (...args: Args) => options.admission.invoke(channel, async () => {
      const result = await fn(...args);
      options.observeInvoke(channel);
      return result;
    });
    handlers.set(channel, handler as (...args: unknown[]) => Promise<unknown>);
    options.ipcMain.handle(channel, async (_event, ...args: Args) => wrap(async () => {
      const router = options.getBackendRouter?.();
      if (router) {
        const outcome = await router.route(channel, args);
        if (outcome !== ROUTE_LOCAL) return outcome.value;
      }
      return handler(...args);
    }));
  };
  const handleWithEvent = <Args extends unknown[], T>(
    channel: string, fn: (event: IpcMainInvokeEvent, ...args: Args) => Promise<T>,
  ): void => {
    options.ipcMain.handle(channel, async (event, ...args: Args) =>
      wrap(() => options.admission.invoke(channel, () => fn(event, ...args))));
  };
  const invoke = async (channel: string, args: readonly unknown[] = []): Promise<unknown> => {
    const handler = handlers.get(channel);
    if (!handler) throw Object.assign(new Error(`IPC channel is not available to external agents: ${channel}`), {
      errorCode: ErrorCodes.NOT_FOUND,
    });
    return handler(...args);
  };
  return { handle, handleWithEvent, invoke };
}
