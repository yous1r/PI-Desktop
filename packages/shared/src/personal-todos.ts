import type { AppSettings } from "./types.js";

/** Personal notes belong to the local profile, never to an Agent session. */
export type PersonalTodoItem = {
  id: string;
  title: string;
  note: string;
  completed: boolean;
};

export const PERSONAL_TODO_MAX_ITEMS = 200;
export const PERSONAL_TODO_MAX_TITLE = 2000;
export const PERSONAL_TODO_MAX_NOTE = 20000;
export const PERSONAL_TODO_MAX_BYTES = 1_048_576;

export type PersonalTodoDocument = {
  schemaVersion: 1;
  revision: number;
  updatedAt: number | null;
  items: PersonalTodoItem[];
};

export type PersonalTodoReplace = {
  items: PersonalTodoItem[];
  expectedRevision: number;
  mutationId: string;
};

export type PersonalTodoSaveStatus = "loading" | "saved" | "pending" | "saving" | "error";
export type PersonalTodoAppearance = Pick<AppSettings, "language" | "theme" | "fontFamily">;
export type PersonalTodoView = {
  document: PersonalTodoDocument | null;
  items: PersonalTodoItem[];
  editVersion: number;
  savedEditVersion: number;
  saveStatus: PersonalTodoSaveStatus;
  error: { code: string; message: string } | null;
  alwaysOnTop: boolean;
  visible: boolean;
  appearance: PersonalTodoAppearance;
};
export type PersonalTodoEdit = { items: PersonalTodoItem[]; expectedEditVersion: number };
export type PersonalTodoWindowAction =
  | { action: "open" | "collapse" }
  | { action: "pin"; value: boolean };
export type PersonalTodoCopy = Pick<PersonalTodoItem, "title" | "note">;
/** A null requestId resumes editing after shutdown preparation is cancelled. */
export type PersonalTodoQuitRequest = { requestId: string | null };
