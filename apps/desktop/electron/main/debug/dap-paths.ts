/**
 * DAP Path Mapping.
 *
 * Translates paths between local filesystem and remote mirror host.
 * A session carries pathMappings: [{ localRoot, remoteRoot }].
 *
 * Remote paths are Linux/POSIX paths.
 * Local paths may be Windows or POSIX paths.
 *
 * Rule: An unmapped remote path is returned as a read-only remote source rather
 * than being guessed.
 */

export type DapPathMapping = {
  localRoot: string;
  remoteRoot: string;
};

export type DapChecksum = {
  algorithm: string;
  checksum: string;
};

export type DapSource = {
  name?: string;
  path?: string;
  sourceReference?: number;
  presentationHint?: "normal" | "emphasize" | "deemphasize";
  origin?: string;
  sources?: DapSource[];
  adapterData?: unknown;
  checksums?: DapChecksum[];
  /** Flag marking read-only remote sources that do not correspond to local files. */
  readOnly?: boolean;
};

export type RemoteSource = DapSource & {
  path: string;
  readOnly: true;
  origin: string;
  presentationHint?: "deemphasize";
};

export type TranslatedPathResult =
  | {
      mapped: true;
      localPath: string;
      remotePath: string;
    }
  | {
      mapped: false;
      remotePath: string;
      readOnlySource: RemoteSource;
    };

/**
 * Normalizes a remote Linux path:
 * Converts backslashes to forward slashes, collapses redundant slashes,
 * and strips trailing slash (unless the path is root "/").
 */
export function normalizeRemotePath(p: string): string {
  if (!p) return "";
  let clean = p.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (clean.length > 1 && clean.endsWith("/")) {
    clean = clean.slice(0, -1);
  }
  return clean;
}

/**
 * Normalizes a local path for consistent prefix comparison.
 */
export function normalizeLocalPath(p: string): string {
  if (!p) return "";
  let clean = p.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (clean.length > 1 && clean.endsWith("/")) {
    clean = clean.slice(0, -1);
  }
  return clean;
}

/**
 * Checks whether a path starts with a directory prefix at a path boundary.
 */
function pathStartsWith(path: string, prefix: string, caseInsensitive = false): boolean {
  const p = caseInsensitive ? path.toLowerCase() : path;
  const pre = caseInsensitive ? prefix.toLowerCase() : prefix;

  if (p === pre) {
    return true;
  }
  if (pre === "/") {
    return p.startsWith("/");
  }
  return p.startsWith(pre + "/");
}

/**
 * Joins a local root with a relative POSIX path, preserving the local root's separator convention.
 */
function joinLocalPath(localRoot: string, relPosixPath: string): string {
  if (!relPosixPath) {
    return localRoot;
  }

  const usesBackslash = localRoot.includes("\\") || /^[a-zA-Z]:\\/.test(localRoot);
  const trimmed = localRoot.replace(/[/\\]+$/, "");

  if (usesBackslash) {
    const winRel = relPosixPath.replace(/\//g, "\\");
    return `${trimmed}\\${winRel}`;
  }

  return `${trimmed}/${relPosixPath}`;
}

/**
 * Translates a remote path to a local path using the provided mappings.
 * Returns the mapped local path, or null if no mapping matched.
 */
export function mapRemoteToLocal(
  remotePath: string,
  mappings: readonly DapPathMapping[]
): string | null {
  if (!remotePath || !mappings || mappings.length === 0) {
    return null;
  }

  const cleanRemote = normalizeRemotePath(remotePath);

  // Sort mappings by remoteRoot length descending so the most specific mapping matches first
  const sorted = [...mappings].sort(
    (a, b) => normalizeRemotePath(b.remoteRoot).length - normalizeRemotePath(a.remoteRoot).length
  );

  for (const mapping of sorted) {
    const cleanRemoteRoot = normalizeRemotePath(mapping.remoteRoot);

    if (pathStartsWith(cleanRemote, cleanRemoteRoot, false)) {
      if (cleanRemote === cleanRemoteRoot) {
        return mapping.localRoot;
      }
      const relPath =
        cleanRemoteRoot === "/"
          ? cleanRemote.slice(1)
          : cleanRemote.slice(cleanRemoteRoot.length + 1);
      return joinLocalPath(mapping.localRoot, relPath);
    }
  }

  return null;
}

/**
 * Translates a local path to a remote Linux path using the provided mappings.
 * Used when setting breakpoints on local files before sending to the remote adapter.
 * Returns the mapped remote path, or null if no mapping matched.
 */
export function mapLocalToRemote(
  localPath: string,
  mappings: readonly DapPathMapping[]
): string | null {
  if (!localPath || !mappings || mappings.length === 0) {
    return null;
  }

  const cleanLocal = normalizeLocalPath(localPath);
  const isWindowsPath = /^[a-zA-Z]:/.test(cleanLocal);

  const sorted = [...mappings].sort(
    (a, b) => normalizeLocalPath(b.localRoot).length - normalizeLocalPath(a.localRoot).length
  );

  for (const mapping of sorted) {
    const cleanLocalRoot = normalizeLocalPath(mapping.localRoot);

    if (pathStartsWith(cleanLocal, cleanLocalRoot, isWindowsPath)) {
      const cleanRemoteRoot = normalizeRemotePath(mapping.remoteRoot);
      if (cleanLocal.length === cleanLocalRoot.length) {
        return cleanRemoteRoot;
      }
      const relPath = cleanLocal.slice(cleanLocalRoot.length + 1);
      return cleanRemoteRoot === "/" ? `/${relPath}` : `${cleanRemoteRoot}/${relPath}`;
    }
  }

  return null;
}

/**
 * Translates a remote source object back to a local source.
 * If the remote path is mapped, the path is translated and readOnly is false.
 * If the remote path is unmapped, it is returned as a read-only remote source.
 */
export function translateRemoteSource(
  source: DapSource | undefined,
  mappings: readonly DapPathMapping[]
): DapSource | undefined {
  if (!source) {
    return undefined;
  }

  if (!source.path) {
    return { ...source };
  }

  const local = mapRemoteToLocal(source.path, mappings);
  if (local !== null) {
    return {
      ...source,
      path: local,
      readOnly: false,
    };
  }

  // An unmapped path is returned as a read-only remote source rather than being guessed
  const parts = source.path.split(/[\/\\]/);
  const filename = parts.at(-1) || source.name || source.path;

  return {
    ...source,
    name: source.name ?? filename,
    path: source.path,
    readOnly: true,
    origin: source.origin ?? "read-only remote source",
    presentationHint: source.presentationHint ?? "deemphasize",
  };
}

/**
 * Translates a single remote path string, distinguishing mapped from unmapped read-only sources.
 */
export function translateRemotePath(
  remotePath: string,
  mappings: readonly DapPathMapping[]
): TranslatedPathResult {
  const local = mapRemoteToLocal(remotePath, mappings);
  if (local !== null) {
    return {
      mapped: true,
      localPath: local,
      remotePath,
    };
  }

  const parts = remotePath.split(/[\/\\]/);
  const filename = parts.at(-1) || remotePath;

  return {
    mapped: false,
    remotePath,
    readOnlySource: {
      name: filename,
      path: remotePath,
      readOnly: true,
      origin: "read-only remote source",
      presentationHint: "deemphasize",
    },
  };
}
