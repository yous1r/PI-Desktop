import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

/** Bundle the current checkout with the provisioned dependency environment. */
export async function buildSidecarHandoff(root, directory) {
  const { build } = createRequire(join(root, 'packages/agent-runtime/package.json'))('esbuild');
  const plugin = { name: 'handoff-candidate-sources', setup(builder) {
    if (process.env.PI_COMMAND_CENTER_DEPENDENCIES) {
      builder.onResolve({ filter: /^@earendil-works\/pi-(ai|agent-core|coding-agent)(\/|$)/ }, args => {
        if (args.pluginData?.handoffResolved) return;
        return builder.resolve(args.path, { kind: args.kind, resolveDir: resolve(process.env.PI_COMMAND_CENTER_DEPENDENCIES),
          pluginData: { handoffResolved: true } });
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
  } };
  const common = { absWorkingDir: root, bundle: true, platform: 'node', format: 'esm', plugins: [plugin], metafile: true,
    define: { PI_BUNDLED_NODE: 'true' }, banner: { js: "import {createRequire as __handoffCreateRequire} from 'node:module'; const require=__handoffCreateRequire(import.meta.url);" }, logLevel: 'warning' };
  const sidecar = await build({ ...common, entryPoints: [join(root, 'packages/agent-runtime/src/sidecar.ts')], outfile: join(directory, 'sidecar.mjs') });
  const coordinator = await build({ ...common, entryPoints: ['host-process', 'agent-sidecar', 'sidecar-handoff-client'].map(name => join(root, `packages/host-runtime/src/${name}.ts`)),
    outdir: directory, outExtension: { '.js': '.mjs' } });
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const records = [];
  for (const input of [...new Set([...Object.keys(sidecar.metafile.inputs), ...Object.keys(coordinator.metafile.inputs)])].sort()) {
    records.push({ path: input.replaceAll('\\', '/'), sha256: hash(await readFile(resolve(root, input))) });
  }
  await writeFile(join(directory, 'build-inputs.json'), JSON.stringify(records, null, 2) + '\n');
  return { inputs: records.length, inputsSha256: hash(JSON.stringify(records)), sidecarSha256: hash(await readFile(join(directory, 'sidecar.mjs'))) };
}
