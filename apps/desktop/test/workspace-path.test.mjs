import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { sameWorkspacePath } = await import("../electron/main/workspace-path.ts");

test("Windows workspace snapshots match persisted separator and drive-prefix spelling", () => {
  for (const [snapshot, stored] of [
    [String.raw`D:\Packages\PI-Desktop`, "D:/Packages/PI-Desktop"],
    [String.raw`\\?\D:\Packages\PI-Desktop`, "D:/Packages/PI-Desktop"],
    ["D:\\Packages\\PI-Desktop\\", "D:/Packages/PI-Desktop"],
    [String.raw`\\server\share\repo`, "//server/share/repo"],
    ["D:\\", "D:/"],
  ]) assert.equal(sameWorkspacePath(snapshot, stored, "win32"), true, snapshot);
});

test("workspace comparison preserves different roots, case and non-Windows path spelling", () => {
  for (const [left, right, platform] of [
    [String.raw`D:\repo-other`, "D:/repo", "win32"],
    ["D:/repo/link/../other", "D:/repo/other", "win32"],
    [String.raw`E:\repo`, "D:/repo", "win32"],
    ["D:/Repo", "D:/repo", "win32"],
    ["remote-project:a", "remote-project:b", "win32"],
    [String.raw`/srv/repo\child`, "/srv/repo/child", "linux"],
    ["/srv/Repo", "/srv/repo", "linux"],
    ["/srv/repo/", "/srv/repo", "darwin"],
  ]) assert.equal(sameWorkspacePath(left, right, platform), false, left);
});
