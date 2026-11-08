import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceTerminalService, type WorkspacePty } from "./workspace-terminal-service.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
async function fixture() {
  const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "handoff-terminal-service-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let data = (_value: string) => {}, exit = (_value: { exitCode: number }) => {};
  let spawns = 0, kills = 0, closed = false, failSpawn = false;
  let onShells = () => {};
  const pty: WorkspacePty = { pid: 1, write() {}, resize() {}, kill() { kills++; },
    onData(handler) { data = handler;return { dispose() {} }; },
    onExit(handler) { exit = handler;return { dispose() {} }; } };
  const service = new WorkspaceTerminalService({
    shells() { onShells();return [{ id: "fixture", label: "Fixture", family: "custom", path: process.execPath }]; },
    pty: { spawn() { spawns++;if (failSpawn) throw Error("spawn failed");return pty; } },
  });
  cleanups.push(() => service.dispose());
  const owner = { deviceId: "fixture", connectionId: "fixture" };
  const binding = { workspaceId: "fixture", path: root };
  const create = { action: "create" as const, ...binding, tabId: "tab", shellId: "fixture", cols: 80, rows: 24 };
  const guard = () => { if (closed) throw Object.assign(Error("HOST_BUSY"), { code: "HOST_BUSY" }); };
  return { service, owner, binding, create, guard, spawns: () => spawns, kills: () => kills,
    close: () => { closed = true; }, onShells: (callback: () => void) => { onShells = callback; },
    failSpawn: () => { failSpawn = true; }, data: (value: string) => data(value), exit: () => exit({ exitCode: 0 }) };
}

it("checks original caller admission after directory I/O and before native spawn", async () => {
  const f = await fixture();
  f.onShells(f.close);
  await expect(f.service.handle(f.create, f.owner, async () => {}, f.guard)).rejects.toMatchObject({ code: "HOST_BUSY" });
  expect(f.spawns()).toBe(0);
  expect(f.service.getHandoffActivity()).toEqual({ terminals: 0, uncontainedResources: 0 });
});

it("a closed caller cannot even inspect shells or touch the native factory", async () => {
  const f = await fixture();f.close();
  await expect(f.service.handle({ action: "list", ...f.binding }, f.owner, async () => {}, f.guard)).rejects.toMatchObject({ code: "HOST_BUSY" });
  expect(f.spawns()).toBe(0);
});

it("filesystem-only discovery stays idle, while failed PTY creation remains unqualified", async () => {
  const f = await fixture();
  await f.service.handle({ action: "list", ...f.binding }, f.owner, async () => {}, f.guard);
  expect(f.service.getHandoffActivity()).toEqual({ terminals: 0, uncontainedResources: 0 });
  f.failSpawn();
  await expect(f.service.handle(f.create, f.owner, async () => {}, f.guard)).rejects.toMatchObject({ code: "TERMINAL_SHELL_UNAVAILABLE" });
  f.service.dispose();
  expect(f.service.getHandoffActivity()).toEqual({ terminals: 0, uncontainedResources: 1 });
});

it("disposal retains output already accepted by the original sink until settlement", async () => {
  const f = await fixture(), entered = deferred(), delivery = deferred();
  cleanups.push(delivery.resolve);
  await f.service.handle(f.create, f.owner, async () => { entered.resolve();await delivery.promise; }, f.guard);
  f.data("pending output");await entered.promise;
  f.service.dispose();
  expect(f.kills()).toBe(1);expect(f.service.getHandoffActivity().terminals).toBeGreaterThan(0);
  let drained = false;
  const pending = f.service.drainOutput().then(() => { drained = true; });
  await Promise.resolve();expect(drained).toBe(false);
  delivery.resolve();await pending;
  expect(f.service.getHandoffActivity()).toEqual({ terminals: 0, uncontainedResources: 1 });
});

it("an ordinary root exit releases live records without certifying its native family", async () => {
  const f = await fixture(), events: unknown[] = [];
  await f.service.handle(f.create, f.owner, async event => { events.push(event); }, f.guard);
  f.data("last");f.exit();await f.service.drainOutput();
  expect(events).toHaveLength(2);expect(events[1]).toMatchObject({ exitCode: 0 });
  expect(f.kills()).toBe(0);
  expect(f.service.getHandoffActivity()).toEqual({ terminals: 0, uncontainedResources: 1 });
});
