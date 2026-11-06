/** Release selection is separate from protocol negotiation and persisted data. */
export type HostReleaseRelation = "match" | "older" | "newer" | "unsupported";
type Release = { core: string[]; pre: string[]; channel: string; normalized: string };

function parse(value: string): Release | undefined {
  const normalized = value.trim().replace(/^v/, "");
  if (normalized.length > 128) return undefined;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(normalized);
  if (!match) return undefined;
  const pre = match[4]?.split(".") ?? [];
  if (pre.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return undefined;
  return { core: match.slice(1, 4), pre, channel: pre[0] ?? "stable", normalized };
}
function numeric(a: string, b: string): number {
  return a.length === b.length ? (a < b ? -1 : a > b ? 1 : 0) : a.length < b.length ? -1 : 1;
}
function compare(a: Release, b: Release): number {
  for (let i = 0; i < 3; i++) {
    const order = numeric(a.core[i]!, b.core[i]!);
    if (order) return order;
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const left = a.pre[i], right = b.pre[i];
    if (left === undefined || right === undefined) return left === undefined ? -1 : 1;
    if (left === right) continue;
    const ln = /^\d+$/.test(left), rn = /^\d+$/.test(right);
    return ln && rn ? numeric(left, right) : ln !== rn ? (ln ? -1 : 1) : left < right ? -1 : 1;
  }
  return 0;
}
export function hostReleaseRelation(remote: string, desktop: string): HostReleaseRelation {
  const a = parse(remote), b = parse(desktop);
  if (!a || !b) return "unsupported";
  if (a.normalized === b.normalized) return "match";
  const order = compare(a, b);
  if (order > 0) return "newer";
  if (a.channel !== b.channel || order === 0) return "unsupported";
  return "older";
}

export function assertMatchingHostRelease(remote: string, desktop: string): void {
  const relation = hostReleaseRelation(remote, desktop);
  if (relation === "match") return;
  const errorCode = relation === "newer" ? "HOST_CLIENT_TOO_OLD"
    : relation === "older" ? "HOST_VERSION_MISMATCH" : "HOST_VERSION_UNSUPPORTED";
  throw Object.assign(new Error("Remote Host release does not match this Desktop"), {
    errorCode, retriable: false, remoteVersion: remote, targetVersion: desktop,
  });
}
