import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import type { TerminalShellProfile, WorkspaceTerminalRequest, WorkspaceTerminalOwner, WorkspaceTerminalEvent } from "@pi-desktop/shared";

export type WorkspacePty = {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause?(): void;
  resume?(): void;
  onData(handler: (data: string) => void): { dispose(): void };
  onExit(handler: (event: { exitCode: number }) => void): { dispose(): void };
};
export type WorkspacePtyModule = { spawn(file: string, args: string[], options: { name: string; cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv }): WorkspacePty };
export type WorkspaceTerminalSink = (event: WorkspaceTerminalEvent) => Promise<void>;
type RecordState = {
  id: string; deviceId: string; connectionId: string | null; workspaceId: string; root: string; tabId: string;
  shellId: string; pty: WorkspacePty; cols: number; rows: number; ring: Buffer; sequence: number;
  sink: WorkspaceTerminalSink | null; cleanup: (() => void)[]; pending: Promise<void>; queuedBytes: number;
  expiry?: ReturnType<typeof setTimeout>; closed: boolean;
};
const RING_BYTES = 256 * 1024;
const FRAME_BYTES = 32 * 1024;
const QUEUE_BYTES = 1024 * 1024;
const failure = (code: string, message: string) => Object.assign(new Error(message), { code, errorCode: code });
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };
function tail(buffer: Buffer, limit: number): Buffer {
  let start = Math.max(0, buffer.length - limit);
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start);
}
/** Only the executing machine's shell environment; Desktop secrets never cross hosts. */
export function workspaceShellEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERMINFO", "SystemRoot", "WINDIR", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP", "TMPDIR", "APPDATA", "LOCALAPPDATA", "SSH_AUTH_SOCK"]) {
    if (base[key] !== undefined) result[key] = base[key];
  }
  result.HOME ??= homedir();
  result.TERM = "xterm-256color";
  return result;
}

/** Transport-independent PTYs, used by Desktop and the headless Host. */
export class WorkspaceTerminalService {
  private readonly records = new Map<string, RecordState>();
  private sealed = false;
  private readonly admissions = new Map<string, Set<{ cancelled: boolean }>>();
  constructor(private readonly options: {
    pty: WorkspacePtyModule;
    shells: (refresh?: boolean) => TerminalShellProfile[];
    detachMs?: number;
    env?: NodeJS.ProcessEnv;
    onError?: (message: string) => void;
  }) {}

  async handle(input: WorkspaceTerminalRequest, owner: WorkspaceTerminalOwner, sink: WorkspaceTerminalSink): Promise<unknown> {
    const token = { cancelled: false };
    const requests = this.admissions.get(owner.connectionId) ?? new Set<{ cancelled: boolean }>();
    requests.add(token); this.admissions.set(owner.connectionId, requests);
    try { return await this.execute(input, owner, sink, token); }
    finally { requests.delete(token); if (!requests.size) this.admissions.delete(owner.connectionId); }
  }

  private async execute(input: WorkspaceTerminalRequest, owner: WorkspaceTerminalOwner, sink: WorkspaceTerminalSink, token: { cancelled: boolean }): Promise<unknown> {
    if (this.sealed) throw failure("TERMINAL_HOST_OFFLINE", "Terminal service is stopping");
    if (!owner.deviceId || !owner.connectionId) throw failure("FORBIDDEN", "Terminal owner is required");
    if (!isAbsolute(input.path) || /[\u0000-\u001f]/.test(input.path)) throw failure("INVALID_ARGUMENT", "Invalid workspace root");
    const root = await realpath(input.path).catch(() => null);
    if (!root || !(await stat(root)).isDirectory()) throw failure("REMOTE_PATH_NOT_FOUND", "Workspace root is unavailable");
    if (token.cancelled || this.sealed) throw failure("TERMINAL_HOST_OFFLINE", "Terminal connection closed");
    if (input.action === "list") return { shells: this.options.shells(input.refresh) };
    if (input.action === "create") return this.create(input, root, owner, sink, token);
    const record = this.records.get(input.terminalId);
    if (!record) {
      if (input.action === "replay") return { data: null };
      if (input.action === "close") return { ok: true };
      throw failure("TERMINAL_GONE", "Terminal is no longer running");
    }
    if (record.deviceId !== owner.deviceId || record.workspaceId !== input.workspaceId || record.root !== root) {
      throw failure("FORBIDDEN", "Terminal does not belong to this workspace and device");
    }
    if (input.action === "replay") {
      // Re-attach is explicit and permitted only to the original device/workspace.
      if (record.connectionId && record.connectionId !== owner.connectionId) throw failure("CONFLICT", "Terminal is attached to another connection");
      clearTimeout(record.expiry);
      record.expiry = undefined;
      record.connectionId = owner.connectionId;
      record.sink = sink;
      return { data: tail(record.ring, input.maxBytes ?? RING_BYTES).toString("base64"), sequence: record.sequence };
    }
    if (input.action === "close") {
      this.closeRecord(record);
      return { ok: true };
    }
    if (record.connectionId !== owner.connectionId) throw failure("TERMINAL_HOST_OFFLINE", "Re-attach the terminal before sending input");
    switch (input.action) {
      case "write":
        if (Buffer.byteLength(input.data, "utf8") > 65536) throw failure("INVALID_ARGUMENT", "Terminal input exceeds the limit");
        record.pty.write(input.data);
        return { ok: true };
      case "resize":
        record.pty.resize(input.cols, input.rows);
        record.cols = input.cols; record.rows = input.rows;
        return { ok: true };
      case "buffer": {
        const bytes = tail(record.ring, input.maxBytes ?? 32768);
        return { text: bytes.toString("utf8").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ""), truncated: record.ring.length > bytes.length };
      }
    }
  }

  private async create(input: Extract<WorkspaceTerminalRequest, { action: "create" }>, root: string, owner: WorkspaceTerminalOwner, sink: WorkspaceTerminalSink, token: { cancelled: boolean }) {
    if ([...this.records.values()].some(record => record.deviceId === owner.deviceId && record.workspaceId === input.workspaceId && record.tabId === input.tabId)) {
      throw failure("CONFLICT", "This tab already owns a terminal; attach or close it first");
    }
    if (this.records.size >= 64 || [...this.records.values()].filter(record => record.deviceId === owner.deviceId).length >= 8) {
      throw failure("TERMINAL_LIMIT_REACHED", "Terminal limit reached");
    }
    const profile = this.options.shells().find(shell => shell.id === input.shellId);
    if (!profile?.path) throw failure("TERMINAL_SHELL_UNAVAILABLE", "The selected shell is unavailable");
    const cwd = input.cwd ? await realpath(input.cwd).catch(() => null) : root;
    if (!cwd || !inside(root, cwd) || !(await stat(cwd)).isDirectory()) throw failure("REMOTE_PATH_FORBIDDEN", "Terminal directory must stay inside the workspace");
    if (this.sealed || token.cancelled) throw failure("TERMINAL_HOST_OFFLINE", "Terminal service is stopping");
    // Recheck after directory I/O: concurrent creates must not bypass limits/tab ownership.
    if (this.records.size >= 64 || [...this.records.values()].filter(record => record.deviceId === owner.deviceId).length >= 8) throw failure("TERMINAL_LIMIT_REACHED", "Terminal limit reached");
    if ([...this.records.values()].some(record => record.deviceId === owner.deviceId && record.workspaceId === input.workspaceId && record.tabId === input.tabId)) throw failure("CONFLICT", "This tab already owns a terminal");
    let pty: WorkspacePty;
    try { pty = this.options.pty.spawn(profile.path, profile.args ?? [], { name: "xterm-256color", cwd, cols: input.cols, rows: input.rows, env: workspaceShellEnvironment(this.options.env) }); }
    catch { throw failure("TERMINAL_SHELL_UNAVAILABLE", "The selected shell could not be started"); }
    const record: RecordState = {
      id: `wterm_${randomUUID()}`, deviceId: owner.deviceId, connectionId: owner.connectionId,
      workspaceId: input.workspaceId, root, tabId: input.tabId, shellId: profile.id, pty,
      cols: input.cols, rows: input.rows, ring: Buffer.alloc(0), sequence: 0, sink, cleanup: [], pending: Promise.resolve(), queuedBytes: 0, closed: false,
    };
    this.records.set(record.id, record);
    try {
      const dataListener = pty.onData(data => this.output(record, data));
      record.cleanup.push(() => dataListener.dispose());
      const exitListener = pty.onExit(({ exitCode }) => {
        const target = record.sink;
        // Preserve final output ordering: close only after already accepted frames.
        record.pending = record.pending.then(async () => {
          if (!record.closed && record.sink === target) await target?.({ terminalId: record.id, exitCode });
        }).catch(() => undefined).finally(() => this.closeRecord(record, false));
      });
      record.cleanup.push(() => exitListener.dispose());
    } catch (error) { this.closeRecord(record); throw error; }
    return { terminalId: record.id, shellId: profile.id, cols: record.cols, rows: record.rows };
  }

  private output(record: RecordState, data: string): void {
    if (record.closed) return;
    const bytes = Buffer.from(data, "utf8");
    record.ring = Buffer.from(tail(Buffer.concat([record.ring, tail(bytes, RING_BYTES)]), RING_BYTES));
    let sink = record.sink;
    let connection = record.connectionId;

    if (record.queuedBytes + bytes.length > QUEUE_BYTES) {
      this.options.onError?.("Terminal output queue exceeded its limit; detaching until replay");
      this.detachRecord(record);
      sink = null; connection = null;
    }
    if (sink && connection) record.queuedBytes += bytes.length;
    if (record.queuedBytes > FRAME_BYTES * 2) record.pty.pause?.();
    for (let offset = 0; offset < bytes.length;) {
      let end = Math.min(bytes.length, offset + FRAME_BYTES);
      while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
      const chunk = bytes.subarray(offset, end);
      offset = end;
      const sequence = ++record.sequence;
      if (!sink || !connection) continue;
      record.pending = record.pending.then(async () => {
        if (!record.closed && record.sink === sink && record.connectionId === connection) await sink({ terminalId: record.id, data: chunk.toString("base64"), sequence });
      }).catch(() => {
        if (record.sink === sink) this.detachRecord(record);
      }).finally(() => {
        record.queuedBytes -= chunk.length;
        if (!record.closed && record.queuedBytes < FRAME_BYTES) record.pty.resume?.();
      });
    }
  }

  private detachRecord(record: RecordState): void {
    record.sink = null; record.connectionId = null;
    record.pty.resume?.();
    clearTimeout(record.expiry);
    record.expiry = setTimeout(() => this.closeRecord(record), this.options.detachMs ?? 5 * 60_000);
    record.expiry.unref?.();
  }
  disconnect(connectionId: string): void {
    for (const token of this.admissions.get(connectionId) ?? []) token.cancelled = true;
    for (const record of this.records.values()) if (record.connectionId === connectionId) this.detachRecord(record);
  }
  revoke(deviceId: string): void {
    for (const record of this.records.values()) if (record.deviceId === deviceId) this.closeRecord(record);
  }
  private closeRecord(record: RecordState, kill = true): void {
    if (record.closed) return;
    record.closed = true; clearTimeout(record.expiry); record.sink = null;
    this.records.delete(record.id);
    for (const dispose of record.cleanup) dispose();
    if (kill) { try { record.pty.kill(); } catch { /* The OS may have already reaped the PTY. */ } }
  }
  /** Open PTYs plus calls still being admitted; derived from the existing records. */
  inUse(): number {
    let pending = 0;
    for (const requests of this.admissions.values()) pending += requests.size;
    return this.records.size + pending;
  }
  dispose(): void {
    this.sealed = true;
    for (const record of this.records.values()) this.closeRecord(record);
  }
}
