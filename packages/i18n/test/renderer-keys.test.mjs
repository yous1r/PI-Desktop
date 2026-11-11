/**
 * Every literal `t("…")` key in the renderer must exist in every shipped catalog.
 *
 * `catalogs.test.mjs` only compares locales against English, so a key that a
 * component uses but no locale defines passes there and then renders as the
 * raw key string in the UI. That is exactly how `settings.serviceModels` and
 * friends shipped untranslated, so this test closes the loop from the call
 * sites back to the catalogs. Canonical thinking-level values are rendered
 * directly and intentionally do not participate in this catalog contract.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { catalogs, flattenCatalog } from "../src/index.ts";

const SRC = new URL("../../../apps/desktop/src/", import.meta.url);

/**
 * Renderer trees that receive a namespace-scoped `TFunction` instead of the
 * default `translation` namespace. Their literal keys are checked against the
 * command-center fragment pair below, exactly as the default-namespace scan
 * checks the rest of the renderer.
 */
const COMMAND_CENTER_SCOPED_DIRS = [
  "/apps/desktop/src/components/command-center/",
  "/apps/desktop/src/features/command-center/",
];

function normalized(path) {
  return path.split("\\").join("/");
}

function isCommandCenterScoped(path) {
  const value = normalized(path);
  return COMMAND_CENTER_SCOPED_DIRS.some((segment) => value.includes(segment));
}

/** Every .ts/.tsx file under the renderer source tree. */
async function sources(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(path)));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/**
 * i18next resolves a bare key against its plural forms when a count is passed,
 * so `key_one` / `key_other` satisfy a lookup for `key`Base.
 */
function has(catalog, key) {
  return key in catalog || `${key}_one` in catalog || `${key}_other` in catalog;
}

const files = await sources(fileURLToPath(SRC));
const used = new Map();
for (const file of files) {
  if (isCommandCenterScoped(file)) continue;
  const text = await readFile(file, "utf8");
  // Only dotted literals can be resolved statically.
  for (const match of text.matchAll(/\bt\(\s*"([a-zA-Z0-9_]+\.[a-zA-Z0-9_.]+)"/g)) {
    if (!used.has(match[1])) used.set(match[1], file);
  }
}

const flats = Object.fromEntries(
  Object.entries(catalogs).map(([id, catalog]) => [id, flattenCatalog(catalog)]),
);

test("the renderer uses a non-trivial number of catalog keys", () => {
  // Guards against the scan silently matching nothing after a refactor.
  assert.ok(used.size > 500, `only found ${used.size} keys — is the scan still correct?`);
});

for (const [id, catalog] of Object.entries(flats)) {
  test(`every key the renderer asks for exists in ${id}`, () => {
    const missing = [...used].filter(([key]) => !has(catalog, key));
    assert.deepEqual(
      missing.map(([key, file]) => `${key} (${file.replace(/.*\/apps\//, "apps/")})`),
      [],
    );
  });
}

test("the command-center namespace keeps its en/zh-CN pairs and covers every literal key", async () => {
  const fragment = async (name) =>
    JSON.parse(
      await readFile(
        new URL(`../../../apps/desktop/src/components/command-center/locales/${name}`, import.meta.url),
        "utf8",
      ),
    );
  const enFragment = await fragment("en.json");
  const zhFragment = await fragment("zh-CN.json");
  const flatten = (node, prefix = "") =>
    Object.entries(node).flatMap(([key, value]) =>
      typeof value === "string" ? [`${prefix}${key}`] : flatten(value, `${prefix}${key}.`),
    );
  const enKeys = new Set(flatten(enFragment));
  const zhKeys = new Set(flatten(zhFragment));
  assert.deepEqual([...enKeys].sort(), [...zhKeys].sort(), "en and zh-CN carry the same namespace shape");

  const keys = new Set();
  for (const file of files) {
    if (!isCommandCenterScoped(file)) continue;
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/\bt\(\s*"([a-zA-Z0-9_]+\.[a-zA-Z0-9_.]+)"/g)) keys.add(match[1]);
  }
  assert.ok(keys.size > 40, `the command-center scan found ${keys.size} keys`);
  for (const key of keys) {
    assert.ok(enKeys.has(key), `missing English command-center label for ${key}`);
    assert.ok(zhKeys.has(key), `missing Chinese command-center label for ${key}`);
  }
});
