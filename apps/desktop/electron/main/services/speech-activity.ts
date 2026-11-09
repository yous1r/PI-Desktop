import type { SpeechHttpContext } from "@pi-desktop/agent-runtime";
import { ExternalResourceActivity } from "../external-resource-activity";
import type { HostProcess } from "../host-process";

type Host = Pick<HostProcess, "call" | "generation" | "isAvailable">;
export type SpeechAuthority = { getHost(): Host | null; isAdmissionClosed(): boolean; onCleanupError(): void };
export type SpeechOperation = {
  assertCurrent(): void;
  bindResource(assertCurrent: () => void): void;
  wait<T>(operation: () => Promise<T>): Promise<T>;
  call<T>(method: string, params?: unknown): Promise<T>;
  http: Pick<SpeechHttpContext, "signal" | "assertCurrent" | "beforeRequest" | "onCleanupError">;
};

/** One admitted Speech operation retains its original Host, transport and file work. */
export class SpeechActivity {
  private readonly activity: ExternalResourceActivity;
  private readonly controllers = new Set<AbortController>();
  private uncertainty = 0;
  private readonly options: SpeechAuthority;
  constructor(options: SpeechAuthority) { this.options = options; this.activity = new ExternalResourceActivity(options.isAdmissionClosed); }
  dispose(): void { this.activity.seal(); for (const controller of this.controllers) controller.abort(); }
  snapshot() {
    const value = this.activity.snapshot();
    return { ...value, uncontainedResources: Math.min(Number.MAX_SAFE_INTEGER, value.uncontainedResources + this.uncertainty) };
  }
  private uncertain(): void { this.uncertainty = Math.min(Number.MAX_SAFE_INTEGER, this.uncertainty + 1); }
  run<T>(operation: (owner: SpeechOperation) => Promise<T>): Promise<T> {
    return this.activity.run(async () => {
      const host = this.options.getHost(), generation = host?.generation;
      const controller = new AbortController();
      let assertResource = () => {};
      const assertCurrent = () => {
        this.activity.assertOpen();
        if (!host || this.options.getHost() !== host || host.generation !== generation || !host.isAvailable()) {
          throw Object.assign(new Error("Original Speech Host is unavailable"), { errorCode: "HOST_UNAVAILABLE" });
        }
        controller.signal.throwIfAborted(); assertResource();
      };
      const wait = async <R>(work: () => Promise<R>): Promise<R> => {
        assertCurrent(); const result = await work(); assertCurrent(); return result;
      };
      assertCurrent(); this.controllers.add(controller);
      try {
        const result = await operation({ assertCurrent, wait,
          bindResource: guard => { assertResource = guard; assertCurrent(); },
          call: <R>(method: string, params?: unknown) => wait(async () => {
            try { return await host!.call<R>(method, params); }
            catch (error) {
              const detail = error && typeof error === "object" ? error as { code?: unknown; errorCode?: unknown } : {};
              const code = detail.errorCode ?? detail.code;
              if (typeof detail.code !== "number" && !(typeof code === "string" && !["HOST_UNAVAILABLE", "HOST_TIMEOUT", "TIMEOUT", "TRANSPORT_LOST"].includes(code))) this.uncertain();
              throw error;
            }
          }),
          http: { signal: controller.signal, assertCurrent,
            beforeRequest: () => { assertCurrent(); this.activity.nativeAttempt(); },
            onCleanupError: () => {
              this.uncertain();
              try { this.options.onCleanupError(); }
              catch { console.error("Speech response cleanup could not be confirmed"); }
            },
          },
        });
        assertCurrent(); return result;
      } finally { this.controllers.delete(controller); }
    });
  }
}
