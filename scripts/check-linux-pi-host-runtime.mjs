#!/usr/bin/env node
/** Release gate for the complete remote runtime, including its terminal addon. */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REMOTE_ABI_LIMITS = { GLIBC: [2, 28], GLIBCXX: [3, 4, 25], CXXABI: [1, 3, 11] };
const compare = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
};

/** Only imported (UND) version requirements impose a system ABI minimum. */
export function assertCompatibleSymbols(symbols, label) {
  if (typeof symbols !== "string" || !/Symbol table.*(?:dynsym|symbols)/i.test(symbols)) {
    throw new Error(`${label}: missing ELF dynamic symbol report`);
  }
  const imported = symbols.split(/\r?\n/).filter(line => /\bUND\b/.test(line)).join("\n");
  for (const [namespace, maximum] of Object.entries(REMOTE_ABI_LIMITS)) {
    if (new RegExp(`\\b${namespace}_PRIVATE\\b`).test(imported)) throw new Error(`${label}: private ${namespace} ABI is unsupported`);
    for (const match of imported.matchAll(new RegExp(`\\b${namespace}_(\\d+(?:\\.\\d+)+)\\b`, "g"))) {
      if (compare(match[1].split(".").map(Number), maximum) > 0) {
        throw new Error(`${label}: requires ${namespace}_${match[1]}, above remote ${namespace}_${maximum.join(".")} compatibility limit`);
      }
    }
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024, env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" }, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed (${result.status ?? result.error?.code}): ${String(result.stderr ?? "").slice(-2000)}`);
  }
  return result.stdout;
}

export function verifyRemoteRuntime(bundle) {
  if (process.platform !== "linux") throw new Error("Remote runtime verification requires native Linux");
  const root = realpathSync(bundle), node = join(root, "bin/node"), host = join(root, "bin/pi-desktop-host-core");
  for (const file of [node, host, join(root, "node_modules/node-pty/package.json")]) {
    if (!existsSync(file)) throw new Error(`Required remote runtime file missing: ${file}`);
  }
  // Keep the existing static musl host-core gate; PTY compatibility cannot replace it.
  run(process.execPath, [fileURLToPath(new URL("./check-linux-host-static.mjs", import.meta.url)), host]);
  return { ...verifyTerminalRuntime(node, join(root, "node_modules/node-pty")), staticHost: true };
}

/** Reused by native CI before the complete Host bundle is assembled. */
export function verifyTerminalRuntime(node, ptyDirectory) {
  if (process.platform !== "linux") throw new Error("PTY ABI verification requires native Linux");
  const ptyRoot = realpathSync(ptyDirectory);
  assertCompatibleSymbols(run("readelf", ["-W", "--dyn-syms", node]), "bundled Node");
  const output = run(node, ["-e", `
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const pty=require(process.argv[1]);
const native=Object.keys(require.cache).filter(name=>name.endsWith('.node'));
if(!native.length)throw Error('PTY native module was not loaded');
const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'pi-host-pty-gate-'));
let child,output='',timer;
const clean=()=>{clearTimeout(timer);fs.rmSync(cwd,{recursive:true,force:true});};
try{
 child=pty.spawn('/bin/sh',['-c','printf PI_HOST_PTY_OK; printf "\\n"; pwd'],{name:'xterm-256color',cols:80,rows:24,cwd,env:{PATH:'/usr/bin:/bin',HOME:cwd,TERM:'xterm-256color'}});
 child.onData(data=>{output+=data;if(output.length>65536){child.kill();clean();process.exitCode=1;}});
 child.onExit(event=>{const ok=event.exitCode===0&&output.includes('PI_HOST_PTY_OK')&&output.includes(cwd);clean();if(!ok){console.error('Packaged PTY produced no valid shell output');process.exitCode=1;return;}console.log(JSON.stringify({native,version:process.version,arch:process.arch,pty:true}));});
 timer=setTimeout(()=>{child.kill();clean();console.error('Packaged PTY timed out');process.exitCode=1;},10000);
}catch(error){clean();throw error;}
`, ptyRoot], { cwd: ptyRoot });
  const result = JSON.parse(output.trim());
  if (result.pty !== true || result.arch !== process.arch || !Array.isArray(result.native) || !result.native.length) {
    throw new Error("Packaged runtime did not prove native PTY support");
  }
  for (const native of result.native) {
    const path = realpathSync(native), rel = relative(ptyRoot, path);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("PTY loaded outside the release bundle");
    assertCompatibleSymbols(run("readelf", ["-W", "--dyn-syms", path]), `node-pty/${rel}`);
  }
  return { version: result.version, arch: result.arch, terminal: true, glibcMaximum: "2.28" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw new Error("Usage: check-linux-pi-host-runtime.mjs <bundle-directory> | --pty <package-directory>");
    const result = process.argv[2] === "--pty"
      ? verifyTerminalRuntime(process.execPath, resolve(process.argv[3] ?? ""))
      : verifyRemoteRuntime(resolve(process.argv[2]));
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
