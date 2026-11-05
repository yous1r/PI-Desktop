import { delimiter, dirname, isAbsolute } from "node:path";

/** The headless bundle owns Node; workspace children must not need a system install. */
export function nodeRuntimePath(nodeBinary: string, currentPath = ""): string {
  // A bare command is resolved by the caller's PATH. Never add cwd implicitly.
  if (!isAbsolute(nodeBinary)) return currentPath;
  const directory = dirname(nodeBinary);
  return [directory, ...currentPath.split(delimiter).filter(part => part && part !== directory)].join(delimiter);
}
