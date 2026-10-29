/**
 * Pure exclusion matcher for remote mirror synchronization (spec 23 §6.3, ADR 0338).
 *
 * Evaluates file paths against default exclusions, .pi-desktopignore patterns,
 * and per-project include exceptions. Exclusions apply to upload only.
 * This module has NO file system or network I/O and is fully unit-testable.
 */

export const DEFAULT_EXCLUSIONS: readonly string[] = [
  ".venv",
  "venv",
  "__pycache__",
  "*.pyc",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  "*.egg-info",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  "target",
  ".gradle",
  ".git",
  ".DS_Store",
  "*.log",
  "tmp",
  "temp",
];

export type CompiledRule = {
  raw: string;
  regex: RegExp;
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
};

export type SyncExclusionOptions = {
  defaultExclusions?: readonly string[];
  disabledDefaultExclusions?: readonly string[];
  customPatterns?: readonly string[] | string;
  includeExceptions?: readonly string[];
};

export function parseIgnorePatterns(content: string): string[] {
  if (!content) return [];
  const lines = content.split(/\r?\n/);
  const patterns: string[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    patterns.push(trimmed);
  }
  return patterns;
}

export function compileRule(rawPattern: string): CompiledRule | null {
  let line = rawPattern.replace(/\r$/, "").trim();
  if (!line || line.startsWith("#")) return null;

  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1).trim();
  }

  const dirOnly = line.endsWith("/");
  if (dirOnly) line = line.slice(0, -1);

  const anchored = line.startsWith("/");
  if (anchored) line = line.slice(1);
  if (!line) return null;

  const isAnchored = anchored || line.includes("/");

  let source = "";
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "*") {
      if (line[i + 1] === "*") {
        i += 1;
        if (line[i + 1] === "/") {
          i += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }

  const regexStr = isAnchored
    ? `^${source}(?:/.*)?$`
    : `^(?:.*/)?${source}(?:/.*)?$`;

  return {
    raw: rawPattern,
    regex: new RegExp(regexStr),
    negated,
    dirOnly,
    anchored: isAnchored,
  };
}

export function normalizeRelPath(value: string): string {
  if (!value) return "";
  let normalized = value.replace(/\\/g, "/");
  normalized = normalized.replace(/^\/+|\/+$/g, "");
  return normalized;
}

export class SyncExclusionMatcher {
  private readonly defaultRules: CompiledRule[] = [];
  private readonly customRules: CompiledRule[] = [];
  private readonly includeExceptionRules: CompiledRule[] = [];

  constructor(options: SyncExclusionOptions = {}) {
    const disabledSet = new Set(options.disabledDefaultExclusions ?? []);
    const activeDefaults = (options.defaultExclusions ?? DEFAULT_EXCLUSIONS).filter(
      (pat) => !disabledSet.has(pat),
    );

    for (const pat of activeDefaults) {
      const rule = compileRule(pat);
      if (rule) this.defaultRules.push(rule);
    }

    const customPatterns = typeof options.customPatterns === "string"
      ? parseIgnorePatterns(options.customPatterns)
      : options.customPatterns ?? [];

    for (const pat of customPatterns) {
      const rule = compileRule(pat);
      if (rule) this.customRules.push(rule);
    }

    for (const pat of options.includeExceptions ?? []) {
      const rule = compileRule(pat);
      if (rule) this.includeExceptionRules.push(rule);
    }
  }

  /**
   * Returns true if `relPath` should be excluded from sync/upload.
   *
   * Evaluation order:
   * 1. Per-project `includeExceptions` unconditionally include matched paths.
   * 2. Custom `.pi-desktopignore` rules are evaluated in declaration order (supporting `!`).
   * 3. Default exclusions match unless overridden by custom negation or include exception.
   */
  isExcluded(relPath: string, isDirectory = false): boolean {
    const path = normalizeRelPath(relPath);
    if (!path) return false;

    // 1. Per-project include exceptions take top priority
    for (const rule of this.includeExceptionRules) {
      if (rule.dirOnly && !isDirectory && !path.includes("/")) continue;
      if (rule.regex.test(path)) {
        return false;
      }
    }

    // 2. Custom ignore rules evaluated in order (last matching rule wins)
    let customVerdict: boolean | undefined = undefined;
    for (const rule of this.customRules) {
      if (rule.dirOnly && !isDirectory && !path.includes("/")) continue;
      if (rule.regex.test(path)) {
        customVerdict = !rule.negated;
      }
    }

    if (customVerdict !== undefined) {
      return customVerdict;
    }

    // 3. Default exclusions
    for (const rule of this.defaultRules) {
      if (rule.dirOnly && !isDirectory && !path.includes("/")) continue;
      if (rule.regex.test(path)) {
        return true;
      }
    }

    return false;
  }

  getEffectiveRules(): {
    defaults: string[];
    custom: string[];
    includeExceptions: string[];
  } {
    return {
      defaults: this.defaultRules.map((r) => r.raw),
      custom: this.customRules.map((r) => r.raw),
      includeExceptions: this.includeExceptionRules.map((r) => r.raw),
    };
  }
}
