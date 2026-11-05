import { spawnSync } from "node:child_process";
import { delimiter, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeRuntimePath } from "./runtime-path.js";

describe("bundled Node PATH", () => {
  it("finds the selected runtime without any system Node on PATH", () => {
    const result = spawnSync("node", ["-p", "process.versions.node"], {
      encoding: "utf8", env: { ...process.env, PATH: nodeRuntimePath(process.execPath, "") },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(process.versions.node);
  });
  it("keeps the remaining tool paths, without duplicating Node's directory", () => {
    const directory = dirname(process.execPath);
    expect(nodeRuntimePath(process.execPath, ["first", directory, "last"].join(delimiter)))
      .toBe([directory, "first", "last"].join(delimiter));
  });
  it("does not turn a bare or relative --node command into an implicit cwd lookup", () => {
    expect(nodeRuntimePath("node", "original")).toBe("original");
    expect(nodeRuntimePath("./bin/node", "original")).toBe("original");
  });
});
