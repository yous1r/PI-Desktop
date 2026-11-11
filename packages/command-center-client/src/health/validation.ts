/** Matches the current RACP producer's { ok: true, serverTime: Date.toISOString() }. */
export function validPingReply(input: unknown): boolean {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes("ok") || !keys.includes("serverTime")) return false;
  const reply = input as Record<string, unknown>;
  const ok = reply.ok;
  const serverTime = reply.serverTime;
  if (ok !== true || typeof serverTime !== "string" || serverTime.length > 27 ||
      !/^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(serverTime)) return false;
  const time = Date.parse(serverTime);
  return Number.isFinite(time) && new Date(time).toISOString() === serverTime;
}

export function validClockTime(value: number, previous: number | undefined): boolean {
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER &&
    (previous === undefined || value >= previous);
}
