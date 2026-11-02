import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";

async function modules(t) {
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false }, esbuild: { jsx: "automatic" }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  t.after(() => server.close());
  const model = await server.ssrLoadModule("/src/components/extensions/mcp-editor-model.ts");
  const fields = await server.ssrLoadModule("/src/components/extensions/McpHttpSecurityFields.tsx");
  return { ...model, ...fields };
}
const PEM = "-----BEGIN CERTIFICATE-----\nPUBLIC-FIXTURE-ONLY\n-----END CERTIFICATE-----\n";

test("memory center user path: migrate, configure, save, reopen, retain, clear and change transport", async (t) => {
  const m = await modules(t);
  const prior = { id: "superclaude-memory", label: "Team memory", transport: "stdio", command: "node", args: ["C:/old/bridge.mjs"], env: { SC_MEMORY_URL: "https://center.example" }, enabled: true };
  let draft = m.memoryCenterDraft("Memory center", prior);
  assert.equal(draft.id, prior.id);
  assert.equal(draft.label, prior.label);
  assert.equal(draft.url, "https://center.example/mcp");
  draft = { ...draft, bearerToken: "synthetic-reader-token", caCertificate: await m.readMcpCaFile({ size: PEM.length, text: async () => PEM }), memoryProjectBindings: { "remote-project:demo": "pi-desktop" } };
  assert.equal(m.mcpDraftError(draft), null);
  const saved = m.draftToInput(draft, { level: "global" });
  assert.equal(saved.authType, "bearer");
  assert.equal(saved.bearerToken, "synthetic-reader-token");
  for (const key of ["command", "args", "env", "credentialRef"]) assert.equal(saved[key], undefined);
  const { bearerToken, ...record } = saved;
  draft = m.draftFromRecord({ ...record, hasBearerToken: true, credentialRef: "opaque-host-ref" });
  assert.equal(draft.bearerToken, "");
  assert.equal(m.draftToInput(draft).bearerToken, undefined, "reopening never returns the saved token");
  assert.equal(draft.memoryProjectBindings["remote-project:demo"], "pi-desktop");
  draft = { ...draft, clearBearerToken: true, caCertificate: "" };
  assert.equal(m.draftToInput(draft).bearerToken, null);
  assert.equal(m.draftToInput(draft).caCertificate, null);
  draft = m.mcpDraftForTransport({ ...draft, bearerToken }, "stdio");
  const stdio = m.draftToInput(draft);
  for (const key of ["authType", "bearerToken", "caCertificate", "memoryProjectBindings", "url", "headers"]) assert.equal(stdio[key], undefined);
  assert.equal(draft.bearerToken, "");
});

test("choosing managed Bearer is explicit migration of a legacy Authorization header", async (t) => {
  const m = await modules(t);
  let draft = m.draftFromRecord({ id: "legacy", label: "Legacy", transport: "http", url: "https://center.example/mcp", enabled: true,
    headers: { Authorization: "Bearer synthetic-old-token", "X-Team": "keep" } });
  assert.equal(draft.authType, "none");
  assert.equal(m.draftToInput(draft).bearerToken, undefined);
  draft = m.selectMcpAuthentication(draft, "bearer");
  assert.equal(draft.bearerToken, "synthetic-old-token");
  assert.equal(m.draftToInput(draft).headers.Authorization, undefined);
  assert.equal(m.draftToInput(draft).headers["X-Team"], "keep");
  assert.equal(m.mcpDraftError({ ...draft, url: "http://remote.example/mcp" }), "mcpSecurity.errorSecureUrl");
  assert.equal(m.mcpDraftError({ ...draft, url: "https://center.example/mcp?token=wrong" }), "mcpSecurity.errorSecureUrl");
  assert.equal(m.mcpDraftError({ ...draft, bearerToken: "bad token" }), "mcpSecurity.errorToken");
  assert.equal(m.mcpDraftError({ ...draft, memoryProjectBindings: { "remote-project:demo": "/wrong/path" } }), "mcpSecurity.errorBinding");
});

test("CA file selection is bounded and the HTTP form uses a masked, accessible token field", async (t) => {
  const m = await modules(t);
  await assert.rejects(m.readMcpCaFile({ size: 65537, text: async () => { throw new Error("must not read"); } }), /mcpSecurity.errorCa/);
  await assert.rejects(m.readMcpCaFile({ size: 20, text: async () => "-----BEGIN PRIVATE KEY-----" }), /mcpSecurity.errorCa/);
  const i18n = i18next.createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  const draft = { ...m.memoryCenterDraft("Memory center"), hasBearerToken: true, memoryProjectBindings: { "remote-project:demo": "pi-desktop" } };
  const html = renderToStaticMarkup(React.createElement(I18nextProvider, { i18n }, React.createElement(m.McpHttpSecurityFields,
    { draft, setDraft() {}, currentProjectPath: "remote-project:demo", busy: false })));
  assert.match(html, /type="password"/);
  assert.match(html, /Show token/);
  assert.match(html, /Configured — leave blank to keep/);
  assert.match(html, /connection runs on Desktop/);
  assert.match(html, /Import public CA certificate/);
  assert.match(html, /remote-project:demo/);
  assert.doesNotMatch(html, /synthetic-reader-token/);
  const busy = renderToStaticMarkup(React.createElement(I18nextProvider, { i18n }, React.createElement(m.McpHttpSecurityFields,
    { draft, setDraft() {}, busy: true })));
  assert.match(busy, /disabled/);
});
