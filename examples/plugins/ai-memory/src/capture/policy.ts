import { MemoryError, record, text, type CapturePolicy } from '../contracts.js';

const SECRET_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|environment|^env$)/i;
const BINARY_KEY = /^(?:images?|attachments?|binary|base64|data|transcript|transcriptPath)$/i;
const PROTECTED_PATH = /(?:^|[\/\\\s"'=])(?:\.env(?:\.[\w.-]+)?|\.ssh|\.aws|credentials(?:\.json)?|secrets?)(?:$|[\/\\\s"'])|\.(?:pem|key|p12|pfx)(?:$|[\s"'])/i;
export function redactText(value: string): string {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi, '[REDACTED AUTH]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED TOKEN]')
    .replace(/((?:password|passwd|token|secret|api[_-]?key|authorization)["']?\s*[:=]\s*)["'][^\r\n]*/gi, '$1[REDACTED]')
    .replace(/((?:password|passwd|token|secret|api[_-]?key|authorization)\s*[=:]\s*)[^\s,;"'}]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}
function glob(pattern: string): RegExp {
  let expression = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*' && pattern[i + 1] === '*') { expression += '.*'; i++; }
    else if (char === '*') expression += '[^/]*';
    else if (char === '?') expression += '[^/]';
    else expression += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`(?:^|[/\\s"'=])${expression}(?:$|[/\\s"'])`, 'i');
}
/** Drop the entire event when a protected path appears, including in shell text. */
export function excluded(value: unknown, ignores: string[], depth = 0): boolean {
  if (depth > 12) return true;
  if (typeof value === 'string') {
    if (PROTECTED_PATH.test(value)) return true;
    const normalized = value.replace(/\\/g, '/');
    return ignores.some(pattern => glob(pattern.replace(/\\/g, '/')).test(normalized));
  }
  if (Array.isArray(value)) return value.some(item => excluded(item, ignores, depth + 1));
  if (value && typeof value === 'object') return Object.values(value).some(item => excluded(item, ignores, depth + 1));
  return false;
}
export function sanitize(value: unknown, budget = 8000): unknown {
  let remaining = budget;
  function visit(item: unknown, depth: number): unknown {
    if (remaining <= 0 || depth > 8) return '[TRUNCATED]';
    if (typeof item === 'string') {
      const clean = redactText(item);
      const result = clean.slice(0, Math.max(0, remaining));
      remaining -= result.length;
      return clean.length > result.length ? `${result}[TRUNCATED]` : result;
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'number') { remaining -= 8; return item; }
    if (Array.isArray(item)) {
      const result: unknown[] = [];
      for (const part of item.slice(0, 40)) { if (remaining <= 0) break; remaining -= 2; result.push(visit(part, depth + 1)); }
      return result;
    }
    if (item && typeof item === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, part] of Object.entries(item).slice(0, 60)) {
        if (remaining <= 0) { result.truncated = true; break; }
        remaining -= Math.min(key.length, 80) + 16;
        if (['__proto__', 'constructor', 'prototype'].includes(key) || BINARY_KEY.test(key)) continue;
        result[key.slice(0, 80)] = SECRET_KEY.test(key) ? '[REDACTED]' : visit(part, depth + 1);
      }
      return result;
    }
    return undefined;
  }
  return visit(value, 0);
}
export const EVENT_TYPES = ['session_start', 'prompt', 'tool_call', 'tool_result', 'agent_end', 'compact', 'retire'] as const;
export type CaptureType = typeof EVENT_TYPES[number];
export interface CaptureEvent { type: CaptureType; eventId: string; data: Record<string, unknown> }
export function normalize(input: unknown, policy: CapturePolicy): CaptureEvent | null {
  const raw = record(input);
  if (!EVENT_TYPES.includes(raw.type as CaptureType)) throw new MemoryError('INVALID_EVENT');
  const eventId = text(raw.eventId, 200);
  const data = raw.data === undefined ? {} : record(raw.data);
  if (excluded(data, policy.ignorePaths)) return null;
  const result: Record<string, unknown> = {};
  for (const key of ['toolName', 'toolCallId', 'outcome', 'reason']) {
    if (typeof data[key] === 'string') result[key] = data[key].slice(0, 200);
  }
  if (typeof data.isError === 'boolean') result.isError = data.isError;
  if (typeof data.cancelled === 'boolean') result.cancelled = data.cancelled;
  if (policy.prompts && raw.type === 'prompt') result.prompt = data.prompt;
  if (policy.toolArguments && (raw.type === 'tool_call' || raw.type === 'tool_result')) result.args = data.input;
  if (policy.toolResults && raw.type === 'tool_result') result.output = textParts(data.content);
  if (policy.assistant && raw.type === 'agent_end') result.response = textParts(data.content);
  return { type: raw.type as CaptureType, eventId, data: record(sanitize(result, policy.maxChars)) };
}
export function textParts(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const part = item as Record<string, unknown>;
    return part.type === 'text' && typeof part.text === 'string' ? [part.text] : [];
  }).join('\n');
}
