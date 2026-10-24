import assert from "node:assert/strict";
import test from "node:test";

const { scanShellProfiles, ShellRegistry } = await import(
  "../electron/main/terminal/shell-registry.ts"
);

/**
 * Detection is filesystem-only, so every probe is a pure function of a fake
 * environment. These tests pin the order and the fallbacks without touching
 * the real machine's shells.
 */

function scan(platform, env, existing) {
  const files = new Set(existing);
  return scanShellProfiles({
    platform,
    env,
    fileExists: (path) => files.has(path),
  });
}

const WINDOWS_FILES = [
  "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  "C:\\Windows\\System32\\cmd.exe",
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Windows\\System32\\wsl.exe",
];

const WINDOWS_ENV = {
  SystemRoot: "C:\\Windows",
  ComSpec: "C:\\Windows\\System32\\cmd.exe",
  ProgramFiles: "C:\\Program Files",
  PATH: "",
};

test("windows: pwsh leads, then Windows PowerShell, cmd, Git Bash, WSL", () => {
  const profiles = scan("win32", WINDOWS_ENV, WINDOWS_FILES);

  assert.deepEqual(
    profiles.map((profile) => profile.id),
    ["pwsh", "windows-powershell", "cmd", "git-bash", "wsl"],
  );
  assert.equal(profiles[0].isDefault, true);
  // Only the first hit claims the default, so the terminal always opens pwsh.
  assert.equal(profiles.slice(1).some((profile) => profile.isDefault), false);
});

test("windows: Windows PowerShell becomes the default when pwsh is absent", () => {
  const profiles = scan("win32", WINDOWS_ENV, [
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "C:\\Windows\\System32\\cmd.exe",
  ]);

  assert.deepEqual(
    profiles.map((profile) => profile.id),
    ["windows-powershell", "cmd"],
  );
  assert.equal(profiles[0].isDefault, true);
});

test("windows: Git Bash resolves from the install root beside git.exe on PATH", () => {
  const profiles = scan(
    "win32",
    { SystemRoot: "C:\\Windows", PATH: "C:\\tools\\Git\\cmd" },
    ["C:\\tools\\Git\\cmd\\git.exe", "C:\\tools\\Git\\bin\\bash.exe"],
  );

  const gitBash = profiles.find((profile) => profile.id === "git-bash");
  assert.ok(gitBash, "git bash must be discovered");
  assert.equal(gitBash.path, "C:\\tools\\Git\\bin\\bash.exe");
});

test("windows: an empty machine still offers cmd so the error surfaces at create time", () => {
  const profiles = scan("win32", { SystemRoot: "C:\\Windows" }, []);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].id, "cmd");
  assert.equal(profiles[0].isDefault, true);
});

test("posix: $SHELL wins, then the common login shells", () => {
  const profiles = scan(
    "linux",
    { SHELL: "/usr/bin/zsh", PATH: "/usr/bin:/bin" },
    ["/usr/bin/zsh", "/bin/bash", "/usr/bin/fish"],
  );

  assert.deepEqual(
    profiles.map((profile) => profile.id),
    ["zsh", "bash", "fish"],
  );
  assert.equal(profiles[0].isDefault, true);
  assert.equal(new Set(profiles.map((profile) => profile.id)).size, profiles.length);
});

test("posix: a login shell outside the standard roots is not offered twice", () => {
  const profiles = scan(
    "linux",
    { SHELL: "/opt/custom/zsh", PATH: "/usr/bin" },
    ["/opt/custom/zsh", "/usr/bin/zsh"],
  );

  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].path, "/opt/custom/zsh");
});

test("profile ids are unique on every platform, so find(id) is unambiguous", () => {
  const cases = [
    ["win32", WINDOWS_ENV, WINDOWS_FILES],
    ["win32", { SystemRoot: "C:\\Windows" }, []],
    ["linux", { SHELL: "/bin/sh", PATH: "/usr/bin" }, ["/bin/sh", "/bin/bash"]],
    ["linux", { SHELL: "/usr/bin/zsh", PATH: "/usr/bin" }, ["/usr/bin/zsh", "/usr/bin/zsh"]],
    ["darwin", {}, []],
  ];
  for (const [platform, env, files] of cases) {
    const ids = scan(platform, env, files).map((profile) => profile.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate profile id on ${platform}: ${ids}`);
  }
});
test("windows: an empty machine still offers cmd so the error surfaces at create time", () => {
  const profiles = scan("win32", { SystemRoot: "C:\\Windows" }, []);
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].id, "cmd");
  assert.equal(profiles[0].isDefault, true);
});

test("registry caches a scan and only rescans when asked", () => {
  let probes = 0;
  const registry = new ShellRegistry({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    fileExists: () => {
      probes += 1;
      return false;
    },
  });

  const first = registry.listShells();
  const probesAfterFirst = probes;
  const second = registry.listShells();
  assert.equal(probes, probesAfterFirst, "the cached call must not probe again");
  assert.deepEqual(second, first, "the cached list is reused");

  registry.listShells(true);
  assert.ok(probes > probesAfterFirst, "a refresh rescans the filesystem");
});

test("registry.find resolves a profile by id and returns undefined otherwise", () => {
  const registry = new ShellRegistry({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    fileExists: (path) => path === "C:\\Windows\\System32\\cmd.exe",
  });

  assert.equal(registry.find("cmd")?.family, "cmd");
  assert.equal(registry.find("nope"), undefined);
});
