import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { buildBootstrapScript, parseBootstrapOutput } = await import("../electron/main/remote/pi-host-bootstrap-script.ts");
const { completeHostDeployment } = await import("../electron/main/remote/remote-host-deployment.ts");
const exec = promisify(execFile);
const hostId = "fixture-host";
const fakeHost = `
const fs = require('node:fs'), crypto = require('node:crypto');
const base = process.env.HOME+'/.pi-desktop/pi-host';
const credentialPath=base+'/credentials.json';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
if(process.argv[2]==='maintenance'){
 let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
  const request=JSON.parse(input), busy=fs.existsSync(base+'/busy');
  if(request.expectedHostId!=='fixture-host') {console.log('PI_HOST_MAINTENANCE '+JSON.stringify({ok:false,code:'HOST_AUTH_FAILED'}));process.exitCode=1;return;}
  if(request.op==='acquire'&&busy){console.log('PI_HOST_MAINTENANCE '+JSON.stringify({ok:false,code:'HOST_BUSY'}));process.exitCode=1;return;}
  if(request.op==='acquire')fs.writeFileSync(base+'/lease-observed','yes');
  console.log('PI_HOST_MAINTENANCE '+JSON.stringify({ok:true,protocol:1,hostId:'fixture-host',version:'0.22.2',busy:request.op==='acquire'||busy,...(request.op==='acquire'?{leaseId:request.leaseId,expiresAt:new Date(Date.now()+120000).toISOString()}:{})}));
 });
}else{
 fs.mkdirSync(base,{recursive:true});
 if(!fs.existsSync(base+'/identity.json'))fs.writeFileSync(base+'/identity.json',JSON.stringify({hostId:'fixture-host'}));
 const credentials=fs.existsSync(credentialPath)?read(credentialPath):{devices:[],pairings:[]};
 console.log('PI_HOST_READY '+JSON.stringify({hostId:'fixture-host',host:'127.0.0.1',port:41001,version:'0.22.2'}));
 if(process.argv.includes('--pair')){
  const token=crypto.randomBytes(24).toString('hex'),expiresAt=new Date(Date.now()+600000).toISOString();
  credentials.pairings.push({tokenHash:crypto.createHash('sha256').update(token).digest('hex'),expiresAt});
  fs.writeFileSync(credentialPath,JSON.stringify(credentials));
  console.log('PI_HOST_PAIRING_TOKEN '+JSON.stringify({token,expiresAt}));
 }
 process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);
}
`;

async function filesUnder(path, prefix = "") {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) files.push(...await filesUnder(join(path, entry.name), name + "/"));
    else files.push(name);
  }
  return files.sort();
}

test("client worker installs an old release and recovers expired pairing without trusting its worker", {
  skip: process.platform !== "linux" ? "Linux /proc, flock and executable archive fixture" : false,
  timeout: 120_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-host-client-worker-"));
  const home = join(root, "home"), bundleName = "pi-host-0.22.2-linux-x64", bundle = join(root, bundleName);
  const base = join(home, ".pi-desktop/pi-host"), work = join(base, ".bootstrap");
  const env = { ...process.env, HOME: home, PI_DESKTOP_DATA_DIR: join(home, ".pi-desktop"), NODE_OPTIONS: "", NODE_PATH: "" };
  const json = async path => JSON.parse(await readFile(path, "utf8"));
  try {
    await mkdir(join(bundle, "bin"), { recursive: true });
    await mkdir(home, { recursive: true });
    await copyFile(process.execPath, join(bundle, "bin/node"));
    await chmod(join(bundle, "bin/node"), 0o755);
    for (const name of ["bin/pi-host", "bin/pi-desktop-host-core"]) {
      await writeFile(join(bundle, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    await copyFile(fileURLToPath(new URL("../../pi-host/scripts/install.sh", import.meta.url)), join(bundle, "install.sh"));
    await chmod(join(bundle, "install.sh"), 0o755);
    await writeFile(join(bundle, "pi-host.js"), fakeHost);
    await writeFile(join(bundle, "package.json"), JSON.stringify({ version: "0.22.2", maintenanceProtocol: 1 }));
    // A verified, published worker that cannot be used by this Desktop.
    await writeFile(join(bundle, "deploy.mjs"), 'throw new Error("OLD_RELEASE_WORKER_EXECUTED");\n');
    await writeFile(join(bundle, "deploy-recovery.mjs"), 'throw new Error("OLD_RELEASE_HELPER_EXECUTED");\n');
    const sums = await Promise.all((await filesUnder(bundle)).map(async name =>
      `${createHash("sha256").update(await readFile(join(bundle, name))).digest("hex")}  ${name}\n`));
    await writeFile(join(bundle, "SHA256SUMS"), sums.join(""));
    const upload = join(base, ".upload.ABC123"); await mkdir(upload, { recursive: true });
    const archive = join(upload, "artifact.tar.gz");
    await exec("tar", ["-czf", archive, "-C", root, bundleName], { env, timeout: 30_000 });
    const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
    const script = join(root, "bootstrap.sh");
    await writeFile(script, buildBootstrapScript({ version: "0.22.2", artifactName: bundleName + ".tar.gz",
      bundleDir: bundleName, artifactUrl: "https://release.invalid/official", expectedSha256: digest,
      artifactPath: archive, port: 0, pairingLifetimeMs: 600000, readyTimeoutSec: 15 }));
    const bootstrap = () => exec("sh", [script], { env, timeout: 45_000, maxBuffer: 128 * 1024 });
    const installed = parseBootstrapOutput((await bootstrap()).stdout);
    assert.equal(installed.ready?.hostId, hostId); assert.ok(installed.pairing); assert.ok(installed.transactionId);
    const pidPath = join(work, "pi-host.pid"), firstPid = await readFile(pidPath, "utf8");
    const statePath = join(work, "deployment-state.json"), state = await json(statePath);
    const failureState = { ...state, phase: "recovery-required", failureCode: "HOST_RECOVERY_REQUIRED" };
    await writeFile(statePath, JSON.stringify(failureState));
    const credentialPath = join(base, "credentials.json"), credentials = await json(credentialPath);
    credentials.pairings.forEach(pairing => { pairing.expiresAt = new Date(0).toISOString(); });
    await writeFile(credentialPath, JSON.stringify(credentials));
    await writeFile(join(base, "busy"), "yes");
    await assert.rejects(bootstrap(), error => {
      assert.equal(parseBootstrapOutput(error.stdout).failure, "HOST_BUSY"); return true;
    });
    assert.equal(await readFile(pidPath, "utf8"), firstPid);
    assert.deepEqual(await json(statePath), failureState);
    await rm(join(base, "busy"));
    const recovered = parseBootstrapOutput((await bootstrap()).stdout);
    assert.equal(recovered.transactionId, installed.transactionId); assert.equal(recovered.ready?.hostId, hostId);
    assert.ok(recovered.pairing.expiresAt > Date.now()); assert.notEqual(recovered.pairing.token, installed.pairing.token);
    assert.notEqual(await readFile(pidPath, "utf8"), firstPid);
    assert.equal(await readFile(join(base, "lease-observed"), "utf8"), "yes");
    assert.equal((await json(statePath)).phase, "awaiting-racp", "recovery alone must not claim authenticated completion");
    const afterPid = await readFile(pidPath, "utf8");
    const retry = parseBootstrapOutput((await bootstrap()).stdout);
    assert.equal(retry.pairing.token, recovered.pairing.token);
    await completeHostDeployment({ execWithInput: async (_command, body) => {
      const completion = join(root, "complete.sh"); await writeFile(completion, body);
      const result = await exec("sh", [completion], { env, timeout: 30_000 });
      return { ...result, code: 0 };
    } }, installed.transactionId, hostId);
    assert.equal(existsSync(statePath), false, "Desktop completion also ignores the old published worker");
    assert.equal(await readFile(pidPath, "utf8"), afterPid, "a live token must not restart the Host again");
    assert.equal(createHash("sha256").update(await readFile(archive)).digest("hex"), digest, "published archive bytes are immutable");
  } finally {
    const pidPath = join(work, "pi-host.pid");
    if (existsSync(pidPath)) {
      const pid = Number((await readFile(pidPath, "utf8")).trim());
      try {
        const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
        if (cmdline.includes(base)) process.kill(pid, "SIGTERM");
      } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
    }
    await rm(root, { recursive: true, force: true });
  }
});
