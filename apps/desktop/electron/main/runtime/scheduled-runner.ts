type Host = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };
export type ScheduledLaunch = { sessionId: string; prompt: string; runId: string };

/** Runs through the same prompt entry point as an interactive desktop turn. */
export async function executeScheduledTask(options: {
  host: Host;
  isCurrent: () => boolean;
  id: string;
  automatic: boolean;
  runs: Map<string, string>;
  gate?: { isClosed(): boolean };
  prompt: (sessionId: string, content: string) => Promise<unknown>;
}): Promise<ScheduledLaunch> {
  const { host, id, automatic, runs, prompt, isCurrent } = options;
  if (options.gate?.isClosed()) throw Object.assign(new Error("HOST_BUSY"), { errorCode: "HOST_BUSY" });
  const launch = await host.call<ScheduledLaunch>("scheduled.run", { id, automatic });
  try {
    if (!isCurrent()) throw new Error("scheduled runtime stopped");
    if (options.gate?.isClosed()) throw Object.assign(new Error("HOST_BUSY"), { errorCode: "HOST_BUSY" });
    runs.set(launch.sessionId, launch.runId);
    await prompt(launch.sessionId, launch.prompt);
    return launch;
  } catch (error) {
    if (runs.get(launch.sessionId) === launch.runId) runs.delete(launch.sessionId);
    try {
      await host.call("scheduled.finishRun", {
        runId: launch.runId,
        status: "error",
        errorCode: "SCHEDULE_DISPATCH_FAILED",
      });
    } catch (persistenceError) {
      throw new AggregateError([error, persistenceError], "Scheduled dispatch and failure recording both failed");
    }
    throw error;
  }
}

export function createScheduledRunner(options: {
  getHost: () => Host | null;
  execute: (id: string) => Promise<unknown>;
  report: (error: unknown) => void;
  gate?: { isClosed(): boolean };
}) {
  let stopped = false;
  let polling = false;
  let activeDispatches = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const dispatches = new Map<string, { host: Host }>();
  const tick = async () => {
    if (stopped || polling || options.gate?.isClosed()) return;
    const host = options.getHost();
    if (!host) return;
    polling = true;
    try {
      const { ids } = await host.call<{ ids: string[] }>("scheduled.due");
      for (const id of ids) {
        if (stopped || options.getHost() !== host || options.gate?.isClosed()) break;
        if (dispatches.get(id)?.host === host) continue;
        const owner = { host };
        dispatches.set(id, owner);
        activeDispatches += 1;
        // Polling owns admission requests, not the duration of prompt setup.
        // Host remains authoritative for enabled/due/overlap checks. Keep a
        // local owner until setup settles so another poll cannot dispatch the
        // same task while its admission request is still in flight.
        void (async () => {
          try {
            await options.execute(id);
          } catch (error) {
            options.report(error);
          } finally {
            activeDispatches -= 1;
            if (dispatches.get(id) === owner) dispatches.delete(id);
          }
        })();
      }
    } catch (error) {
      options.report(error);
    } finally {
      polling = false;
    }
  };
  return {
    tick,
    inFlightCount: () => Number(polling) + activeDispatches,
    start() {
      if (timer || stopped) return;
      timer = setInterval(() => void tick(), 30_000);
      timer.unref();
      void tick();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
