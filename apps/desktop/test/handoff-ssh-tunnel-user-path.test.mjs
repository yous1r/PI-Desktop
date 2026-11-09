import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
register(new URL("./helpers/current-source-import-hooks.mjs", import.meta.url));
const { createRemoteHostsBoot } = await import("../electron/main/bootstrap/remote-hosts.ts");
const { createBackendRouter } = await import("../electron/main/remote/backend-router.ts");
const { createSshTunnelManager } = await import("../electron/main/remote/ssh-tunnel.ts");
const { createSystemSshTransport } = await import("../electron/main/remote/ssh-transport.ts");
const run = promisify(execFile);
const ready = 'PI_HOST_READY {"hostId":"fixture-host","host":"127.0.0.1","port":4321,"version":"0.22.3"}';

async function executable(root) {
  const binary = join(root, process.platform === "win32" ? "ssh-fixture.exe" : "ssh-fixture");
  if (process.platform === "win32") {
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Add-Type -Path $env:PI_SSH_FIXTURE_SOURCE -OutputAssembly $env:PI_SSH_FIXTURE_OUTPUT -OutputType ConsoleApplication"], {
      timeout: 30000,
      env: { ...process.env, PI_SSH_FIXTURE_SOURCE: fileURLToPath(new URL("./helpers/ssh-tunnel-fixture.cs", import.meta.url)), PI_SSH_FIXTURE_OUTPUT: binary },
    });
  } else {
    await writeFile(binary, `#!${process.execPath}\nconst fs=require('node:fs'),net=require('node:net');
const args=process.argv.slice(2),at=args.indexOf('-L');
if(at<0){let script='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>script+=chunk);process.stdin.on('end',()=>{fs.writeFileSync(process.argv[1]+'.exec.txt',process.pid+'\\n'+script);console.log(${JSON.stringify(ready)});});}
else{const server=net.createServer(socket=>socket.end());fs.writeFileSync(process.argv[1]+'.forward.txt',process.pid+'\\n'+args.join('\\n'));server.listen(Number(args[at+1].split(':')[1]),'127.0.0.1');}\n`);
    await chmod(binary, 0o755);
  }
  return binary;
}
function adapter() {
  let state = "disconnected";
  return {
    state: () => state,
    connect: async () => { state = "connected"; }, close: async () => { state = "disconnected"; },
    workspaceCapabilities: () => ({ workspaceTools: true, workspaceFiles: true }),
    client: {
      request: async method => method === "session/list" ? { sessions: [] } : { subscriptionId: "fixture", starting: { epoch: "fixture", sequence: 1 }, replayComplete: true },
      subscribe: () => () => {},
    },
  };
}
function processAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } }

test("paired Host lifecycle owns real local SSH fixture processes through tunnel teardown", { timeout: 45000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "handoff-ssh-user-path-"));
  let boot;
  t.after(async () => { await boot?.closeAll(); await rm(root, { recursive: true, force: true }); });
  const binary = await executable(root), errors = [];
  await mkdir(join(root, "profile"));
  let held = false, constructions = 0;
  const tunnels = createSshTunnelManager({ isAdmissionClosed: () => held,
    buildTransport: () => { constructions++; return createSystemSshTransport({ host: "fixture.invalid" }, { binary }); },
    log: (level, message) => { if (level === "warn") errors.push(message); },
  });
  boot = createRemoteHostsBoot({ dataDir: join(root, "profile"), isAdmissionClosed: () => held,
    encryption: { isAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
    router: createBackendRouter(), emit: () => {}, clientInfo: { name: "fixture", version: "0.22.3" },
    tunnels, buildAdapter: adapter,
  });
  const host = await boot.addHost({ hostKey: "fixture", label: "Fixture", url: "ws://127.0.0.1:4321/v1/racp/ws", deviceToken: "invented-fixture-token",
    metadata: { transport: "ssh", ssh: { host: "fixture.invalid", hostId: "fixture-host", version: "0.22.3", remotePort: 4321 } },
  });
  assert.equal(host.connected, true);
  const [execPidText, ...script] = (await readFile(`${binary}.exec.txt`, "utf8")).split("\n");
  const [forwardPidText, ...argv] = (await readFile(`${binary}.forward.txt`, "utf8")).split("\n");
  const execPid = Number(execPidText), forwardPid = Number(forwardPidText);
  assert.ok(Number.isSafeInteger(execPid) && execPid > 0);
  assert.ok(Number.isSafeInteger(forwardPid) && forwardPid > 0);
  assert.match(script.join("\n"), /PI_HOST_SUPERVISOR_FAILED/);
  assert.equal(processAlive(execPid), false); assert.equal(processAlive(forwardPid), true);
  assert.ok(argv.includes("fixture.invalid") && argv.includes("-L") && argv.includes("-N"));
  assert.equal(constructions, 1);
  held = true;
  await assert.rejects(tunnels.open("fixture", { host: "fixture.invalid", version: "0.22.3", remotePort: 4321 }), { code: "HOST_BUSY" });
  assert.equal(processAlive(forwardPid), true);
  await boot.closeAll();
  assert.equal(processAlive(forwardPid), false);
  assert.equal(constructions, 1); assert.deepEqual(errors, []);
  assert.deepEqual(tunnels.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 1 });
  await assert.rejects(tunnels.open("fixture", { host: "fixture.invalid", version: "0.22.3", remotePort: 4321 }));
  console.log(JSON.stringify({ kind: "ssh-tunnel-user-path", originalExecExited: true, originalForwardExited: true,
    realSshHostContacted: false, nativeFamilyQualified: false, activity: tunnels.getHandoffActivity() }));
});
