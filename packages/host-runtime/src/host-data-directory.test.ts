import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { HostProcess } from "./host-process.js";
import { diagnoseHostDataDirectoryFailure } from "./host-data-directory.js";

const spawned = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("node:child_process", () => ({ spawn: () => spawned.current }));

function transport() {
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    pid: 123, exitCode: null, killed: false, stdout, stderr: new PassThrough(),
    stdin: new Writable({ write(chunk, _encoding, callback) {
      const request = JSON.parse(chunk.toString());
      if (request.method === "app.handshake") queueMicrotask(() => stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\n"));
      callback();
    } }),
  });
  spawned.current = child;
  return { child, host: new HostProcess({ binaryPath: "fixture", dataDir: "fixture", onStderr: () => undefined }) };
}

describe("Host data-directory boot refusal", () => {
  it("classifies only the exact native fatal marker without including log content", () => {
    const marker = "Error: HOST_DATA_DIR_IN_USE: another host-core owns this data directory";
    for (const newline of ["\n", "\r\n"]) {
      expect(diagnoseHostDataDirectoryFailure(`earlier log${newline}${marker}${newline}`)).toMatchObject({
        name: "HostDataDirectoryInUseError", errorCode: "HOST_DATA_DIR_IN_USE",
      });
    }
    expect(diagnoseHostDataDirectoryFailure(marker)?.message).not.toContain("earlier log");
    for (const text of ["host-core exited", `quoted ${marker}`, "Error: HOST_DATA_DIR_IN_USE: unrelated text", "HOST_DATA_DIR_IN_USE"]) {
      expect(diagnoseHostDataDirectoryFailure(text)).toBeNull();
    }
  });
});

it("keeps a post-handshake log marker from changing an ordinary process-exit error", async () => {
  const { host, child } = transport();
  await host.handshake();
  const failure = expect(host.call("settings.get")).rejects.toMatchObject({ errorCode: "HOST_UNAVAILABLE" });
  child.stderr.write("Error: HOST_DATA_DIR_IN_USE: another host-core owns this data directory\n");
  child.emit("exit", 1, null);
  await failure;
  await host.dispose();
});

it("reports an ownership boot refusal through the public transport call", async () => {
  const { host, child } = transport();
  const failure = expect(host.call("settings.get")).rejects.toMatchObject({ errorCode: "HOST_DATA_DIR_IN_USE" });
  child.stderr.write("Error: HOST_DATA_DIR_IN_USE: another host-core owns this data directory\n");
  child.emit("exit", 1, null);
  await failure;
  await host.dispose();
});
