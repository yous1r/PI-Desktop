#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function assertGlibcFloor(symbols, floor = [2, 28]) {
  const versions = [...symbols.matchAll(/\bGLIBC_(\d+)\.(\d+)(?:\.(\d+))?\b/g)]
    .map(match => [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
  const highest = versions[0];
  if (!highest) throw new Error("No glibc requirement found in PTY native module");
  if (highest[0] > floor[0] || (highest[0] === floor[0] && highest[1] > floor[1])) {
    throw new Error(`PTY needs glibc ${highest.join(".")}, above ${floor.join(".")}`);
  }
  return highest.join(".");
}

export async function verifyPty(directory) {
  const symbols = execFileSync("readelf", ["--version-info", join(directory, "build/Release/pty.node")], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
  });
  const needed = assertGlibcFloor(symbols);
  const pty = createRequire(import.meta.url)(directory);
  await new Promise((done, reject) => {
    const term = pty.spawn("/bin/sh", [], { name: "xterm-256color", cols: 80, rows: 24, cwd: directory, env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color" } });
    let output = "";
    let exiting = false;
    const timer = setTimeout(() => { term.kill(); reject(new Error("PTY command/output deadline exceeded")); }, 10_000);
    term.onData(data => {
      output += data;
      if (!exiting && /(?:^|[\r\n])734019[\r\n]/.test(output)) {
        exiting = true;
        term.write("exit 0\r");
      }
    });
    term.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode !== 0 || !exiting) reject(new Error(`PTY exited ${exitCode} without the expected command result`));
      else done();
    });
    term.resize(100, 30);
    term.write("printf '%s\\n' $((734000+19))\r");
  });
  console.log(`PTY loaded and executed shell input/output/resize/exit; glibc ${needed} <= 2.28`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || process.platform !== "linux") throw new Error("Usage on Linux: node verify-pty.mjs <node-pty directory>");
  await verifyPty(resolve(process.argv[2]));
}
