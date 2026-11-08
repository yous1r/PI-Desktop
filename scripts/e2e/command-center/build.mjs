import { createRequire } from 'node:module';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { createHash } from 'node:crypto';

/** Bundle this checkout's workspace sources, never another worktree's dist. */
export async function buildCandidate(root, directory) {
  const require = createRequire(join(root, 'packages/agent-runtime/package.json'));
  const { build } = require('esbuild');
  const plugin = {
    name: 'candidate-workspace-sources',
    setup(builder) {
      if (process.env.PI_COMMAND_CENTER_DEPENDENCIES) {
        builder.onResolve({ filter: /^@earendil-works\/pi-(ai|agent-core|coding-agent)(\/|$)/ }, async (args) => {
          if (args.pluginData?.baselineResolved) return;
          return builder.resolve(args.path, { kind: args.kind, resolveDir: resolve(process.env.PI_COMMAND_CENTER_DEPENDENCIES),
            pluginData: { baselineResolved: true } });
        });
      }
      builder.onResolve({ filter: /^@pi-desktop\// }, async ({ path: specifier }) => {
        const [, name, ...subpath] = specifier.split('/');
        const packageRoot = join(root, 'packages', name);
        const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
        const entry = pkg.exports?.[subpath.length ? './' + subpath.join('/') : '.'];
        const target = typeof entry === 'string' ? entry : entry?.import ?? entry?.default;
        if (!target?.startsWith('./dist/') || !target.endsWith('.js')) throw new Error(`No candidate source mapping: ${specifier}`);
        return { path: resolve(packageRoot, target.replace('./dist/', './src/').replace(/\.js$/, '.ts')) };
      });
    },
  };
  const common = { absWorkingDir: root, bundle: true, platform: 'node', format: 'esm', plugins: [plugin], metafile: true,
    define: { PI_BUNDLED_NODE: 'true' },
    banner: { js: "import {createRequire as __p0Require} from 'node:module'; const require=__p0Require(import.meta.url);" },
    logLevel: 'warning' };
  const workerEntry = join(directory, 'worker.mjs');
  const sidecarEntry = join(directory, 'sidecar.mjs');
  const worker = await build({ ...common, entryPoints: [join(root, 'scripts/e2e/command-center/worker.mjs')], outfile: workerEntry });
  const sidecar = await build({ ...common, entryPoints: [join(root, 'packages/agent-runtime/src/sidecar.ts')], outfile: sidecarEntry });
  const harness = (await readdir(join(root, 'scripts/e2e/command-center')))
    .filter(name => /\.(mjs|ps1)$/.test(name)).map(name => `scripts/e2e/command-center/${name}`);
  const inputs = [...new Set([...Object.keys(worker.metafile.inputs), ...Object.keys(sidecar.metafile.inputs),
    ...harness, 'scripts/e2e-command-center-baseline.mjs', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'Cargo.lock'])].sort();
  const records = [];
  for (const input of inputs) {
    const absolute = resolve(root, input);
    records.push({ path: relative(root, absolute).replaceAll('\\', '/'), sha256: createHash('sha256').update(await readFile(absolute)).digest('hex') });
  }
  await writeFile(join(directory, 'build-inputs.json'), JSON.stringify(records, null, 2) + '\n');
  return { workerEntry, sidecarEntry, inputsSha256: createHash('sha256').update(JSON.stringify(records)).digest('hex') };
}
