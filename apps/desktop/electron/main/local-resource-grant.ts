import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeniedFsPath } from "@pi-desktop/plugin-sdk";

/** Created only from a Desktop-owned view-open request; never read from plugin payloads. */
export type LocalResourceGrant = { path: string; realPath: string; expiresAt: number };
const inside = (root: string, path: string) => {const rel=relative(root,path);return !!rel && rel!==".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);};
export function localResourceGrant(dataDir: string, path: string, sessionId?: string): LocalResourceGrant | undefined {
  if (!sessionId || !isAbsolute(path) || isDeniedFsPath(path.replaceAll("\\","/"))) return undefined;
  try {
    const full=realpathSync(path);
    const roots=[join(dataDir,"scratch",sessionId),join(dataDir,"attachments")];
    if (!roots.some(root=>{try{return inside(realpathSync(root),full);}catch{return false;}}) || !statSync(full).isFile() || isDeniedFsPath(full.replaceAll("\\","/"))) return undefined;
    return {path:resolve(path),realPath:full,expiresAt:Date.now()+30*60_000};
  }catch{return undefined;}
}
export function resolveLocalResource(grant: LocalResourceGrant | undefined, path: string): string | undefined {
  if (!grant || grant.expiresAt<=Date.now() || !isAbsolute(path) || resolve(path)!==grant.path) return undefined;
  try {const full=realpathSync(path);return full===grant.realPath && statSync(full).isFile() && !isDeniedFsPath(full.replaceAll("\\","/")) ? full : undefined;}catch{return undefined;}
}
