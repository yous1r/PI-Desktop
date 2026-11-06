import { Buffer } from "node:buffer";
import {
  PERSONAL_TODO_MAX_BYTES, PERSONAL_TODO_MAX_ITEMS, PERSONAL_TODO_MAX_NOTE,
  PERSONAL_TODO_MAX_TITLE, type PersonalTodoItem,
} from "@pi-desktop/shared";

export function todoError(code: string, message: string): Error & { errorCode: string } {
  return Object.assign(new Error(message), { errorCode: code });
}
export function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) {
    throw todoError("INVALID_ARGUMENT", "Invalid personal todo request");
  }
  return value as Record<string, unknown>;
}
export function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.includes("\0") || [...value].length > max) {
    throw todoError("INVALID_ARGUMENT", "Personal todo text exceeds its limits");
  }
  return value;
}
export function parseItems(value: unknown): PersonalTodoItem[] {
  if (!Array.isArray(value) || value.length > PERSONAL_TODO_MAX_ITEMS) {
    throw todoError("INVALID_ARGUMENT", "Too many personal todos");
  }
  const ids = new Set<string>();
  const items = value.map((item) => {
    const row = record(item, ["id", "title", "note", "completed"]);
    const id = text(row.id, 128);
    if (!id.trim() || ids.has(id) || typeof row.completed !== "boolean") {
      throw todoError("INVALID_ARGUMENT", "Invalid personal todo identity or state");
    }
    ids.add(id);
    return { id, title: text(row.title, PERSONAL_TODO_MAX_TITLE),
      note: text(row.note, PERSONAL_TODO_MAX_NOTE), completed: row.completed };
  });
  // Reserve the largest supported metadata envelope before accepting a draft.
  const document = { schemaVersion: 1, revision: Number.MAX_SAFE_INTEGER,
    updatedAt: Number.MAX_SAFE_INTEGER, items };
  if (Buffer.byteLength(JSON.stringify(document), "utf8") > PERSONAL_TODO_MAX_BYTES) {
    throw todoError("INVALID_ARGUMENT", "Personal todo board exceeds its size limit");
  }
  return items;
}
