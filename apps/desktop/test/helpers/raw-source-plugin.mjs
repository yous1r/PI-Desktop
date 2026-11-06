import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Match Vite's raw-source imports when tests bundle Main code with esbuild. */
export const rawSourcePlugin = {
  name: "raw-source",
  setup(build) {
    build.onResolve({ filter: /\.mjs\?raw$/ }, ({ path, resolveDir }) => ({
      path: resolve(resolveDir, path.slice(0, -4)), namespace: "raw-source",
    }));
    build.onLoad({ filter: /.*/, namespace: "raw-source" }, async ({ path }) => ({
      contents: await readFile(path, "utf8"), loader: "text",
    }));
  },
};
