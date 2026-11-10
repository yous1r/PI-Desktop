/**
 * H1-R03 vendor-account OAuth ownership: shared admission, per-operation
 * original-Host attribution, plugin runtime attribution, and handoff counters
 * that survive cancellation, refusal and disposal.
 *
 * The vendor side is replaced by fixtures: pi-ai's login flows never run (the
 * collection is injected), no browser is launched, no vendor endpoint is
 * contacted and no account or token leaves this process.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { VendorOAuth, secretRefForProviderOauth } = await import(
  "../electron/main/oauth.ts"
);

const deferred = () => Promise.withResolvers();
/** One macrotask boundary; no wall-clock waiting anywhere in this file. */
const turn = () => new Promise((resolve) => setImmediate(resolve));
const refused = (error) =>
  ["HOST_BUSY", "HOST_UNAVAILABLE"].includes(error?.code ?? error?.errorCode);

async function until(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await turn();
  }
  throw new Error(`condition never settled: ${label}`);
}

const VENDOR = "anthropic";
const ROW_ID = `row-${VENDOR}`;
/** Mirrors `INSTALLATION_ID_REF` in installation-identity.ts. */
const INSTALLATION_REF = "secret:installation:oauth-device-id";
const PLUGIN_PROVIDER = {
  pluginId: "demo.plugin",
  runtimeId: "runtime-1",
  contributionId: "gateway",
  providerId: "plugin:demo.plugin:gateway",
  name: "Fixture Gateway",
  loginLabel: "Sign in to Fixture Gateway",
  isSubscription: false,
};

/**
 * A host-core stand-in: the provider table, the encrypted secret store, and the
 * identity of the Host generation each call was made against. `call` (the
 * legacy live dereference) and `captureOwner` (the H1 capture) are separate, so
 * a late effect cannot borrow a replacement by using the wrong one.
 */
function fakeHost() {
  const providers = new Map();
  const secrets = new Map();
  const calls = [];
  let nextRow = 0;
  /**
   * A test-controlled gate in front of every Host call. The caller's captured
   * owner is recorded once the call is really performed, so work that starts
   * after a replacement is visible as work against the replacement.
   */
  const host = { providers, secrets, calls, hook: undefined };
  host.call = async (owner, method, params = {}) => {
    await host.hook?.(method, params);
    calls.push({ owner, method, params });
    switch (method) {
      case "providers.list":
        return {
          providers: [...providers.values()].map((row) => ({
            ...row,
            hasOauth: secrets.has(secretRefForProviderOauth(row.id)),
          })),
        };
      case "providers.create": {
        const id = params.type === "native" ? ROW_ID : `row-${++nextRow}`;
        providers.set(id, { id, ...params, enabled: true });
        return { provider: providers.get(id) };
      }
      case "providers.update": {
        const row = providers.get(params.id);
        if (!row) return { provider: null };
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined) row[key] = value;
        }
        return { provider: row };
      }
      case "providers.delete":
        providers.delete(params.id);
        secrets.delete(secretRefForProviderOauth(params.id));
        return { ok: true };
      case "secrets.set":
        secrets.set(params.secretRef, params.value);
        return { ok: true };
      case "secrets.getForRuntime":
        return { value: secrets.get(params.secretRef) ?? null };
      case "secrets.delete":
        secrets.delete(params.secretRef);
        return { ok: true };
      default:
        throw new Error(`unexpected host call: ${method}`);
    }
  };
  return host;
}

/**
 * The pi-ai collection stand-in. `login` is the test's flow: it uses the prompt
 * and notify interaction exactly as a real vendor flow does, and persists
 * through the injected credential store.
 */
function fakeModels(credentials, { login, models: configured, refreshModels, publish } = {}) {
  const list = configured ?? [
    {
      id: "claude-opus-5",
      name: "Claude Opus 5",
      api: "anthropic-messages",
      provider: VENDOR,
      baseUrl: "https://api.anthropic.com",
      contextWindow: 200_000,
      maxTokens: 16_384,
    },
  ];
  let provider = {
    id: VENDOR,
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    auth: {
      oauth: {
        name: "Anthropic (Claude Pro/Max)",
        isSubscription: true,
        loginLabel: "Sign in with Claude Pro/Max",
      },
    },
    getModels: () => list,
    ...(refreshModels ? { refreshModels } : {}),
  };
  return {
    setProvider: (next) => { provider = next; },
    getProviders: () => [provider],
    getProvider: (id) => (id === provider.id ? provider : undefined),
    refresh: async (options = {}) => {
      await provider.refreshModels?.({
        allowNetwork: options.allowNetwork !== false,
        signal: options.signal ?? new AbortController().signal,
        force: options.force,
        // A test may hold publication open: the refresh is not finished while
        // the account's catalog has not accepted the merged snapshot yet.
        publish: async ({ update }) => {
          await publish?.();
          update?.();
          return true;
        },
      });
      return { aborted: false, errors: new Map() };
    },
    getAvailable: async () => provider.getModels(),
    getModel: (id, modelId) =>
      id === provider.id ? provider.getModels().find((model) => model.id === modelId) : undefined,
    login:
      login ??
      (async (_id, _type, interaction) => {
        interaction.notify({
          type: "auth_url",
          url: "https://claude.ai/oauth/authorize",
          instructions: "Approve the request, then paste the code.",
        });
        const code = await interaction.prompt({
          type: "manual_code",
          message: "Paste the authorization code",
        });
        const credential = {
          type: "oauth",
          refresh: `refresh-for-${code}`,
          access: `access-for-${code}`,
          expires: 4102444800000,
        };
        await credentials.modify(provider.id, async () => credential);
        return credential;
      }),
    logout: async (id) => credentials.delete(id),
    getAuth: async (id) => {
      const credential = await credentials.read(id);
      if (!credential) return undefined;
      return { auth: { apiKey: credential.access }, source: "OAuth" };
    },
  };
}

function fixture(t, overrides = {}) {
  const host = fakeHost();
  const events = [];
  const opens = [];
  const errors = [];
  const logs = [];
  const created = [];
  /** The pi-ai collection built for each created credential store. */
  const collections = [];
  const state = { closed: false, owner: { generation: "one" } };
  const hostCall = (owner, method, params) => host.call(owner, method, params);
  const oauth = new VendorOAuth({
    call: (method, params) => hostCall(state.owner, method, params),
    isAdmissionClosed: () => state.closed,
    captureOwner() {
      const owner = state.owner;
      const generation = owner.generation;
      return {
        assertCurrent() {
          if (state.owner !== owner || owner.generation !== generation) {
            throw Object.assign(new Error("Host changed"), { code: "HOST_UNAVAILABLE" });
          }
        },
        call: (method, params) => hostCall(owner, method, params),
      };
    },
    emit: (event) => events.push(event),
    openExternal: async (url) => {
      opens.push(url);
      await overrides.open?.();
    },
    createModels: (store) => {
      created.push(store);
      const models = fakeModels(store, overrides);
      collections.push(models);
      return models;
    },
    getPluginOAuthBridge: overrides.getPluginOAuthBridge,
    fetch:
      overrides.fetch ??
      (async () => {
        throw new Error("live model list disabled in test");
      }),
    log: (level, message, data) => {
      logs.push({ level, message, data });
      if (level === "error") errors.push({ message, data });
      overrides.log?.(level, message, data);
    },
    newId: (() => {
      let counter = 0;
      return () => `id-${++counter}`;
    })(),
  });
  t.after(() => oauth.dispose());
  return { host, oauth, events, opens, errors, logs, created, collections, state };
}

/** The signed-in account row the fake host writes on a completed login. */
function signedInRow(id = ROW_ID) {
  return {
    id,
    name: "Anthropic (Claude Pro/Max)",
    vendorKey: VENDOR,
    authKind: "oauth",
    baseUrl: "https://api.anthropic.com",
    apiStyle: "anthropic_messages",
    defaultModelId: "claude-opus-5",
    oauthAccountLabel: "Anthropic (Claude Pro/Max)",
    enabled: true,
    models: [
      {
        id: "claude-opus-5",
        contextWindow: 200_000,
        maxTokens: 16_384,
        thinkingLevels: ["off"],
        defaultThinkingLevel: "off",
      },
    ],
  };
}

function storedCredential(label = "abc") {
  return JSON.stringify({
    type: "oauth",
    refresh: `refresh-for-${label}`,
    access: `access-for-${label}`,
    expires: 4102444800000,
  });
}

/**
 * Sign in to the fixture vendor and answer its one prompt. The login runs the
 * real detached path: prompt, credential write, row update and `done` event.
 */
async function signIn(f, code = "abc") {
  const { loginId } = await f.oauth.start(VENDOR);
  await until(() => f.events.some((event) => event.kind === "prompt"), "prompt");
  const prompt = f.events.find((event) => event.kind === "prompt");
  assert.equal(
    f.oauth.respond({ loginId, promptId: prompt.request.promptId, value: code }),
    true,
  );
  await until(() => f.events.some((event) => event.kind === "done"), "done");
}
test("handoff activity is reported synchronously and starts empty", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.oauth.getHandoffActivity(), {
    operations: 0,
    resources: 0,
    uncontainedResources: 0,
  });
});

for (const [name, invoke] of [
  ["login start", (f) => f.oauth.start(VENDOR)],
  ["vendor list", (f) => f.oauth.listVendors()],
  ["account test", (f) => f.oauth.resolveAuth(ROW_ID)],
  ["model list", (f) => f.oauth.listModels(ROW_ID)],
  ["binding", (f) => f.oauth.bindingFor(ROW_ID, "claude-opus-5")],
  ["sign-out", (f) => f.oauth.deleteAccount(ROW_ID)],
]) test(`vendor OAuth refuses ${name} before any side effect while admission is closed`, async (t) => {
  const f = fixture(t);
  f.host.providers.set(ROW_ID, signedInRow());
  f.host.secrets.set(secretRefForProviderOauth(ROW_ID), storedCredential());
  f.state.closed = true;
  await assert.rejects(invoke(f), refused);
  assert.deepEqual(f.host.calls, []);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.opens, []);
  assert.deepEqual(f.oauth.getHandoffActivity(), {
    operations: 0,
    resources: 0,
    uncontainedResources: 0,
  });
});

test("a completed login leaves an attributable row and no outstanding work", async (t) => {
  const f = fixture(t);
  const { loginId } = await f.oauth.start(VENDOR);
  await until(() => f.events.some((event) => event.kind === "prompt"), "prompt");
  const prompt = f.events.find((event) => event.kind === "prompt");
  assert.equal(f.oauth.respond({ loginId, promptId: prompt.request.promptId, value: "abc" }), true);
  await until(() => f.events.some((event) => event.kind === "done"), "done");

  assert.deepEqual(f.opens, ["https://claude.ai/oauth/authorize"]);
  assert.deepEqual(
    f.host.secrets.get(secretRefForProviderOauth(ROW_ID)),
    storedCredential("abc"),
  );
  assert.equal(f.host.providers.get(ROW_ID).oauthAccountLabel, "Anthropic (Claude Pro/Max)");
  assert.deepEqual(await f.oauth.resolveAuth(ROW_ID), { apiKey: "access-for-abc" });
  assert.equal((await f.oauth.listVendors())[0].accounts[0].connected, true);
  assert.deepEqual(await f.oauth.listModels(ROW_ID), [
    {
      modelId: "claude-opus-5",
      apiStyle: "anthropic_messages",
      baseUrl: "https://api.anthropic.com",
    },
  ]);

  // Every Host call was made against the generation this run was admitted for.
  assert.ok(f.host.calls.every((entry) => entry.owner === f.state.owner));
  await until(() => f.oauth.getHandoffActivity().operations === 0, "operations settle");
  const activity = f.oauth.getHandoffActivity();
  assert.equal(activity.resources, 0);
  assert.ok(activity.uncontainedResources > 0, "the pi-ai flow stays uncontained");
});

test("cancelling a login keeps the underlying flow counted until it settles", async (t) => {
  const flow = deferred();
  let entered = false;
  const f = fixture(t, {
    login: async (_id, _type, interaction) => {
      interaction.notify({ type: "auth_url", url: "https://claude.ai/oauth/authorize" });
      entered = true;
      await flow.promise;
      return { type: "oauth", access: "late", refresh: "late", expires: 4102444800000 };
    },
  });
  const { loginId } = await f.oauth.start(VENDOR);
  await until(() => entered, "login flow entered");
  assert.ok(f.oauth.getHandoffActivity().operations > 0);
  assert.ok(f.oauth.getHandoffActivity().resources > 0);

  assert.equal(f.oauth.cancel(loginId), true);
  // Cancellation ends the caller's wait, not the original flow.
  assert.ok(f.oauth.getHandoffActivity().operations > 0);
  assert.ok(f.oauth.getHandoffActivity().resources > 0);
  await turn();
  assert.equal(
    f.events.filter((event) => event.kind === "done").length,
    0,
    "a cancelled attempt cannot complete",
  );

  flow.resolve();
  await until(() => f.events.some((event) => event.kind === "cancelled"), "cancelled");
  await until(() => f.oauth.getHandoffActivity().operations === 0, "flow settled");
  assert.equal(f.oauth.getHandoffActivity().resources, 0);
  assert.ok(f.oauth.getHandoffActivity().uncontainedResources > 0);
  assert.equal(f.host.secrets.has(secretRefForProviderOauth(ROW_ID)), false);
});

test("disposal seals new work without erasing an admitted login", async (t) => {
  const flow = deferred();
  let entered = false;
  const f = fixture(t, {
    login: async () => {
      entered = true;
      await flow.promise;
      return { type: "oauth", access: "late", refresh: "late", expires: 4102444800000 };
    },
  });
  await f.oauth.start(VENDOR);
  await until(() => entered, "login flow entered");

  f.oauth.dispose();
  assert.ok(f.oauth.getHandoffActivity().operations > 0, "the flow is still owned");
  await assert.rejects(f.oauth.start(VENDOR), refused);
  assert.equal(f.host.calls.filter((entry) => entry.method === "providers.create").length, 1);

  flow.resolve();
  await until(() => f.oauth.getHandoffActivity().operations === 0, "flow settled");
  assert.equal(f.oauth.getHandoffActivity().resources, 0);
});

test("a replaced Host refuses the late credential write instead of adopting it", async (t) => {
  const approval = deferred();
  let code;
  const f = fixture(t, {
    login: async (_id, _type, interaction) => {
      interaction.notify({ type: "auth_url", url: "https://claude.ai/oauth/authorize" });
      code = await interaction.prompt({ type: "manual_code", message: "Paste the code" });
      await approval.promise;
      const credential = { type: "oauth", access: `access-${code}`, refresh: "r", expires: 1 };
      await f.created[1].modify(VENDOR, async () => credential);
      return credential;
    },
  });
  const { loginId } = await f.oauth.start(VENDOR);
  await until(() => f.events.some((event) => event.kind === "prompt"), "prompt");
  const prompt = f.events.find((event) => event.kind === "prompt");
  f.oauth.respond({ loginId, promptId: prompt.request.promptId, value: "abc" });

  const original = f.state.owner;
  f.state.owner = { generation: "two" };
  approval.resolve();
  await until(() => f.events.some((event) => event.kind === "error"), "login refused");

  assert.equal(f.host.secrets.has(secretRefForProviderOauth(ROW_ID)), false);
  assert.equal(f.events.filter((event) => event.kind === "done").length, 0);
  // Nothing was written through, or to, the replacement Host.
  assert.ok(f.host.calls.every((entry) => entry.owner === original));
  assert.deepEqual(f.state.owner, { generation: "two" });
  await until(() => f.oauth.getHandoffActivity().operations === 0, "login settled");
});

test("a late browser launch after cancellation is not published as a URL", async (t) => {
  const launch = deferred();
  const f = fixture(t, {
    open: () => launch.promise,
    login: async (_id, _type, interaction) => {
      interaction.notify({ type: "auth_url", url: "https://claude.ai/oauth/authorize" });
      await interaction.prompt({ type: "manual_code", message: "Paste the code" });
      throw new Error("login cancelled");
    },
  });
  const { loginId } = await f.oauth.start(VENDOR);
  await until(() => f.opens.length === 1, "browser launch started");
  assert.ok(f.oauth.getHandoffActivity().operations > 0, "the launch is counted");
  f.oauth.cancel(loginId);
  launch.resolve();
  await until(() => f.events.some((event) => event.kind === "cancelled"), "cancelled");
  await turn();
  assert.equal(f.events.filter((event) => event.kind === "authUrl").length, 0);
  assert.equal(f.opens.length, 1, "the original launch still completed");
});

test("the vendor model list is counted to settlement and disposal cannot erase it", async (t) => {
  const body = deferred();
  let fetched = false;
  const f = fixture(t, {
    fetch: async () => {
      fetched = true;
      return body.promise;
    },
  });
  f.host.providers.set(ROW_ID, signedInRow());
  f.host.secrets.set(secretRefForProviderOauth(ROW_ID), storedCredential());
  const pending = f.oauth.listModels(ROW_ID);
  await until(() => fetched, "vendor list request");
  assert.ok(f.oauth.getHandoffActivity().operations > 0);
  const uncontained = f.oauth.getHandoffActivity().uncontainedResources;
  assert.ok(uncontained > 0, "the vendor transport stays uncontained");

  f.oauth.dispose();
  assert.ok(f.oauth.getHandoffActivity().operations > 0);
  body.resolve(
    Response.json({
      data: [{ id: "claude-opus-5" }],
    }),
  );
  const models = await pending;
  assert.deepEqual(models, [
    {
      modelId: "claude-opus-5",
      apiStyle: "anthropic_messages",
      baseUrl: "https://api.anthropic.com",
    },
  ]);
  assert.equal(f.oauth.getHandoffActivity().operations, 0);
  assert.equal(
    f.oauth.getHandoffActivity().uncontainedResources,
    uncontained,
    "the transport handoff it already reported is not invented twice",
  );
});

test("plugin sign-in stores the credential for the runtime it was admitted for", async (t) => {
  const provider = { ...PLUGIN_PROVIDER };
  const approval = deferred();
  const bridge = {
    listOAuthProviders: () => [provider],
    invokeProviderOAuth: async () => {
      await approval.promise;
      return { accessToken: "plugin-access", accountLabel: "user@example.test" };
    },
  };
  const f = fixture(t, { getPluginOAuthBridge: () => bridge });
  f.host.providers.set(provider.providerId, {
    id: provider.providerId,
    name: provider.name,
    vendorKey: "custom",
    ownerPluginId: provider.pluginId,
    authKind: "oauth",
    baseUrl: "https://api.example.test/v1",
    enabled: true,
  });

  await f.oauth.start(provider.providerId);
  await until(() => f.oauth.getHandoffActivity().resources > 0, "plugin session held");
  approval.resolve();
  await until(() => f.events.some((event) => event.kind === "done"), "plugin done");

  const stored = JSON.parse(f.host.secrets.get(secretRefForProviderOauth(provider.providerId)));
  assert.equal(stored.accessToken, "plugin-access");
  assert.equal(stored.accountLabel, "user@example.test");
  assert.ok(f.host.calls.every((entry) => entry.owner === f.state.owner));
});

test("a plugin runtime reload retires the attempt before it can persist or publish", async (t) => {
  const provider = { ...PLUGIN_PROVIDER };
  const approval = deferred();
  const bridge = {
    listOAuthProviders: () => [provider],
    invokeProviderOAuth: async () => {
      await approval.promise;
      return { accessToken: "stale-access" };
    },
  };
  const f = fixture(t, { getPluginOAuthBridge: () => bridge });
  f.host.providers.set(provider.providerId, {
    id: provider.providerId,
    name: provider.name,
    vendorKey: "custom",
    ownerPluginId: provider.pluginId,
    authKind: "oauth",
    baseUrl: "https://api.example.test/v1",
    enabled: true,
  });

  await f.oauth.start(provider.providerId);
  await until(() => f.oauth.getHandoffActivity().resources > 0, "plugin session held");
  // The plugin reloads while its callback is still running.
  provider.runtimeId = "runtime-2";
  approval.resolve();
  await until(() => f.events.some((event) => event.kind === "error"), "attempt retired");

  assert.equal(f.host.secrets.has(secretRefForProviderOauth(provider.providerId)), false);
  assert.equal(f.events.filter((event) => event.kind === "done").length, 0);
});

test("a plugin refresh keeps its original Host and refuses a late replacement", async (t) => {
  const provider = { ...PLUGIN_PROVIDER };
  const refreshed = deferred();
  let refreshSignal;
  const bridge = {
    listOAuthProviders: () => [provider],
    invokeProviderOAuth: async (_pluginId, _contributionId, request, signal) => {
      assert.equal(request.operation, "refresh");
      refreshSignal = signal;
      await refreshed.promise;
      return { accessToken: "stale-access", expiresAt: Date.now() + 3_600_000 };
    },
  };
  const f = fixture(t, { getPluginOAuthBridge: () => bridge });
  const secretRef = secretRefForProviderOauth(provider.providerId);
  f.host.providers.set(provider.providerId, {
    id: provider.providerId,
    name: provider.name,
    vendorKey: "custom",
    ownerPluginId: provider.pluginId,
    authKind: "oauth",
    baseUrl: "https://api.example.test/v1",
    enabled: true,
  });
  f.host.secrets.set(secretRef, JSON.stringify({
    accessToken: "expired-access",
    refreshToken: "refresh-token",
    expiresAt: Date.now() - 1,
  }));

  const original = f.state.owner;
  const auth = f.oauth.resolveAuth(provider.providerId);
  await until(() => refreshSignal !== undefined, "plugin refresh started");
  assert.ok(f.oauth.getHandoffActivity().operations > 0);
  assert.ok(f.oauth.getHandoffActivity().resources > 0, "the refresh controller is held");

  f.state.owner = { generation: "two" };
  refreshed.resolve();
  await assert.rejects(auth, refused);
  assert.equal(
    JSON.parse(f.host.secrets.get(secretRef)).accessToken,
    "expired-access",
    "a replacement Host never adopts the refreshed credential",
  );
  assert.ok(f.host.calls.every((entry) => entry.owner === original));
  await until(() => f.oauth.getHandoffActivity().operations === 0, "refresh settled");
  assert.equal(f.oauth.getHandoffActivity().resources, 0);
});

test("signing out aborts an in-flight plugin refresh and still clears its secret", async (t) => {
  const provider = { ...PLUGIN_PROVIDER };
  const started = deferred();
  let signal;
  const bridge = {
    listOAuthProviders: () => [provider],
    invokeProviderOAuth: (_pluginId, _contributionId, request, controllerSignal) => {
      assert.equal(request.operation, "refresh");
      signal = controllerSignal;
      started.resolve();
      return new Promise((_resolve, reject) => {
        controllerSignal.addEventListener("abort", () => reject(controllerSignal.reason), {
          once: true,
        });
      });
    },
  };
  const f = fixture(t, { getPluginOAuthBridge: () => bridge });
  const secretRef = secretRefForProviderOauth(provider.providerId);
  f.host.providers.set(provider.providerId, {
    id: provider.providerId,
    name: provider.name,
    vendorKey: "custom",
    ownerPluginId: provider.pluginId,
    authKind: "oauth",
    baseUrl: "https://api.example.test/v1",
    enabled: true,
  });
  f.host.secrets.set(secretRef, JSON.stringify({
    accessToken: "expired-access",
    refreshToken: "refresh-token",
    expiresAt: Date.now() - 1,
  }));

  const auth = f.oauth.resolveAuth(provider.providerId);
  await started.promise;
  await f.oauth.deleteAccount(provider.providerId);
  await assert.rejects(auth, /provider sign-out requested/);
  assert.equal(signal.aborted, true);
  assert.equal(f.host.secrets.has(secretRef), false);
  assert.equal(f.host.providers.has(provider.providerId), true, "sign-out keeps the plugin row");
});

test("a plugin callback cannot prompt through the runtime that replaced it", async (t) => {
  const provider = { ...PLUGIN_PROVIDER };
  const approved = deferred();
  const bridge = {
    listOAuthProviders: () => [provider],
    // The callback asks for a Host prompt only after the runtime has reloaded.
    invokeProviderOAuth: async (pluginId, _contributionId, request) => {
      await approved.promise;
      return f.oauth.promptPluginOAuth(pluginId, request.loginId, {
        type: "secret",
        message: "Enter the device code",
      });
    },
  };
  const f = fixture(t, { getPluginOAuthBridge: () => bridge });
  f.host.providers.set(provider.providerId, {
    id: provider.providerId,
    name: provider.name,
    vendorKey: "custom",
    ownerPluginId: provider.pluginId,
    authKind: "oauth",
    baseUrl: "https://api.example.test/v1",
    enabled: true,
  });
  await f.oauth.start(provider.providerId);
  await until(() => f.oauth.getHandoffActivity().resources > 0, "plugin session held");
  provider.runtimeId = "runtime-2";
  approved.resolve();
  await until(() => f.events.some((event) => event.kind === "error"), "attempt retired");
  assert.equal(f.events.filter((event) => event.kind === "prompt").length, 0);
});

/*
 * Late effects of one admitted operation: the installation identity, the
 * credential store behind an account collection, renderer events, the vendor
 * list and every refresh. Each case replaces the Host or the plugin runtime
 * while that work is really in flight, so a check that only runs before an
 * await is visible as a leak.
 */
test("the installation identity is read and written through the login's original Host", async (t) => {
  const reading = deferred();
  const release = deferred();
  const f = fixture(t, {
    login: async (_id, _type, interaction) => {
      await interaction.prompt({ type: "manual_code", message: "Paste the code" });
      throw new Error("login cancelled");
    },
  });
  f.host.hook = async (method, params) => {
    if (method !== "secrets.getForRuntime" || params?.secretRef !== INSTALLATION_REF) return;
    reading.resolve();
    await release.promise;
  };

  const original = f.state.owner;
  const started = f.oauth.start(VENDOR);
  await reading.promise;
  f.state.owner = { generation: "two" };
  release.resolve();
  await started;
  await until(() => f.events.some((event) => event.kind === "error"), "login refused");

  assert.deepEqual(
    f.host.calls.filter((entry) => entry.owner !== original),
    [],
    "the identity is never read or persisted through the replacement Host",
  );
  assert.equal(f.events.filter((event) => event.kind === "done").length, 0);
});

test("one installation identity serves every login admitted by the same Host", async (t) => {
  let prompts = 0;
  const f = fixture(t);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { loginId } = await f.oauth.start(VENDOR);
    await until(
      () => f.events.filter((event) => event.kind === "prompt").length > prompts,
      "prompt",
    );
    const prompt = f.events.filter((event) => event.kind === "prompt")[prompts];
    prompts += 1;
    f.oauth.respond({ loginId, promptId: prompt.request.promptId, value: "abc" });
    await until(
      () => f.events.filter((event) => event.kind === "done").length >= attempt + 1,
      "done",
    );
  }
  const identityCalls = f.host.calls.filter(
    (entry) => entry.params?.secretRef === INSTALLATION_REF,
  );
  assert.equal(
    identityCalls.filter((entry) => entry.method === "secrets.getForRuntime").length,
    1,
    "the identity is resolved once per Host, not once per login",
  );
  assert.equal(identityCalls.filter((entry) => entry.method === "secrets.set").length, 1);
});

test("a credential read that outlives its Host is refused instead of handed over", async (t) => {
  const f = fixture(t);
  await signIn(f);
  const reading = deferred();
  const release = deferred();
  const secretRef = secretRefForProviderOauth(ROW_ID);
  f.host.hook = async (method, params) => {
    if (method !== "secrets.getForRuntime" || params?.secretRef !== secretRef) return;
    reading.resolve();
    await release.promise;
  };

  const auth = f.oauth.resolveAuth(ROW_ID);
  await reading.promise;
  f.state.owner = { generation: "two" };
  release.resolve();
  await assert.rejects(auth, refused);
  await until(() => f.oauth.getHandoffActivity().operations === 0, "auth settled");
});

test("an account credential store is counted and closes with its admission", async (t) => {
  const f = fixture(t);
  await signIn(f);
  assert.equal(f.created.length, 2, "one catalog store, one account store");
  const store = f.created[1];
  const secretRef = secretRefForProviderOauth(ROW_ID);
  const reading = deferred();
  const release = deferred();
  f.host.hook = async (method, params) => {
    if (method !== "secrets.getForRuntime" || params?.secretRef !== secretRef) return;
    reading.resolve();
    await release.promise;
  };

  const read = store.read(VENDOR);
  await reading.promise;
  assert.ok(f.oauth.getHandoffActivity().operations > 0, "an external credential read is counted");
  release.resolve();
  assert.equal((await read).access, "access-for-abc");
  await until(() => f.oauth.getHandoffActivity().operations === 0, "read settled");

  f.oauth.dispose();
  await assert.rejects(
    store.modify(VENDOR, async () => ({
      type: "oauth",
      access: "after-dispose",
      refresh: "after-dispose",
      expires: 4102444800000,
    })),
    refused,
  );
  assert.equal(JSON.parse(f.host.secrets.get(secretRef)).access, "access-for-abc");
});

test("the vendor list is counted and a replaced Host cannot finish it", async (t) => {
  const listing = deferred();
  const release = deferred();
  const f = fixture(t);
  f.host.providers.set(ROW_ID, signedInRow());
  f.host.secrets.set(secretRefForProviderOauth(ROW_ID), storedCredential());
  f.host.hook = async (method) => {
    if (method !== "providers.list") return;
    listing.resolve();
    await release.promise;
  };

  const vendors = f.oauth.listVendors();
  await listing.promise;
  assert.ok(f.oauth.getHandoffActivity().operations > 0, "the vendor list is admitted work");
  f.state.owner = { generation: "two" };
  release.resolve();
  await assert.rejects(vendors, refused);
  await until(() => f.oauth.getHandoffActivity().operations === 0, "list settled");
});

test("answering a prompt of a retired attempt is refused", async (t) => {
  const f = fixture(t);
  const { loginId } = await f.oauth.start(VENDOR);
  await until(() => f.events.some((event) => event.kind === "prompt"), "prompt");
  const prompt = f.events.find((event) => event.kind === "prompt");

  f.state.owner = { generation: "two" };
  assert.equal(
    f.oauth.respond({ loginId, promptId: prompt.request.promptId, value: "abc" }),
    false,
    "a replaced Host cannot resume the conversation",
  );
  assert.equal(f.oauth.cancel(loginId), true);
  await until(() => f.events.some((event) => event.kind === "cancelled"), "cancelled");
  assert.equal(f.host.secrets.has(secretRefForProviderOauth(ROW_ID)), false);
  assert.equal(f.events.filter((event) => event.kind === "done").length, 0);
});

test("delayed progress and consent events do not reach the renderer after replacement", async (t) => {
  const entered = deferred();
  const resume = deferred();
  const f = fixture(t, {
    login: async (_id, _type, interaction) => {
      entered.resolve();
      await resume.promise;
      interaction.notify({ type: "progress", message: "still going" });
      interaction.notify({ type: "auth_url", url: "https://claude.ai/oauth/authorize" });
      throw new Error("login cancelled");
    },
  });
  await f.oauth.start(VENDOR);
  await entered.promise;

  f.state.owner = { generation: "two" };
  resume.resolve();
  await until(() => f.events.some((event) => event.kind === "error"), "attempt retired");
  await turn();
  assert.equal(
    f.events.filter((event) => event.kind === "progress").length,
    0,
    "a retired attempt does not report progress",
  );
  assert.equal(
    f.events.filter((event) => event.kind === "authUrl").length,
    0,
    "a retired attempt does not offer a consent URL",
  );
  assert.equal(f.opens.length, 0, "and it does not launch a browser");
});

test("a stale account refresh never starts work against the replacement Host", async (t) => {
  let originalRefreshes = 0;
  const f = fixture(t, {
    refreshModels: async () => {
      originalRefreshes += 1;
    },
  });
  await signIn(f);
  const account = f.collections[1];
  const before = f.host.calls.length;
  const refreshes = originalRefreshes;

  f.state.owner = { generation: "two" };
  await account.refresh({ allowNetwork: true, force: true });

  assert.deepEqual(f.host.calls.slice(before), [], "no Host call is made after the replacement");
  assert.equal(originalRefreshes, refreshes, "the vendor refresh is not started either");
  assert.ok(
    f.logs.some((entry) => entry.level === "warn" && entry.message === "vendor model refresh refused"),
    "the refusal is reported instead of being silent",
  );
});

test("a refresh is counted from its first await through publication", async (t) => {
  const gates = { original: undefined, publish: undefined };
  const publishEntered = { current: undefined };
  const f = fixture(t, {
    refreshModels: async () => {
      await gates.original?.promise;
    },
    fetch: async () => Response.json({ data: [{ id: "claude-live-1" }] }),
    publish: async () => {
      publishEntered.current?.resolve();
      await gates.publish?.promise;
    },
  });
  await signIn(f);
  const account = f.collections[1];
  const uncontained = f.oauth.getHandoffActivity().uncontainedResources;

  gates.original = deferred();
  const refreshing = account.refresh({ allowNetwork: true, force: true });
  await turn();
  assert.ok(f.oauth.getHandoffActivity().operations > 0, "the vendor refresh is counted");

  gates.original.resolve();
  gates.publish = deferred();
  publishEntered.current = deferred();
  await publishEntered.current.promise;
  assert.ok(f.oauth.getHandoffActivity().operations > 0, "publication is counted too");

  gates.publish.resolve();
  await refreshing;
  assert.equal(f.oauth.getHandoffActivity().operations, 0);
  assert.ok(
    (await account.getAvailable(VENDOR)).some((model) => model.id === "claude-live-1"),
    "the live list is published for the account it was read for",
  );
  assert.equal(f.oauth.getHandoffActivity().uncontainedResources, uncontained + 1);
});

/** A plugin row and an expired credential, as a reload would leave them. */
function pluginFixture(t, bridge) {
  const provider = { ...PLUGIN_PROVIDER };
  const f = fixture(t, { getPluginOAuthBridge: () => bridge });
  f.host.providers.set(provider.providerId, {
    id: provider.providerId,
    name: provider.name,
    vendorKey: "custom",
    ownerPluginId: provider.pluginId,
    authKind: "oauth",
    baseUrl: "https://api.example.test/v1",
    enabled: true,
  });
  const secretRef = secretRefForProviderOauth(provider.providerId);
  f.host.secrets.set(secretRef, JSON.stringify({
    accessToken: "expired-access",
    refreshToken: "refresh-token",
    expiresAt: Date.now() - 1,
  }));
  return { f, provider, secretRef };
}

test("a plugin refresh is bound to the runtime it was admitted for", async (t) => {
  const reading = deferred();
  const release = deferred();
  const runtimeIds = [];
  const bridge = {
    listOAuthProviders: () => [provider],
    invokeProviderOAuth: async (_pluginId, _contributionId, request, _signal, expectedRuntimeId) => {
      runtimeIds.push(expectedRuntimeId);
      return { accessToken: "new-access", expiresAt: Date.now() + 3_600_000 };
    },
  };
  const { f, provider, secretRef } = pluginFixture(t, bridge);
  f.host.hook = async (method, params) => {
    if (method !== "secrets.getForRuntime" || params?.secretRef !== secretRef) return;
    reading.resolve();
    await release.promise;
  };

  const auth = f.oauth.resolveAuth(provider.providerId);
  await reading.promise;
  // The runtime reloads while the refresh is still queued behind the secret read.
  provider.runtimeId = "runtime-2";
  release.resolve();
  await assert.rejects(auth, /plugin provider changed during OAuth refresh/);

  assert.deepEqual(runtimeIds, [], "the refresh is never sent to the runtime that replaced it");
  assert.deepEqual(
    f.host.calls.filter((entry) => entry.method === "secrets.set"),
    [],
    "and it never writes a credential for it",
  );
  assert.equal(JSON.parse(f.host.secrets.get(secretRef)).accessToken, "expired-access");
});

test("a plugin refresh overtaken by a runtime reload never stores its credential", async (t) => {
  const invoked = deferred();
  const release = deferred();
  const runtimeIds = [];
  const bridge = {
    listOAuthProviders: () => [provider],
    invokeProviderOAuth: async (_pluginId, _contributionId, request, _signal, expectedRuntimeId) => {
      runtimeIds.push(expectedRuntimeId);
      invoked.resolve();
      await release.promise;
      return { accessToken: "stale-access", expiresAt: Date.now() + 3_600_000 };
    },
  };
  const { f, provider, secretRef } = pluginFixture(t, bridge);

  const auth = f.oauth.resolveAuth(provider.providerId);
  await invoked.promise;
  provider.runtimeId = "runtime-2";
  release.resolve();
  await assert.rejects(auth, /plugin provider changed during OAuth refresh/);

  assert.deepEqual(runtimeIds, ["runtime-1"], "the refresh kept the runtime that admitted it");
  assert.deepEqual(
    f.host.calls.filter((entry) => entry.method === "secrets.set"),
    [],
    "the stale credential is never stored, not even briefly",
  );
  assert.equal(JSON.parse(f.host.secrets.get(secretRef)).accessToken, "expired-access");
});
