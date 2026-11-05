import { build } from 'esbuild';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tomlEntry } from './dependencies.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist');
const toml = await tomlEntry();
await mkdir(join(output, 'ui'), { recursive: true });
const common = { bundle: true, target: 'node22', platform: 'node', logLevel: 'warning', alias: { 'smol-toml': toml.entry } };
await Promise.all([
  build({ ...common, entryPoints: [join(root, 'src/main.ts')], outfile: join(output, 'main.cjs'), format: 'cjs' }),
  build({ ...common, entryPoints: [join(root, 'src/extension.ts')], outfile: join(output, 'agent-extension.js'), format: 'esm' }),
  build({ bundle: true, target: 'es2022', platform: 'browser', entryPoints: [join(root, 'src/ui/panel.ts')], outfile: join(output, 'ui/panel.js'), format: 'esm', logLevel: 'warning' }),
]);
await Promise.all(['manifest.json', 'README.md', 'CHANGELOG.md', 'docs', 'skills', 'compatibility'].map(path => cp(join(root, path), join(output, path), { recursive: true })));
await cp(join(root, 'tests/fixtures/upstream'), join(output, 'tests/fixtures/upstream'), { recursive: true });
await cp(join(root, 'src/ui/index.html'), join(output, 'ui/index.html'));
await cp(join(output, 'agent-extension.js'), join(output, 'agent-extension.mjs'));
await cp(join(toml.directory, 'LICENSE'), join(output, 'SMOL-TOML-LICENSE'));
await writeFile(join(output, 'package.json'), JSON.stringify({ name: '@local/ai-memory-plugin-bundle', private: true, type: 'module', version: '0.1.0' }, null, 2));
console.log(`Bundle ready: ${output}`);
