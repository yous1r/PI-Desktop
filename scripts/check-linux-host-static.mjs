#!/usr/bin/env node
/**
 * Fail a Linux host-core binary that is not statically linked.
 *
 * The `pi-host` bundle a desktop installs over SSH ships this build, so the
 * remote machine needs no glibc for host-core at all: the bundled Node runtime
 * is the only part that still carries Node's own requirement (ADR 0338). A
 * dynamic binary here silently reintroduces `GLIBC_2.xx not found` on an older
 * distribution, and the user only sees it as `host-exited` after a full
 * install and pairing attempt.
 *
 * Usage:
 *   node scripts/check-linux-host-static.mjs [path-to-host-core]
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  isStaticElfReport,
  maxNeededGlibc,
  resolvesNoSharedLibrary,
} from "../apps/desktop/electron/main/linux-glibc.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const binary = path.resolve(
  process.argv[2] ||
    path.join(
      root,
      "target/x86_64-unknown-linux-musl/release/pi-desktop-host-core",
    ),
);

/**
 * Report through a workflow annotation as well, so the reason is readable from
 * the checks API without opening the job log.
 */
function fail(message) {
  console.error(message);
  if (process.env.GITHUB_ACTIONS) {
    const oneLine = message.replace(/\r?\n/g, " | ");
    process.stdout.write(`::error::${oneLine}\n`);
  }
  process.exit(1);
}

/**
 * Both binutils commands report some outcomes on stderr and still exit
 * non-zero, and a static binary legitimately has no dynamic symbol table to
 * print. Only a command that cannot run at all is an error.
 */
function inspect(tool, args) {
  const result = spawnSync(tool, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    fail(
      `${tool} could not be run: ${result.error.message} | Install binutils before verifying the bundle's host-core.`,
    );
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

if (!existsSync(binary)) {
  fail(`host-core binary not found: ${binary}`);
}

const fileReport = inspect("file", ["-b", binary]);
if (!isStaticElfReport(fileReport)) {
  fail(
    `${binary} is not statically linked: ${fileReport.trim()} | Build it with --target x86_64-unknown-linux-musl (or the matching aarch64 target).`,
  );
}

const dynamicReport = inspect("readelf", ["-d", binary]);
if (!/dynamic section/i.test(dynamicReport)) {
  fail(
    `${binary} produced no readable dynamic-section report: ${dynamicReport.trim()}`,
  );
}
if (!resolvesNoSharedLibrary(dynamicReport)) {
  const needed = dynamicReport
    .split(/\r?\n/)
    .filter((line) => line.includes("(NEEDED)"))
    .map((line) => line.trim())
    .join(", ");
  fail(`${binary} still resolves shared libraries: ${needed}`);
}

const symbolReport = inspect("readelf", ["-W", "--dyn-syms", binary]);
const neededGlibc = maxNeededGlibc(symbolReport);
if (neededGlibc) {
  fail(
    `${binary} still imports glibc symbols up to GLIBC_${neededGlibc.major}.${neededGlibc.minor}; a static musl build must import none.`,
  );
}

console.log(
  `${binary} is statically linked with no shared-library dependency | ${fileReport.trim()}`,
);
