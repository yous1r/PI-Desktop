export type TodoBounds = { x: number; y: number; width: number; height: number };
export type TodoPreferences = { alwaysOnTop: boolean; bounds?: TodoBounds };
export const TODO_DEFAULT_SIZE = { width: 360, height: 480 };
export const TODO_COMPACT_SIZE = { width: 200, height: 52 };
export function dockTodoBounds(bounds: TodoBounds, work: TodoBounds): TodoBounds {
  const width = Math.min(TODO_COMPACT_SIZE.width, work.width);
  return {
    x: Math.round(Math.max(work.x, Math.min(bounds.x + bounds.width - width, work.x + work.width - width))),
    y: work.y,
    width,
    height: Math.min(TODO_COMPACT_SIZE.height, work.height),
  };
}
export function clampTodoBounds(bounds: TodoBounds, work: TodoBounds): TodoBounds {
  const width = Math.min(Math.max(300, bounds.width), work.width);
  const height = Math.min(Math.max(280, bounds.height), work.height);
  return {
    x: Math.round(Math.max(work.x, Math.min(bounds.x, work.x + work.width - width))),
    y: Math.round(Math.max(work.y, Math.min(bounds.y, work.y + work.height - height))),
    width: Math.round(width), height: Math.round(height),
  };
}
export function parseTodoPreferences(raw: string): TodoPreferences {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("Invalid personal todo preferences");
  const record = value as Record<string, unknown>;
  const preferences: TodoPreferences = { alwaysOnTop: record.alwaysOnTop !== false };
  if (record.bounds && typeof record.bounds === "object") {
    const bounds = record.bounds as TodoBounds;
    if ([bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
      && bounds.width > 0 && bounds.height > 0) preferences.bounds = bounds;
  }
  return preferences;
}
