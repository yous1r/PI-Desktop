import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MIRROR_STATE_TONE,
  initBlocksSync,
  mirrorActionAvailability,
  stepCatalogKey,
} from "../src/components/mirror/mirror-panel-model.ts";

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), "utf8");

const [panel, model, conflicts, styles, slice, en] = await Promise.all([
  read("../src/components/mirror/MirrorStatusPanel.tsx"),
  read("../src/components/mirror/mirror-panel-model.ts"),
  read("../src/components/mirror/MirrorConflictList.tsx"),
  read("../src/styles/mirror-panel.css"),
  read("../src/stores/slices/mirror-slice.ts"),
  read("../../../packages/i18n/src/locales/en/index.ts"),
]);

/** Every sync state the wire type allows. */
const STATES = ["idle", "watching", "syncing", "paused", "failed"];

function init(state, step = null) {
  return { projectGroupId: "group-a", state, completedSteps: [], step, error: null };
}

// ── Pure decisions ───────────────────────────────────────────────────────────

test("panel: every sync state has a badge tone and a distinct label key", () => {
  for (const state of STATES) {
    assert.ok(MIRROR_STATE_TONE[state], `missing tone for ${state}`);
    assert.match(en, new RegExp(`^\\s+${state}:`, "m"), `missing mirror.state.${state}`);
  }
  // Only a failure is an error tone: a paused mirror is not broken.
  assert.equal(MIRROR_STATE_TONE.failed, "error");
  assert.equal(MIRROR_STATE_TONE.paused, "warning");
  assert.equal(MIRROR_STATE_TONE.idle, "neutral");
});

test("panel: a step id maps onto its catalog key", () => {
  assert.equal(stepCatalogKey("ssh"), "ssh");
  assert.equal(stepCatalogKey("helper-deploy"), "helperDeploy");
  assert.equal(stepCatalogKey("forward-self-test"), "forwardSelfTest");
  assert.equal(stepCatalogKey("local-environment"), "localEnvironment");
  // The catalog must actually carry the mapped key, or the panel renders the
  // raw dotted path instead of a label.
  for (const step of [
    "ssh",
    "helper-dir",
    "helper-deploy",
    "helper-start",
    "env-verify",
    "adapter-install",
    "adapter-probe",
    "forward-self-test",
    "local-environment",
    "manifest",
  ]) {
    assert.match(
      en,
      new RegExp(`^\\s+${stepCatalogKey(step)}:`, "m"),
      `missing mirror.step.${stepCatalogKey(step)}`,
    );
  }
});

test("panel: synchronization is blocked until initialization finishes or fails", () => {
  // No init snapshot at all is not a block: a project that never initialized
  // still has to reach the host so it can be initialized.
  assert.equal(initBlocksSync(null), false);
  assert.equal(initBlocksSync(init("needs-init")), true);
  assert.equal(initBlocksSync(init("initializing", "helper-start")), true);
  assert.equal(initBlocksSync(init("ready")), false);
  // A visible failure hands the decision back to the user instead of hiding the
  // panel behind a state it cannot leave on its own.
  assert.equal(initBlocksSync(init("init-failed", "helper-deploy")), false);
});

test("panel: the primary action pair never offers a pointless call", () => {
  const ready = init("ready");
  assert.deepEqual(mirrorActionAvailability("idle", { busy: false, init: ready }), {
    canStart: true,
    canStop: false,
  });
  for (const state of ["watching", "syncing"]) {
    assert.deepEqual(
      mirrorActionAvailability(state, { busy: false, init: ready }),
      { canStart: false, canStop: true },
      state,
    );
  }
  // A paused mirror is neither running nor startable while it is paused: the
  // host reports a runtime, so start would be a duplicate.
  assert.deepEqual(mirrorActionAvailability("paused", { busy: false, init: ready }), {
    canStart: true,
    canStop: false,
  });
  for (const state of STATES) {
    assert.deepEqual(
      mirrorActionAvailability(state, { busy: true, init: ready }),
      { canStart: false, canStop: false },
      `busy ${state}`,
    );
    assert.deepEqual(
      mirrorActionAvailability(state, { busy: false, init: init("initializing", "ssh") }),
      { canStart: false, canStop: false },
      `blocked ${state}`,
    );
  }
});

// ── The component renders those decisions ────────────────────────────────────

test("panel: the rendered actions follow the model, not their own rules", () => {
  assert.match(panel, /from "\.\/mirror-panel-model"/);
  assert.match(panel, /mirrorActionAvailability\(state, \{ busy: loading, init \}\)/);
  assert.match(panel, /disabled=\{!canStart\}/);
  assert.match(panel, /disabled=\{!canStop\}/);
  // The component must not restate a rule the model already owns.
  assert.doesNotMatch(panel, /state === "watching" \|\| state === "syncing"/);
  assert.doesNotMatch(panel, /init\.state !== "ready"/);
  assert.match(model, /init-failed/);
});

test("panel: a failure is shown with its code and a retry that repeats it", () => {
  assert.match(panel, /data-mirror-error=\{error\.code\}/);
  assert.match(panel, /role="alert"/);
  assert.match(panel, /mirror\.status\.errorDetail/);
  assert.match(panel, /onClick=\{onRetry\}/);
  // Retry is only offered when something actually failed.
  assert.match(panel, /\{error && \(/);
});

test("panel: progress during initialization names the running step", () => {
  assert.match(panel, /mirror\.step\.\$\{stepCatalogKey\(init\.step\)\}/);
  assert.match(panel, /mirror\.status\.initializing/);
  assert.match(panel, /mirror\.status\.notReady/);
});

test("panel: the conflict list gets the full runtime and cannot act while blocked", () => {
  assert.match(panel, /<MirrorConflictList/);
  assert.match(panel, /conflicts=\{conflicts\}/);
  assert.match(panel, /resolving=\{runtime\.resolving\}/);
  assert.match(panel, /disabled=\{blocked\}/);
  assert.match(panel, /onResolve=\{onResolve\}/);
});

test("panel: keeping the remote copy needs an explicit second decision", () => {
  // The destructive action is armed first and only the armed row can confirm.
  assert.match(conflicts, /onRequestConfirm/);
  assert.match(conflicts, /armed \?/);
  assert.match(conflicts, /data-mirror-confirm=\{conflict\.relPath\}/);
  assert.match(conflicts, /confirmKeepRemote/);
  // Keeping the remote copy is the only resolution reached through the gate.
  assert.match(conflicts, /onResolve\(conflict\.relPath, "keep_remote"\)/);
  assert.doesNotMatch(conflicts, /onResolve\(conflict\.relPath, "keep_remote"\)[^}]*onRequestConfirm/);
  // A row that left the list cannot stay armed, or a stale arm would confirm a
  // file the user no longer sees.
  assert.match(conflicts, /conflicts\.some\(\(row\) => row\.relPath === confirming\)/);
});

test("panel: no user-visible string is hard-coded in the components", () => {
  for (const source of [panel, conflicts]) {
    const literals = [...source.matchAll(/>\s*([A-Z][A-Za-z ]{3,})\s*</g)].map((m) => m[1]);
    assert.deepEqual(literals, [], `hard-coded copy: ${literals.join(" | ")}`);
  }
  assert.match(panel, /useTranslation\(\)/);
  assert.match(conflicts, /useTranslation\(\)/);
});

test("panel: every class the components use exists in the stylesheet", async () => {
  const used = new Set(
    [...(panel + conflicts).matchAll(/className=(?:"([^"]+)"|\{cx\(([^)]*)\)\})/g)].flatMap(
      (match) =>
        (match[1] ?? match[2] ?? "")
          .split(/[\s",]+/)
          .map((name) => name.trim())
          .filter((name) => name.startsWith("mirror-")),
    ),
  );
  assert.ok(used.size > 10, `expected mirror-* classes, found ${used.size}`);
  for (const name of used) {
    assert.match(styles, new RegExp(`\\.${name}[\\s,{:]`), `missing .${name} in mirror-panel.css`);
  }
});

test("panel: the stylesheet keeps every value on a token", () => {
  const props = /^\s*(font-size|font-weight|line-height|letter-spacing|border-radius)\s*:\s*([^;]+);/gm;
  for (const match of styles.matchAll(props)) {
    assert.match(match[2], /var\(--/, `${match[1]}: ${match[2].trim()} is not a token`);
  }
  // Surface colours come from the design system, never from a literal.
  assert.doesNotMatch(styles, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(styles, /\b(?:rgb|hsl)a?\(/);
});

// ── Store contract the panel reads ───────────────────────────────────────────

test("panel: the slice owns state and never decides a mirror outcome", () => {
  // A pushed snapshot replaces the whole status; merging would keep stale
  // counters the host already superseded.
  assert.match(slice, /applyMirrorStatus/);
  assert.match(slice, /\(\) => \(\{ status \}\)/);
  // A conflict leaves the list only after the host accepted the decision.
  assert.match(slice, /resolveMirrorConflict/);
  // The renderer never holds a connection to the host's helper: every call goes
  // through the host RPC the IPC layer owns.
  assert.doesNotMatch(slice, /createConnection|from "node:net"|from "net"|WebSocket|require\("net"\)/);
});
