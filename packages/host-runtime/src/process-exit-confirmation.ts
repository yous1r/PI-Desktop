import type { ChildProcess } from "node:child_process";

/**
 * Observe only this ChildProcess instance; never signal it or look up a PID.
 * Transport closure, a successful kill request and bounded dispose completion
 * do not establish exit. This does not certify descendants or durable ownership.
 */
export async function confirmChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError("Exit confirmation timeout must be an integer from 0 to 2147483647 ms");
  }
  const exited = () => child.pid !== undefined &&
    (child.exitCode !== null || child.signalCode !== null);
  if (exited()) return true;
  if (timeoutMs === 0 || child.pid === undefined) return false;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onTerminal);
      child.off("close", onTerminal);
      resolve(confirmed);
    };
    const onTerminal = () => finish(exited());
    // Keep close as well: transport cleanup may remove exit listeners while
    // the process is still alive. Node closes a child only after process exit
    // and stream closure; inspect the original child's exit fields either way.
    child.once("exit", onTerminal);
    child.once("close", onTerminal);
    const timer = setTimeout(() => finish(exited()), timeoutMs);
    timer.unref?.();
  });
}
