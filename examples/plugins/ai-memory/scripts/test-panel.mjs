import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const executable = process.argv[2] || process.env.AI_MEMORY_TEST_ELECTRON || require('electron');
const entry = fileURLToPath(new URL('../tests/e2e/panel.cjs', import.meta.url));
for (const locale of ['zh-CN', 'en']) {
  const profile = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), 'ai-memory-panel-'));
  const env = { ...process.env, AI_MEMORY_PANEL_PROFILE: profile, AI_MEMORY_PANEL_LOCALE: locale };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(executable, [entry], { env, stdio: 'inherit', windowsHide: true, timeout: 30000 });
      child.once('error', reject);
      child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`Panel ${locale} failed: ${code ?? signal}`)));
    });
  } finally {
    // Process exit releases Chromium's Windows profile locks. Retry transient file indexing locks.
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await assert.rejects(access(profile), { code: 'ENOENT' });
  }
  console.log(`PASS: ${locale} Electron exited and isolated profile cleanup completed`);
}
