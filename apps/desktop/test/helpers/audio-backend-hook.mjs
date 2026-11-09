import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transformWithEsbuild } from "vite";
import { resolve as resolveTypeScript } from "./ts-import-hooks.mjs";

export async function resolve(specifier, context, next) {
  const target = {
    electron: new URL("./electron-voice-stub.mjs", import.meta.url),
    "@picovoice/pvrecorder-node": new URL("./pv-recorder-stub.mjs", import.meta.url),
    "transcribe-cpp": new URL("./voice-native-model-stub.mjs", import.meta.url),
    "@pi-desktop/voice-runtime": new URL("../../../../packages/voice-runtime/src/index.ts", import.meta.url),
  }[specifier];
  return target ? next(target.href, context) : resolveTypeScript(specifier, context, next);
}

export async function load(url, context, next) {
  if (!url.endsWith(".ts")) return next(url, context);
  const source = await readFile(fileURLToPath(url), "utf8");
  const { code } = await transformWithEsbuild(source, url, { loader: "ts", format: "esm" });
  return { format: "module", shortCircuit: true, source: code };
}
