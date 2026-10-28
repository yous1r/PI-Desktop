import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type HelperTarget = {
  target: "x86_64-unknown-linux-musl" | "aarch64-unknown-linux-musl";
  arch: "x64" | "arm64";
};

type HelperManifest = {
  schemaVersion: 1;
  version: string;
  target: HelperTarget["target"];
  arch: HelperTarget["arch"];
  file: string;
  sha256: string;
};

export type HelperArtifact = {
  path: string;
  manifest: HelperManifest;
};

export type HelperBundleDependencies = {
  resourcesPath: string;
  readFile?: typeof readFile;
  desktopVersion: string;
};

export function helperTargetFromRemote(system: string, machine: string): HelperTarget | null {
  if (system.trim().toLowerCase() !== "linux") return null;
  const normalized = machine.trim().toLowerCase();
  if (normalized === "x86_64" || normalized === "amd64") {
    return { target: "x86_64-unknown-linux-musl", arch: "x64" };
  }
  if (normalized === "aarch64" || normalized === "arm64") {
    return { target: "aarch64-unknown-linux-musl", arch: "arm64" };
  }
  return null;
}

export function parseHelperManifest(value: unknown, target: HelperTarget, version: string): HelperManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The bundled pi-helper manifest is invalid");
  }
  const manifest = value as Record<string, unknown>;
  const expectedFile = `pi-helper-linux-${target.arch}`;
  if (manifest.schemaVersion !== 1
      || manifest.version !== version
      || manifest.target !== target.target
      || manifest.arch !== target.arch
      || manifest.file !== expectedFile
      || typeof manifest.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw new Error("The bundled pi-helper manifest does not match this Desktop release or remote target");
  }
  return manifest as HelperManifest;
}

export async function resolveBundledHelper(
  target: HelperTarget,
  dependencies: HelperBundleDependencies,
): Promise<HelperArtifact> {
  const file = `pi-helper-linux-${target.arch}`;
  const binaryPath = join(dependencies.resourcesPath, "pi-helper", file);
  const manifestPath = join(dependencies.resourcesPath, "pi-helper", `${file}.manifest.json`);
  const read = dependencies.readFile ?? readFile;
  let manifest: HelperManifest;
  let binary: Buffer;
  try {
    const [rawManifest, contents] = await Promise.all([read(manifestPath), read(binaryPath)]);
    manifest = parseHelperManifest(JSON.parse(rawManifest.toString("utf8")) as unknown, target, dependencies.desktopVersion);
    binary = contents;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("The bundled pi-helper manifest")) throw error;
    throw new Error("The matching bundled pi-helper artifact is unavailable");
  }
  const digest = createHash("sha256").update(binary).digest("hex");
  if (digest !== manifest.sha256) throw new Error("The bundled pi-helper artifact failed SHA-256 verification");
  return { path: binaryPath, manifest };
}
