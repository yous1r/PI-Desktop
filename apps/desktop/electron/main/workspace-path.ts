import { win32 } from "node:path";

/** Compare native Windows workspace snapshots with Host storage spelling. */
export function sameWorkspacePath(left: string, right: string, platform: string = process.platform): boolean {
  if (left === right) return true;
  if (platform !== "win32" || !win32.isAbsolute(left) || !win32.isAbsolute(right)) return false;
  const normalize = (path: string) => {
    // Host storage strips this prefix for drive paths, but preserves UNC paths.
    const native = path.replaceAll("/", "\\").replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, "");
    const root = win32.parse(native).root;
    return native.length > root.length ? native.replace(/\\+$/, "") : native;
  };
  return normalize(left) === normalize(right);
}
