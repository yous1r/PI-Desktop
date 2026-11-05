import { build } from 'esbuild';
import { readdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { tomlEntry } from './dependencies.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), 'amt-'));
try {
  const toml = await tomlEntry();
  const tests = (await readdir(join(root, 'tests'), { recursive: true })).filter(file => file.endsWith('.test.ts') && (!process.argv[2] || file.replaceAll('\\', '/').includes(process.argv[2]))).map(file => join(root, 'tests', file));
  const files = [];
  for (let i = 0; i < tests.length; i++) {
    const outfile = join(output, `${i}.test.mjs`); files.push(outfile);
    await build({ entryPoints: [tests[i]], outfile, bundle: true, sourcemap: 'inline', format: 'esm', platform: 'node', target: 'node22', alias: { 'smol-toml': toml.entry }, logLevel: 'warning' });
  }
  const result = spawnSync(process.execPath, ['--enable-source-maps', '--test', '--test-concurrency=1', ...files], { stdio: 'inherit', cwd: root, env: { ...process.env, AI_MEMORY_TEST_ROOT: root, AI_MEMORY_TEST_SCRATCH: output } });
  process.exitCode = result.status ?? 1;
} finally { await rm(output, { recursive: true, force: true }); }
