const SPEECH_HTTP_PARSE = new Set([
  "bytes",
  "json-text",
  "json-path",
  "openai-transcription",
  "openai-chat-audio",
]);
const apiError = (code: string, message: string) => Object.assign(new Error(message), { code });

export function parseSpeechAdapterReply(value: unknown): {
  kind: "text" | "audio" | "http";
  text?: string;
  mimeType?: string;
  data?: string;
  call?: Record<string, unknown>;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw apiError("INVALID_ARGUMENT", "speech adapter reply is invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "text") {
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!text) throw apiError("PROVIDER_ERROR", "speech adapter returned empty text");
    return { kind: "text", text };
  }
  if (record.kind === "audio") {
    const data = typeof record.data === "string" ? record.data.trim() : "";
    const mimeType =
      typeof record.mimeType === "string" && record.mimeType.trim()
        ? record.mimeType.trim()
        : "application/octet-stream";
    if (!data) throw apiError("PROVIDER_ERROR", "speech adapter returned empty audio");
    return { kind: "audio", mimeType, data };
  }
  if (record.kind === "http") {
    const call = record.call;
    if (!call || typeof call !== "object" || Array.isArray(call)) {
      throw apiError("INVALID_ARGUMENT", "speech adapter http call is invalid");
    }
    const spec = call as Record<string, unknown>;
    if (typeof spec.url !== "string" || !spec.url.trim()) {
      throw apiError("INVALID_ARGUMENT", "speech adapter http call is invalid");
    }
    if (typeof spec.parse !== "string" || !SPEECH_HTTP_PARSE.has(spec.parse)) {
      throw apiError("INVALID_ARGUMENT", "speech adapter http parse is invalid");
    }
    return { kind: "http", call: spec };
  }
  throw apiError("INVALID_ARGUMENT", "speech adapter reply kind is invalid");
}
