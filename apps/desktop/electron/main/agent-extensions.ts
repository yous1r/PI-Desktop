/** Trusted-extension import generation; UI ownership is implemented separately. */
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertImportedPackagePath, discoverImportedPackageSkills } from "./imported-package-skills";
import {
  IMPORTED_PLUGIN_ID_PREFIX,
  IMPORTED_PLUGIN_MAIN,
  IMPORTED_PLUGIN_WRAPPER_SOURCE,
} from "./imported-plugin-wrapper";
import { discoverManualPath } from "@pi-desktop/agent-runtime";
export { defaultDependencyRunner, installExtensionDependencies } from "./npm-installer";
export type { DependencyCommandRunner, ExtensionDependencyInstallResult } from "./npm-installer";
import { ErrorCodes } from "@pi-desktop/shared";
export { AgentExtensionBridge, type AgentExtensionBridgeOptions } from "./agent-extension-ui";

const NPM_LOCKFILE_NAMES = ["package-lock.json", "npm-shrinkwrap.json"] as const;

const IMPORT_SENSITIVE_FILE_NAMES = new Set([
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".git-credentials",
]);
const IMPORT_SENSITIVE_DIRECTORY_NAMES = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
]);

function isSensitiveImportedPath(relativePath: string): boolean {
  const parts = relativePath.split(sep).filter(Boolean);
  if (parts.some((part) => IMPORT_SENSITIVE_DIRECTORY_NAMES.has(part.toLowerCase()))) return true;
  const name = parts.at(-1)?.toLowerCase() ?? "";
  return (
    IMPORT_SENSITIVE_FILE_NAMES.has(name) ||
    name.startsWith(".env") ||
    name.startsWith("id_rsa") ||
    /\.(pem|p12|pfx|keystore)$/.test(name)
  );
}

function importedPathError(message: string): Error & { errorCode?: string } {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

function slugFor(path: string): string {
  const stem = basename(path, extname(path))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return stem || "extension";
}

/**
 * Build a plugin directory from a pi extension file or directory (spec §3):
 * copies the source under `src/`, writes a manifest that declares the entry
 * files as `contributes.agentExtensions`, and a CommonJS no-op `main.cjs`. A directory
 * that ships a `package.json` also gets it (plus its lockfile) at the plugin
 * root so {@link installExtensionDependencies} can resolve its dependencies
 * there; `node_modules` itself is never copied — it is reinstalled.
 */
export function generateImportedExtensionPlugin(
  source: string,
  importRoot: string,
): { path: string; id: string; entries: string[] } {
  const resolved = existsSync(source) ? realpathSync(source) : resolve(source);
  const isDirectory = existsSync(resolved) && statSync(resolved).isDirectory();
  const { skills, skillsOnly } = isDirectory
    ? discoverImportedPackageSkills(resolved)
    : { skills: [], skillsOnly: false };
  // A skill-only package may contain helper scripts; do not promote a root
  // index.js or other incidental script to executable agent extensions.
  const specs = skillsOnly ? [] : discoverManualPath(resolved);
  if (specs.length === 0 && skills.length === 0) {
    throw importedPathError("no extension entry found at that path");
  }
  for (const spec of specs) {
    assertImportedPackagePath(isDirectory ? resolved : dirname(resolved), spec.entry);
    if (isSensitiveImportedPath(relative(isDirectory ? resolved : dirname(resolved), spec.entry))) {
      throw importedPathError("imported packages cannot contain credential files");
    }
  }
  const slug = slugFor(resolved);
  mkdirSync(importRoot, { recursive: true });
  if (lstatSync(importRoot).isSymbolicLink()) {
    throw importedPathError("import destination root cannot be a symbolic link");
  }
  let dir: string;
  let suffix = 2;
  while (true) {
    const candidate = join(importRoot, suffix === 2 ? slug : `${slug}-${suffix}`);
    const destinationRelative = relative(resolved, resolve(candidate));
    if (isDirectory && !isAbsolute(destinationRelative) && !destinationRelative.split(sep).includes("..")) {
      throw importedPathError("import destination cannot be inside the selected package");
    }
    try {
      // Atomic creation prevents a pre-existing or racing symlink from being followed.
      mkdirSync(candidate);
      dir = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        suffix += 1;
        continue;
      }
      throw error;
    }
  }
  const id = `${IMPORTED_PLUGIN_ID_PREFIX}${basename(dir)}`;
  const srcDir = join(dir, "src");
  try {
    mkdirSync(srcDir);
    if (isDirectory) {
      cpSync(resolved, srcDir, {
        recursive: true,
        filter: (path) => {
          const relativePath = relative(resolved, path);
          // Exclude dependencies within the selection, not its npm installation ancestors.
          if (relativePath.split(sep).includes("node_modules")) return false;
          if (relativePath && isSensitiveImportedPath(relativePath)) return false;
          if (lstatSync(path).isSymbolicLink()) {
            throw importedPathError("imported packages cannot contain a symbolic link");
          }
          return true;
        },
      });
    } else {
      cpSync(resolved, join(srcDir, basename(resolved)));
    }
    const entries = specs.map((spec) =>
      isDirectory
        ? `src/${relative(resolved, spec.entry).split("\\").join("/")}`
        : `src/${basename(resolved)}`,
    );
    const manifest = {
      schemaVersion: 1,
      id,
      name: slug,
      version: "0.0.0",
      description: `Imported pi extension from ${resolved}`,
      main: IMPORTED_PLUGIN_MAIN,
      permissions: [...(entries.length ? ["agent.extension"] : []), ...(skills.length ? ["agent.prompt.inject"] : [])],
      contributes: {
        ...(entries.length ? { agentExtensions: entries } : {}),
        ...(skills.length ? { skills: skills.map((path) => ({
          path: `src/${path}`,
          // Distinct directories often use the same SKILL.md basename.
          id: `skill-${createHash("sha256").update(path).digest("hex").slice(0, 16)}`,
        })) } : {}),
      },
    };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    writeFileSync(
      join(dir, IMPORTED_PLUGIN_MAIN),
      IMPORTED_PLUGIN_WRAPPER_SOURCE,
      "utf8",
    );
    if (isDirectory) {
      const rootPackageJson = join(resolved, "package.json");
      if (existsSync(rootPackageJson)) {
        // A `workspaces` field would send npm into the copied sources under
        // src/; strip it so the install sees only the declared dependencies.
        try {
          const pkg = JSON.parse(readFileSync(rootPackageJson, "utf8")) as Record<string, unknown>;
          if (pkg && typeof pkg === "object" && "workspaces" in pkg) {
            delete pkg.workspaces;
            writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", "utf8");
          } else {
            copyFileSync(rootPackageJson, join(dir, "package.json"));
          }
        } catch {
          // Not valid JSON: copy verbatim; the install step reports the failure.
          copyFileSync(rootPackageJson, join(dir, "package.json"));
        }
        for (const file of NPM_LOCKFILE_NAMES) {
          if (existsSync(join(resolved, file))) copyFileSync(join(resolved, file), join(dir, file));
        }
      }
    }
    return { path: dir, id, entries };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
