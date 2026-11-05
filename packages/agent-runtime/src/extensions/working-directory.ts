import { mkdirSync } from "node:fs";

/** Preserve the legacy extension cwd fallback; owner routing never uses process.cwd(). */
export function extensionWorkingDirectory(workspaceRoot?: string, projectPath?: string, scratchDir?: string): string {
  const root = workspaceRoot ?? projectPath;
  if (root) return root;
  if (!scratchDir) return process.cwd();
  // Temporary sessions normally create scratch lazily; extensions need it at startup.
  try { mkdirSync(scratchDir, { recursive: true }); } catch {
    // The existing exec path reports the missing directory; extension loading stays fail-open.
  }
  return scratchDir;
}
