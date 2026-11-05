import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

/*
 * Host-managed remote connections (`pi-desktop/plugins/connections/*`).
 *
 * The component never decides a payload by itself: the draft module below is
 * the single place that turns form state into the IPC input, so the rules that
 * matter for a credential — "absent keeps it, empty deletes it", "a new
 * endpoint needs the token again" — are pinned here rather than in a render.
 */
const {
  buildConnectionSaveInput,
  connectionDraft,
  connectionRouteSummary,
  draftRoute,
  emptyConnectionDraft,
  endpointChanged,
  normalizeBaseUrl,
  normalizeMethods,
  parseBaseUrl,
  resolvedRouteUrl,
  routePathIssue,
  tokenRequired,
  upsertConnection,
  validateConnectionDraft,
} = await import("../src/features/settings/plugin-connections-form.ts");

const PLUGIN = "local.ai-memory";

const saved = (overrides = {}) => ({
  id: "conn-1",
  pluginId: PLUGIN,
  label: "Work memory",
  baseUrl: "https://memory.example.com",
  revision: 3,
  hasCredential: true,
  caConfigured: false,
  allowHttp: false,
  routes: [{ path: "/mcp", methods: ["POST"] }],
  ...overrides,
});

const kinds = (issues) => issues.map((issue) => issue.kind);

test("an empty draft reports every missing decision once", () => {
  assert.deepEqual(kinds(validateConnectionDraft(emptyConnectionDraft())), [
    "label",
    "baseUrl",
    "routePath",
  ]);
});

test("unencrypted HTTP needs consent unless the host never leaves the machine", () => {
  const base = { ...emptyConnectionDraft(), label: "Lan", routes: [draftRoute("/mcp", ["POST"])] };

  assert.deepEqual(
    kinds(validateConnectionDraft({ ...base, baseUrl: "http://memory.example.com" })),
    ["httpConsent"],
  );
  assert.deepEqual(
    kinds(
      validateConnectionDraft({
        ...base,
        baseUrl: "http://memory.example.com",
        allowHttp: true,
      }),
    ),
    [],
  );
  for (const loopback of ["http://127.0.0.1:8080", "http://localhost:9000"]) {
    assert.deepEqual(
      kinds(validateConnectionDraft({ ...base, baseUrl: loopback })),
      [],
      loopback,
    );
  }
});

test("a credential is bound to its endpoint and never silently re-sent", () => {
  const unchanged = connectionDraft(saved());
  assert.equal(unchanged.token, "", "the token is never read back into the form");
  assert.equal(endpointChanged(unchanged), false);
  assert.equal(tokenRequired(unchanged), false);
  assert.deepEqual(validateConnectionDraft(unchanged), []);

  const payload = buildConnectionSaveInput(PLUGIN, unchanged);
  assert.equal("token" in payload, false, "an untouched token is absent, not empty");
  assert.equal("caPem" in payload, false);
  assert.equal(payload.id, "conn-1");
  assert.equal(payload.expectedRevision, 3, "edits compare against the revision displayed to the user");

  const moved = { ...unchanged, baseUrl: "https://memory.example.eu" };
  assert.equal(endpointChanged(moved), true);
  assert.equal(tokenRequired(moved), true);
  assert.deepEqual(kinds(validateConnectionDraft(moved)), ["tokenRequired"]);
  assert.deepEqual(
    kinds(validateConnectionDraft({ ...moved, token: "re-entered" })),
    [],
  );

  // Trailing slash and default port are not an endpoint change.
  assert.equal(endpointChanged({ ...unchanged, baseUrl: "https://memory.example.com/" }), false);
  assert.equal(endpointChanged({ ...unchanged, baseUrl: "https://memory.example.com:443" }), false);
});

test("every saved endpoint change requires credential re-entry before submission", () => {
  for (const draft of [connectionDraft(saved({ hasCredential: false })), { ...connectionDraft(saved()), clearToken: true }]) {
    const moved = { ...draft, baseUrl: "https://new.example.com" };
    assert.equal(tokenRequired(moved), true);
    assert.deepEqual(kinds(validateConnectionDraft(moved)), ["tokenRequired"]);
    assert.deepEqual(validateConnectionDraft({ ...moved, token: "new-synthetic-token" }), []);
  }
});

test("an explicit clear and a typed replacement are different instructions", () => {
  const draft = connectionDraft(saved());
  assert.deepEqual(
    buildConnectionSaveInput(PLUGIN, { ...draft, token: "typed", caPem: "PEM" }),
    {
      pluginId: PLUGIN,
      id: "conn-1",
      expectedRevision: 3,
      label: "Work memory",
      baseUrl: "https://memory.example.com",
      allowHttp: false,
      routes: [{ path: "/mcp", methods: ["POST"] }],
      token: "typed",
      caPem: "PEM",
    },
  );

  const cleared = buildConnectionSaveInput(PLUGIN, {
    ...draft,
    clearToken: true,
    clearCa: true,
    caPem: "",
  });
  assert.equal(cleared.token, "");
  assert.equal(cleared.caPem, "");
  // Clearing the credential is a choice about the saved secret, so a moved
  // endpoint no longer forces a token it will not have.
  assert.equal(tokenRequired({ ...draft, clearToken: true }), false);
});

test("a new connection never carries an id and starts without a credential", () => {
  const draft = {
    ...emptyConnectionDraft(),
    label: "Home",
    baseUrl: "https://home.example.com",
    routes: [draftRoute("/hook", ["POST"])],
  };
  assert.equal(tokenRequired(draft), false);
  const payload = buildConnectionSaveInput(PLUGIN, draft);
  assert.equal("id" in payload, false);
  assert.equal("token" in payload, false);
  assert.deepEqual(payload.routes, [{ path: "/hook", methods: ["POST"] }]);
});

test("routes stay exact relative paths with GET/POST only", () => {
  const base = {
    ...emptyConnectionDraft(),
    label: "Memory",
    baseUrl: "https://memory.example.com",
  };

  for (const bad of ["mcp", "//mcp", "/mcp?x=1", "/a/../b", "/%2e%2e/x", "/m cp", "/a//b"]) {
    assert.deepEqual(
      kinds(validateConnectionDraft({ ...base, routes: [draftRoute(bad, ["POST"])] })),
      ["routePath"],
      bad,
    );
    assert.equal(routePathIssue(bad), true, bad);
  }

  assert.deepEqual(
    kinds(validateConnectionDraft({ ...base, routes: [draftRoute("/mcp", [])] })),
    ["routeMethods"],
  );
  assert.deepEqual(
    kinds(
      validateConnectionDraft({
        ...base,
        routes: [draftRoute("/mcp", ["POST"]), draftRoute("/mcp", ["GET"])],
      }),
    ),
    ["routeDuplicate"],
  );
  assert.deepEqual(
    kinds(validateConnectionDraft({ ...base, routes: [] })),
    ["routes"],
  );

  // Declared order is the host contract: ai-memory's defaults are two POSTs.
  const payload = buildConnectionSaveInput(PLUGIN, {
    ...base,
    routes: [
      draftRoute("  /mcp ", ["POST", "GET"]),
      draftRoute("/hook", ["POST"]),
    ],
  });
  assert.deepEqual(payload.routes, [
    { path: "/mcp", methods: ["GET", "POST"] },
    { path: "/hook", methods: ["POST"] },
  ]);
  assert.deepEqual(normalizeMethods(["POST", "GET", "POST"]), ["GET", "POST"]);
});

test("the base URL mirrors the host's accepted shape", () => {
  for (const good of [
    "https://memory.example.com",
    "https://h/memory/",
    "http://127.0.0.1:8080",
    // Surrounding whitespace from a paste is trimmed before it is sent.
    " https://memory.example.com ",
  ]) {
    assert.ok(parseBaseUrl(good), good);
  }
  for (const bad of [
    "memory.example.com",
    "ftp://memory.example.com",
    "https://user:pw@memory.example.com",
    "https://memory.example.com/?q=1",
    "https://memory.example.com/#frag",
    "https://memory.example.com/a/../b",
    "https://memory.example.com/%2e%2e",
    "https://memory.example.com/a b",
  ]) {
    assert.equal(parseBaseUrl(bad), null, bad);
  }
  assert.equal(normalizeBaseUrl("https://memory.example.com///"), "https://memory.example.com");
});
test("row summaries show the exact routes and resolved addresses", () => {
  const connection = saved({
    routes: [
      { path: "/mcp", methods: ["POST"] },
      { path: "/hook", methods: ["POST", "GET"] },
    ],
  });
  assert.deepEqual(connectionRouteSummary(connection), ["POST /mcp", "GET /hook", "POST /hook"]);
  assert.equal(
    resolvedRouteUrl("https://memory.example.com/base", "/mcp"),
    "https://memory.example.com/base/mcp",
  );
  assert.equal(resolvedRouteUrl("https://memory.example.com", "mcp"), null);
  assert.equal(resolvedRouteUrl("not a url", "/mcp"), null);
});

test("a saved connection replaces its previous row instead of duplicating it", () => {
  const first = saved();
  const second = saved({ id: "conn-2", label: "Second" });
  const list = upsertConnection([first], second);
  assert.deepEqual(list.map((entry) => entry.id), ["conn-1", "conn-2"]);

  const updated = upsertConnection(list, { ...first, label: "Renamed", revision: 4 });
  assert.deepEqual(updated.map((entry) => entry.label), ["Renamed", "Second"]);
  assert.equal(updated[0].revision, 4);
});
