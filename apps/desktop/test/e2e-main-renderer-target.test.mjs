import assert from "node:assert/strict";
import test from "node:test";
import { connectRenderer as connectUi } from "./e2e/plugin-ui-slots/clients.mjs";
import { connectRenderer as connectDialogs } from "./e2e/trusted-extensions/renderer.mjs";

const page = (url, id) => ({ type: "page", url, webSocketDebuggerUrl: `ws://fixture/${id}` });
const main = page("file:///app/out/renderer/index.html", "main");
const otherPages = [
  page("file:///app/out/renderer/index.html?surface=personal-todos", "todos"),
  page("file:///app/out/renderer/index.html?%73urface=plugin-launcher", "launcher"),
  page("file:///plugin/index.html", "plugin"),
  page("https://example.test/renderer/index.html", "remote"),
  page("devtools://devtools/bundled/inspector.html", "devtools"),
  page("not a url", "invalid"),
  { type: "page", webSocketDebuggerUrl: "ws://fixture/no-url" },
];

function transport(t, targets) {
  const selected = [];
  t.mock.method(globalThis, "fetch", async () => ({ json: async () => targets }));
  class Socket extends EventTarget {
    constructor(url) {
      super();
      selected.push(url);
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(raw) {
      const request = JSON.parse(raw);
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ id: request.id, result: {} }),
      })));
    }
    close() {}
  }
  const originalSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: Socket });
  t.after(() => Object.defineProperty(globalThis, "WebSocket", originalSocket));
  return selected;
}

for (const [name, connect] of [["UI", connectUi], ["extension dialog", connectDialogs]]) {
  test(`${name} connector selects the app shell when widgets and plugin pages precede it`, async (t) => {
    const selected = transport(t, [...otherPages, main]);
    const client = await connect(1);
    client.close();
    assert.deepEqual(selected, [main.webSocketDebuggerUrl]);
  });

  test(`${name} connector refuses a widget-only or ambiguous page list`, async (t) => {
    const targets = [...otherPages];
    const selected = transport(t, targets);
    await assert.rejects(connect(1), /main renderer target; found 0/);
    targets.push(main, page(main.url, "other-main"));
    await assert.rejects(connect(1), /main renderer target; found 2/);
    assert.deepEqual(selected, []);
  });
}
