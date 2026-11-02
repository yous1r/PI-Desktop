/** Known transport credentials must never become tool context or error logs. */
export function redactMcpCredentials(value: unknown, credentials: readonly string[] = []): unknown {
  const secrets = credentials.filter((item) => item.length > 0);
  if (!secrets.length) return value;
  const mask = (text: string): string => {
    let safe = text;
    for (const secret of secrets) safe = safe.replaceAll(secret, "[redacted]");
    return safe;
  };
  const visit = (input: unknown, depth: number): unknown => {
    if (depth > 64) throw new Error("MCP response nesting exceeds the safe redaction limit.");
    if (typeof input === "string") return mask(input);
    if (Array.isArray(input)) return input.map((item) => visit(item, depth + 1));
    if (!input || typeof input !== "object") return input;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input)) Object.defineProperty(out, mask(key), {
      value: visit(item, depth + 1), enumerable: true, writable: true, configurable: true,
    });
    return out;
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result) ?? "") > 4 * 1024 * 1024) throw new Error("MCP response exceeds the safe redaction budget.");
  return result;
}

/** Parser/network errors may quote response bytes; never retain their original stack or cause. */
export function redactMcpError(error: Error, credentials: readonly string[] = []): Error {
  if (!credentials.some((value) => value.length > 0)) return error;
  try {
    const mask = (text: string): string => String(redactMcpCredentials(text, credentials));
    const coded = error as Error & { code?: unknown; errorCode?: unknown; status?: unknown };
    return Object.assign(new Error(mask(error.message)), {
      name: mask(error.name),
      ...(typeof coded.code === "string" ? { code: mask(coded.code) } : {}),
      ...(typeof coded.errorCode === "string" ? { errorCode: mask(coded.errorCode) } : {}),
      ...(typeof coded.status === "number" ? { status: coded.status } : {}),
    });
  } catch {
    return Object.assign(new Error("MCP request could not be processed safely."), { code: "INVALID_RESPONSE" });
  }
}
