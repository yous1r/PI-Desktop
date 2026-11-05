import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
export async function tomlEntry() {
  const entry = process.env.AI_MEMORY_TOML_ENTRY ? resolve(process.env.AI_MEMORY_TOML_ENTRY) : require.resolve('smol-toml');
  let directory = dirname(entry);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (manifest.name === 'smol-toml') {
        if (manifest.version !== '1.4.2') throw new Error('smol-toml must be pinned to 1.4.2');
        return { entry, declaration: join(directory, 'dist/index.d.ts'), directory };
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    directory = dirname(directory);
  }
  throw new Error('Verified smol-toml 1.4.2 package is required. Provide AI_MEMORY_TOML_ENTRY; no automatic install occurs.');
}
