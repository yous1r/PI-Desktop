/** Portable comparison for Host/UI representations of the same Windows project. */
export function projectIdentity(path: string): string {
  if (!/^[A-Za-z]:[\\/]/.test(path) && !path.startsWith('\\\\')) return path;
  const normalized = path.replaceAll('\\', '/').replace(/^([a-z]):/i, (_match, drive: string) => `${drive.toUpperCase()}:`);
  return normalized.length > 3 ? normalized.replace(/\/+$/, '') : normalized;
}
export function sameProject(left: string | null | undefined, right: string | null | undefined): boolean {
  return left != null && right != null && projectIdentity(left) === projectIdentity(right);
}
