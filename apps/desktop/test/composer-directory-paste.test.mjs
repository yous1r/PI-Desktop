import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function extract(source, name) {
  const tree = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, true);
  let result;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) result = node.getText(tree).replace(/^export\s+/, "");
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name) result = node.initializer?.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(result, name);
  return result;
}

function harness(native, { files = [], text = "", items = [], paused, sourceSessionId = "source" } = {}) {
  const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
  const editor = read("../src/features/chat/composer/editor.ts");
  const hook = read("../src/features/chat/composer/hooks/useComposerAttachments.ts");
  const drafts = [], errors = [], writes = [], imported = [], transfers = [], created = [];
  const nativeReads = [], textInsertions = [];
  let revision = 0;
  let activeSessionId = sourceSessionId;
  let workspacePath = "/synthetic/project";
  const element = { textContent: "before after" };
  const context = {
    inputBlocked: false, attachmentsAllowed: true, activeSessionId,
    draftKey: sourceSessionId ?? "home", largePasteThreshold: 1000,
    ref: { current: element }, valueRef: { current: element.textContent },
    previousWorkspacePathRef: { current: "/synthetic/project" },
    snapshotReferences: () => [], invalidateComposerTransforms() {},
    applyEditorDraft: (text, references) => drafts.push({ text, references }),
    showToast(message, options) { if (options?.variant === "error") errors.push(message); },
    t: key => key,
  };
  let sequence = 0;
  const environment = {
    module: { exports: {} }, Array, TextEncoder, crypto,
    context: () => context, ...context, draft: context, isInputBlocked: false,
    setPasting() {}, readEditorValue: editor => editor.textContent,
    editorSelectionRange: () => ({ start: 7, end: 7 }),
    pasteSessionLinks: () => false, parseSessionLinks: () => [],
    showErrorToast: error => errors.push(error.message),
    api: {
      getDroppedFilePath: () => null,
      readClipboardDirectories: async () => { nativeReads.push(true); if (paused) await paused; return native; },
      recordClipboardPaste: async () => {},
      importFiles: async (session, token) => {
        imported.push({ session, token });
        return { files: [{ path: "/synthetic/scratch/notes.txt", name: "notes.txt", kind: "file" }] };
      },
      pasteFiles: async (_session, payload) => {
        transfers.push(payload);
        return { files: payload.map(file => ({ path: "/synthetic/scratch/" + file.name, name: file.name, kind: "file", mimeType: file.mimeType })) };
      },
    },
    nextChipToken: () => String.fromCodePoint(0xe001 + sequence++),
    createFileReference: (path, name, sessionId, metadata) => ({ path, name, sessionId, ...metadata }),
    draftFileReference: reference => reference,
    writeComposerDraft: (key, snapshot) => writes.push({ key, snapshot }),
    readComposerDraftRevision: () => revision,
    readComposerDraft: () => undefined,
    document: { execCommand: (_command, _showUi, text) => { textInsertions.push(text); return true; } },
    insertClipboardText: (_editor, text) => { textInsertions.push(text); return true; },
    deleteComposerDraft() {}, HOME_DRAFT_KEY: "home",
    useAppStore: { getState: () => ({ activeSessionId, workspace: { path: workspacePath }, sessions: [{ id: "source" }, { id: "created" }] }) },
    materializeDraftSession: async () => { created.push(workspacePath); activeSessionId = "created"; return "created"; },
  };
  const code = extract(editor, "clipboardFiles") + "\n" + extract(editor, "preferClipboardText") + "\nmodule.exports = " + extract(hook, "pasteClipboardFiles");
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, environment);
  return {
    drafts, errors, writes, imported, transfers, created, nativeReads, textInsertions,
    edit(text) { element.textContent = text; revision++; },
    switchSession() { activeSessionId = "other"; },
    switchProject() { workspacePath = "/synthetic/other-project"; },
    paste: () => environment.module.exports({ currentTarget: element, preventDefault() {}, clipboardData: { files, items, types: ["Files"], getData: () => text } }),
  };
}

test("screenshot-only paste transfers image bytes without waiting for native directory discovery", async () => {
  const image = new File(["screenshot bytes"], "image.png", { type: "image/png" });
  const run = harness(null, { files: [image] });
  await run.paste();
  assert.deepEqual(run.errors, []);
  assert.deepEqual(run.nativeReads, []);
  assert.equal(run.transfers.length, 1);
  assert.equal(new TextDecoder().decode(run.transfers[0][0].data), "screenshot bytes");
});
