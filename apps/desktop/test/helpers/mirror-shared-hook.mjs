import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))));
const shared = pathToFileURL(join(root, "packages/shared/dist/index.js")).href;

/**
 * The desktop worktree reuses the primary checkout's node_modules junction.
 * Redirect this one package import to the current worktree build so the test
 * asserts the exact IPC channels this branch defines, not a stale primary copy.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@pi-desktop/shared") {
    return { url: shared, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
