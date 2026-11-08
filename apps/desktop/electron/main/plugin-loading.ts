import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveFsAccess, validateManifest, type PluginManifest } from "@pi-desktop/plugin-sdk";
import { repairImportedExtensionWrapper } from "./imported-plugin-wrapper";
import { migrateLegacyPromptEnhancementSettings, PROMPT_ENHANCEMENT_PLUGIN_ID } from "./plugin-prompt-enhancement-migration";
import { pluginLifecycleError, type PluginLifecycle } from "./plugin-lifecycle";
import type { LoadedPlugin, PluginHostServices, PluginProcessHandle, PluginProcessSpawner } from "./plugin-runtime";

type LoadDependencies = {
  lifecycle: PluginLifecycle;
  services: PluginHostServices;
  loaded: Map<string, LoadedPlugin>;
  spawn: PluginProcessSpawner;
  entry: string;
  development: (pluginId: string) => boolean;
  resolveInside: (path: string, entry: string) => string | null;
  dataPath: (pluginId: string) => string;
  unload: (pluginId: string, expected?: LoadedPlugin) => Promise<void>;
  initialize: (loaded: LoadedPlugin, assertCurrent: () => void) => Promise<void>;
};

/** Validate and initialize one original load; later loads never inherit its authority. */
export async function loadPluginFromPath(deps: LoadDependencies, pluginPath: string,
  grantedPermissions?: string[]): Promise<PluginManifest> {
  const { lifecycle, services } = deps;
  lifecycle.assertAdmission();
  const manifestPath = join(pluginPath, "manifest.json");
  if (!existsSync(manifestPath)) throw new Error("PLUGIN_INVALID: manifest.json missing");
  repairImportedExtensionWrapper(pluginPath);
  const validated = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (!validated.ok || !validated.manifest) throw new Error(`PLUGIN_INVALID: ${validated.error}`);
  const manifest = validated.manifest;
  return lifecycle.load(manifest.id, async assertCurrent => {
    await deps.unload(manifest.id);
    assertCurrent();
    const mainPath = deps.resolveInside(pluginPath, manifest.main);
    if (!mainPath) throw new Error("PLUGIN_INVALID: main entry must stay inside the plugin directory");
    if (!existsSync(mainPath)) throw new Error("PLUGIN_LOAD_FAILED: main entry missing");
    const access = resolveFsAccess(manifest);
    const declared = new Set(access.permissions);
    // Explicit user grants remain the ceiling, including legacy permission normalization.
    const granted = grantedPermissions === undefined ? declared : new Set(
      resolveFsAccess({ permissions: grantedPermissions }).permissions.filter(perm => declared.has(perm)));
    if (manifest.id === PROMPT_ENHANCEMENT_PLUGIN_ID && granted.has("composer.transform") &&
        (manifest.contributes?.composerTransforms?.length ?? 0) > 0 && services.getLegacyPromptEnhancementSettings) {
      try {
        const legacy = await services.getLegacyPromptEnhancementSettings();
        assertCurrent();
        const migration = migrateLegacyPromptEnhancementSettings(deps.dataPath(manifest.id), legacy);
        if (migration.migrated.length) services.audit?.({ pluginId: manifest.id, api: "plugin.settings.migrate",
          ok: true, keys: migration.migrated, ts: Date.now() });
      } catch (error) {
        assertCurrent();
        services.audit?.({ pluginId: manifest.id, api: "plugin.settings.migrate", ok: false,
          errorCode: (error as { code?: string })?.code ?? "MIGRATION_FAILED", ts: Date.now() });
      }
    }
    assertCurrent();
    const workspaceOnly = manifest.execution?.main === "workspace" && Boolean(services.resolveWorkspaceExecution);
    let child: PluginProcessHandle | undefined;
    let loaded: LoadedPlugin | undefined;
    try {
      if (!workspaceOnly) {
        lifecycle.nativeAttempt();
        child = await deps.spawn({ pluginId: manifest.id, entry: deps.entry, pluginPath, assertCurrent });
      }
      assertCurrent();
      loaded = { manifest, runtimeId: randomUUID(), path: pluginPath, development: deps.development(manifest.id),
        permissions: granted, fsPolicy: access.policy, legacyFs: access.legacy, deletes: [], dropGrants: new Map(),
        child, pending: new Map(), nextCallId: 1, disposing: false };
      deps.loaded.set(manifest.id, loaded);
      const original = loaded;
      const assertLoaded = () => {
        assertCurrent();
        if (original.disposing || deps.loaded.get(manifest.id) !== original) {
          throw pluginLifecycleError("PLUGIN_UNLOADED", "Plugin was unloaded during initialization");
        }
      };
      await deps.initialize(loaded, assertLoaded);
      assertLoaded();
      services.audit?.({ pluginId: manifest.id, api: "plugin.load.success", ok: true, ts: Date.now() });
      return manifest;
    } catch (error) {
      if (loaded) await deps.unload(manifest.id, loaded);
      else if (child) {
        try { child.kill(); }
        catch (cleanupError) { services.audit?.({ pluginId: manifest.id, api: "plugin.cleanup.error", ok: false,
          message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError), ts: Date.now() }); }
      }
      services.audit?.({ pluginId: manifest.id, api: "plugin.load.error", ok: false,
        errorCode: (error as { code?: string }).code ?? "PLUGIN_LOAD_FAILED", ts: Date.now() });
      throw error;
    }
  });
}
