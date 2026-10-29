import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import { getActiveRemoteHostsBoot } from "../bootstrap/remote-hosts";
import { sshMetadataOf } from "../remote/remote-host-metadata";
import { createSystemSshTransport, reserveLocalPort, type SshTransport } from "../remote/ssh-transport";
import { sshTargetOf } from "../remote/ssh-tunnel";
import { helperTargetFromRemote, resolveBundledHelper } from "./helper-bundle";
import { deployBundledHelper, writeHelperEnvManifest } from "./helper-bootstrap";
import { connectHelper, type HelperClient } from "./helper-client";
import { createHelperFs, registerHelperRoot, type HelperFs } from "./helper-fs";
import { MirrorInitService } from "./mirror-init";
import { createRemoteRunManager, createSshRemoteRunSpawn, type RemoteRunManager } from "./remote-run";
import { SyncExclusionMatcher } from "./sync-exclusions";
import type { MirrorRuntimeOptions } from "./mirror-runtime";
import type { ProjectGroupRecord } from "@pi-desktop/shared";

export type MirrorEnvironmentOptions = {
  getHost: () => HostProcess | null;
  dataDir: string;
  resourcesPath: string;
  desktopVersion: string;
  logger: Pick<Logger, "app">;
};

export type MirrorEnvironmentFactory = {
  getInitService(
    group: ProjectGroupRecord,
    onProgress?: (status: import("@pi-desktop/shared").MirrorInitStatus) => void,
  ): Promise<MirrorInitService>;
  createRuntime(group: ProjectGroupRecord): Promise<{
    sync: MirrorRuntimeOptions;
    runManager: RemoteRunManager;
  }>;
};

type HostRecord = Awaited<ReturnType<NonNullable<ReturnType<typeof getActiveRemoteHostsBoot>>["registry"]["list"]>>[number];
type MirrorBinding = NonNullable<ProjectGroupRecord["mirror"]>;

type RemoteContext = {
  transport: SshTransport;
  hostKey: string;
  remotePath: string;
  ready: Awaited<ReturnType<typeof resolveBundledHelper>> extends never ? never : {
    port: number;
    token: string;
    version: string;
    protocol: number;
  } | null;
  helperFs?: HelperFs;
};

const TRANSFER_BATCH_SIZE = 128;

function fail(code: string, message: string): Error {
  return Object.assign(new Error(message), { errorCode: code });
}

function mirrorBindingOf(group: ProjectGroupRecord): MirrorBinding {
  if (!group.mirror || group.remote) {
    throw fail("INVALID_ARGUMENT", "project group is not a mirror project");
  }
  return group.mirror;
}

function remoteRoot(group: ProjectGroupRecord): string {
  return mirrorBindingOf(group).remotePath;
}

function hostProcess(getHost: MirrorEnvironmentOptions["getHost"]): HostProcess {
  const host = getHost();
  if (!host) throw fail("HOST_SHUTTING_DOWN", "host process unavailable");
  return host;
}

async function pairedHost(hostKey: string): Promise<{ record: HostRecord; transport: SshTransport }> {
  const boot = getActiveRemoteHostsBoot();
  if (!boot) throw fail("REMOTE_CONNECTION_FAILED", "remote host registry unavailable");
  const record = (await boot.registry.list()).find((candidate) => candidate.hostKey === hostKey);
  if (!record) throw fail("REMOTE_CONNECTION_FAILED", "paired SSH host not found");
  const ssh = sshMetadataOf(record);
  if (!ssh) throw fail("REMOTE_CONNECTION_FAILED", "mirror host is not paired over SSH");
  return {
    record,
    transport: createSystemSshTransport(sshTargetOf(ssh, record.sshSecret)),
  };
}

function mirrorContext(group: ProjectGroupRecord, transport: SshTransport): RemoteContext {
  const binding = mirrorBindingOf(group);
  return {
    transport,
    hostKey: binding.hostKey,
    remotePath: binding.remotePath,
    ready: null,
  };
}

function safeLog(logger: MirrorEnvironmentOptions["logger"], message: string, data?: Record<string, unknown>): void {
  try {
    logger.app("diagnostics", "warn", message, { data });
  } catch {
    // Lifecycle cleanup can run while the logger is shutting down.
  }
}

async function helperArtifact(
  context: RemoteContext,
  options: MirrorEnvironmentOptions,
): Promise<Awaited<ReturnType<typeof resolveBundledHelper>>> {
  const result = await context.transport.exec("uname -s; uname -m", { timeoutMs: 15_000 });
  if (result.code !== 0) throw fail("HELPER_DEPLOY_FAILED", "remote platform could not be identified");
  const [system, machine] = result.stdout.split(/\r?\n/).map((line) => line.trim());
  const target = helperTargetFromRemote(system ?? "", machine ?? "");
  if (!target) throw fail("HELPER_DEPLOY_FAILED", "no bundled helper supports this remote platform");
  try {
    return await resolveBundledHelper(target, {
      resourcesPath: options.resourcesPath,
      desktopVersion: options.desktopVersion,
    });
  } catch {
    throw fail("HELPER_DEPLOY_FAILED", "the bundled helper artifact is unavailable or invalid");
  }
}

/**
 * Makes sure the bundled helper runs and returns its port and token.
 *
 * Deploying is idempotent: a running helper of this version is reused as-is, so
 * a resumed initialization that skipped the deploy step still reaches it.
 */
async function ensureHelper(
  context: RemoteContext,
  options: MirrorEnvironmentOptions,
): Promise<NonNullable<RemoteContext["ready"]>> {
  if (context.ready) return context.ready;
  const artifact = await helperArtifact(context, options);
  const ready = await deployBundledHelper({
    transport: context.transport,
    artifact,
    desktopVersion: options.desktopVersion,
  });
  context.ready = ready;
  return ready;
}

async function withHelperClient<T>(
  context: RemoteContext,
  options: MirrorEnvironmentOptions,
  operation: (client: HelperClient) => Promise<T>,
): Promise<T> {
  const ready = await ensureHelper(context, options);
  const localPort = await reserveLocalPort();
  const forward = await context.transport.forward({
    localPort,
    remoteHost: "127.0.0.1",
    remotePort: ready.port,
  });
  let client: HelperClient | null = null;
  try {
    client = await connectHelper({ port: localPort, token: ready.token });
    return await operation(client);
  } finally {
    client?.close();
    await forward.close().catch(() => undefined);
  }
}

/** Enumerates the local source tree without following symlinks or excluded dirs. */
async function localFiles(root: string): Promise<Array<{ relPath: string; size: number; mtimeMs: number }>> {
  const matcher = new SyncExclusionMatcher();
  const files: Array<{ relPath: string; size: number; mtimeMs: number }> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relPath = relative(root, absolute).split(sep).join("/");
      if (entry.isSymbolicLink() || matcher.isExcluded(relPath, entry.isDirectory())) continue;
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        const metadata = await stat(absolute);
        files.push({ relPath, size: metadata.size, mtimeMs: Math.round(metadata.mtimeMs) });
      }
    }
  };
  await visit(root);
  return files;
}

async function storeInitialBaseline(
  group: ProjectGroupRecord,
  context: RemoteContext,
  options: MirrorEnvironmentOptions,
): Promise<{ entries: number }> {
  const files = await localFiles(group.primaryPath);
  const entries: Array<Record<string, unknown>> = [];
  await withHelperClient(context, options, async (client) => {
    const fs = createHelperFs(client, await registerHelperRoot(client, context.remotePath));
    for (let offset = 0; offset < files.length; offset += TRANSFER_BATCH_SIZE) {
      const batch = files.slice(offset, offset + TRANSFER_BATCH_SIZE);
      const stats = await fs.stat(batch.map((file) => file.relPath));
      for (const file of batch) {
        if (file.size > 50 * 1024 * 1024) continue;
        const remote = stats.find((entry) => entry.path === file.relPath);
        if (!remote?.exists || remote.size === undefined || remote.mtimeMs === undefined) continue;
        const digest = await fs.hash(file.relPath);
        entries.push({
          relPath: file.relPath,
          size: remote.size,
          mtimeMs: remote.mtimeMs,
          sha256: digest.sha256,
          syncedAt: Date.now(),
        });
      }
    }
  });
  try {
    await hostProcess(options.getHost).call("mirror.baseline.replace", {
      projectId: group.id,
      entries,
    });
  } catch {
    throw fail("MIRROR_INIT_FAILED", "the mirror baseline could not be stored");
  }
  return { entries: entries.length };
}

export function createMirrorEnvironment(options: MirrorEnvironmentOptions): MirrorEnvironmentFactory {
  const createInitService = async (
    group: ProjectGroupRecord,
    onProgress?: (status: import("@pi-desktop/shared").MirrorInitStatus) => void,
  ): Promise<MirrorInitService> => {
    const binding = mirrorBindingOf(group);
    const { transport } = await pairedHost(binding.hostKey);
    const context = mirrorContext(group, transport);
    const service = new MirrorInitService({
      host: hostProcess(options.getHost),
      client: async () => {
        await ensureHelper(context, options);
        return openClientForService(context);
      },
      logger: {
        warn: (message, data) => safeLog(options.logger, message, data),
      },
      transport,
      desktopVersion: options.desktopVersion,
      helperArtifact: async () => helperArtifact(context, options),
      mirrorRoot: binding.remotePath,
      onHelperReady: (ready) => {
        context.ready = ready;
      },
      onClose: () => transport.dispose(),
      // No language is selected in project creation yet, so initialization
      // records the sync-only environment. Remote debugging remains unavailable
      // until a pinned adapter payload is bundled and selected.
      adapterManifest: [],
      forwardSelfTest: async () => {
        await withHelperClient(context, options, async (client) => {
          await client.request("health", {});
        });
      },
      // `env.json` describes the host, so it is written into the helper
      // directory over SSH; file operations only ever address the mirror root.
      writeEnvManifest: async () => {
        const ready = await ensureHelper(context, options);
        const health = await withHelperClient(context, options, (client) => client.request("health", {}));
        const helperRoot = health.root;
        if (typeof helperRoot !== "string" || !helperRoot.startsWith("/")) {
          throw fail("MIRROR_INIT_FAILED", "the helper did not report its directory");
        }
        return await writeHelperEnvManifest(transport, {
          schemaVersion: 1,
          helperRoot,
          helperVersion: ready.version,
          protocol: 1,
          desktopVersion: options.desktopVersion,
          adapters: [],
        });
      },
      storeBaseline: async () => storeInitialBaseline(group, context, options),
      onProgress,
    });
    return service;
  };

  return {
    getInitService: createInitService,
    async createRuntime(group) {
      const binding = mirrorBindingOf(group);
      const { record, transport } = await pairedHost(binding.hostKey);
      const context = mirrorContext(group, transport);
      let helperClient: HelperClient | null = null;
      let forward: Awaited<ReturnType<SshTransport["forward"]>> | null = null;
      try {
        const ready = await ensureHelper(context, options);
        const localPort = await reserveLocalPort();
        forward = await transport.forward({
          localPort,
          remoteHost: "127.0.0.1",
          remotePort: ready.port,
        });
        helperClient = await connectHelper({ port: localPort, token: ready.token });
        // Registration is idempotent, so every connection names its canonical root.
        const helperFs = createHelperFs(helperClient, await registerHelperRoot(helperClient, binding.remotePath));
        const currentHost = hostProcess(options.getHost);
        const metadata = sshMetadataOf(record);
        if (!metadata) throw fail("REMOTE_CONNECTION_FAILED", "paired SSH metadata is unavailable");
        const runSpawn = await createSshRemoteRunSpawn(sshTargetOf(metadata, record.sshSecret));
        const runManager = createRemoteRunManager({ spawn: runSpawn });
        const managedRunManager: RemoteRunManager = {
          start: (request) => runManager.start(request),
          dispose: async () => {
            try {
              await runManager.dispose();
            } finally {
              helperClient?.close();
              await forward?.close().catch(() => undefined);
              transport.dispose();
              helperClient = null;
              forward = null;
            }
          },
        };
        return {
          sync: {
            localRoot: group.primaryPath,
            helperFs,
            host: currentHost,
            mode: binding.mode,
            startWatching: false,
          },
          runManager: managedRunManager,
        };
      } catch (error) {
        helperClient?.close();
        await forward?.close().catch(() => undefined);
        transport.dispose();
        throw error;
      }
    },
  };
}


/** HelperClient whose close also closes the associated forward. */
async function openClientForService(context: RemoteContext): Promise<HelperClient> {
  const ready = context.ready;
  if (!ready) throw fail("HELPER_START_FAILED", "remote helper has not completed its handshake");
  const localPort = await reserveLocalPort();
  const forward = await context.transport.forward({
    localPort,
    remoteHost: "127.0.0.1",
    remotePort: ready.port,
  });
  let client: HelperClient;
  try {
    client = await connectHelper({ port: localPort, token: ready.token });
  } catch (error) {
    await forward.close().catch(() => undefined);
    throw error;
  }
  let closed = false;
  return {
    request: (...args) => client.request(...args),
    beginStream: (input) => client.beginStream(input),
    writeStreamData: (streamId, bytes) => client.writeStreamData(streamId, bytes),
    writeStreamEnd: (streamId) => client.writeStreamEnd(streamId),
    closeStream: (streamId) => client.closeStream(streamId),
    abandonStream: (streamId, reason) => client.abandonStream(streamId, reason),
    close: () => {
      if (closed) return;
      closed = true;
      client.close();
      void forward.close().catch(() => undefined);
    },
  };
}
