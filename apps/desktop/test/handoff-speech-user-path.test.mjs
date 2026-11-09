import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/owner-runtime-import-hooks.mjs", import.meta.url));
const { createSpeechService } = await import("../electron/main/services/speech-service.ts");
const { registerSpeechIpc } = await import("../electron/main/ipc/speech-ipc.ts");
const { DesktopHandoffAdmission } = await import("../electron/main/runtime/handoff-admission.ts");
const { IPC } = await import("@pi-desktop/shared");

test("Speech IPC transcribes and synthesizes through real HTTP then retains cancelled original streaming work", { timeout: 10000 }, async t => {
  const root = await mkdtemp(join(resolve(process.env.PI_SCRATCH_DIR || tmpdir()), "speech-user-"));
  const scratch = join(root, "scratch", "session"), input = join(scratch, "input.wav");
  await mkdir(scratch, { recursive: true }); await writeFile(input, "RIFF input");
  const admission = new DesktopHandoffAdmission(), handlers = new Map(), requests = [], logs = [];
  const entered = Promise.withResolvers(), closed = Promise.withResolvers(), serverErrors = [];
  let slow = false, originalResponse, speech;
  const server = createServer(async (request, response) => {
    try {
      let body = ""; for await (const chunk of request) body += chunk;
      requests.push(request.url); assert.equal(request.headers.authorization, "Bearer fixture-key");
      if (request.url === "/v1/audio/transcriptions") {
        assert.match(request.headers["content-type"], /^multipart\/form-data;/);
        assert.match(body, /RIFF input/); assert.match(body, /fixture-model/);
        response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ text: "fixture transcript" }));
      } else {
        assert.equal(request.url, "/v1/audio/speech"); assert.equal(JSON.parse(body).input, "fixture text");
        response.writeHead(200, { "content-type": "audio/wav" });
        if (slow) { originalResponse = response; response.once("close", closed.resolve); response.write("RIFF "); entered.resolve(); }
        else response.end("RIFF output");
      }
    } catch (error) { serverErrors.push(error); response.destroy(); entered.reject(error); }
  });
  t.after(async () => {
    speech?.dispose(); admission.dispose(); originalResponse?.destroy(); server.closeAllConnections();
    await new Promise(done => server.close(done)); await rm(root, { recursive: true, force: true });
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const binding = { providerId: "fixture", modelId: "fixture-model", protocol: "openai_audio" };
  const host = { generation: randomUUID(), isAvailable: () => true, async call(method) {
    if (method === "settings.get") return { speech: { transcribe: binding, synthesize: binding } };
    if (method === "providers.get") return { provider: { id: "fixture", baseUrl } };
    if (method === "providers.getSecret") return { value: "fixture-key" };
    if (method === "session.getScratchPath") return { path: scratch };
    throw new Error(`Unexpected method ${method}`);
  } };
  speech = createSpeechService({ dataDir: root, getHost: () => host, isAdmissionClosed: () => admission.isClosed(),
    plugins: { listSpeechAdapters: () => [], captureSpeechAdapter: () => undefined }, logger: { app: (...args) => logs.push(args) } });
  registerSpeechIpc({ speech, registrar: { handle: (channel, callback) => handlers.set(channel, payload => admission.invoke(channel, () => callback(payload))) } });
  const inspect = async () => { const activity = speech.getHandoffActivity(); return {
    clients: 0, turns: 0, queuedTurns: 0, plans: 0, tools: activity.operations, processes: 0, terminals: 0, plugins: 0,
    admissions: admission.inFlightCount(), finalizations: 0, writes: 0, children: 0, workers: 0, schedules: 0,
    approvals: 0, inputs: 0, nativeSessions: 0, mcp: 0, uncontainedResources: activity.uncontainedResources,
  }; };
  const hold = await admission.gate.acquireHandoff(randomUUID(), inspect);
  await assert.rejects(handlers.get(IPC.invoke.speechSynthesize)({ sessionId: "session", text: "fixture text" }), { errorCode: "HOST_BUSY" });
  assert.equal(requests.length, 0); hold.cancel();
  const status = await handlers.get(IPC.invoke.speechGetStatus)(); assert.equal(status.transcribe.available, true);
  assert.deepEqual(await handlers.get(IPC.invoke.speechTranscribe)({ sessionId: "session", path: input, language: "en" }), { text: "fixture transcript" });
  const output = await handlers.get(IPC.invoke.speechSynthesize)({ sessionId: "session", text: "fixture text", format: "wav" });
  assert.equal(await readFile(output.path, "utf8"), "RIFF output"); assert.equal(output.mimeType, "audio/wav");
  assert.equal(output.dataUrl, `data:audio/wav;base64,${Buffer.from("RIFF output").toString("base64")}`);
  const before = await readdir(scratch); slow = true;
  const work = handlers.get(IPC.invoke.speechSynthesize)({ sessionId: "session", text: "fixture text" });
  const rejected = assert.rejects(work, error => (error.errorCode ?? error.code) === "HOST_BUSY");
  await entered.promise; assert.ok(speech.getHandoffActivity().operations > 0); assert.equal(admission.inFlightCount(), 1);
  speech.dispose(); await Promise.all([rejected, closed.promise]);
  assert.deepEqual(await readdir(scratch), before); assert.equal(logs.filter(log => log[1] === "info").length, 2);
  const activity = speech.getHandoffActivity(); assert.deepEqual(activity, { operations: 0, resources: 0, uncontainedResources: 3 });
  assert.equal(admission.inFlightCount(), 0); assert.deepEqual(serverErrors, []);
  await assert.rejects(admission.gate.acquireHandoff(randomUUID(), inspect), { code: "HOST_BUSY" });
  t.diagnostic(JSON.stringify({ kind: "speech-user-path", successfulTranscriptions: 1, successfulSyntheses: 1,
    originalStreamingResponseClosed: true, cancelledOutputCreated: false, activity, nativeFamilyQualified: false }));
});
