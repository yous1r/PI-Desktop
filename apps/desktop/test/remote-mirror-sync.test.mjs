import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_EXCLUSIONS,
  SyncExclusionMatcher,
  normalizeRelPath,
  parseIgnorePatterns,
} from '../electron/main/mirror/sync-exclusions.ts';
import { PathCoalescingQueue } from '../electron/main/mirror/sync-queue.ts';
import { SyncEngine } from '../electron/main/mirror/sync-engine.ts';
import { MAX_TRANSFER_BYTES } from '../electron/main/mirror/helper-client.ts';

// ── 1. Pure matcher: sync-exclusions.ts (no I/O) ─────────────────────────────

test('exclusions: default set carries every spec 23 group', () => {
  const expected = [
    '.venv', 'venv', '__pycache__', '*.pyc', '.mypy_cache', '.pytest_cache',
    '.ruff_cache', '.tox', '*.egg-info', 'node_modules', 'dist', 'build',
    '.next', '.nuxt', '.turbo', '.cache', 'coverage', 'target', '.gradle',
    '.git', '.DS_Store', '*.log', 'tmp', 'temp',
  ];
  for (const pattern of expected) {
    assert.ok(DEFAULT_EXCLUSIONS.includes(pattern), `missing default ${pattern}`);
  }
});

test('exclusions: matches default directory and wildcard patterns at any depth', () => {
  const matcher = new SyncExclusionMatcher();

  assert.equal(matcher.isExcluded('.venv/lib/python3.10/site.py'), true);
  assert.equal(matcher.isExcluded('backend/venv/bin/activate'), true);
  assert.equal(matcher.isExcluded('src/__pycache__/module.pyc'), true);
  assert.equal(matcher.isExcluded('app/main.pyc'), true);
  assert.equal(matcher.isExcluded('.mypy_cache/3.10/ast.json'), true);
  assert.equal(matcher.isExcluded('.pytest_cache/v/cache/lastfailed'), true);
  assert.equal(matcher.isExcluded('pkg.egg-info/PKG-INFO'), true);
  assert.equal(matcher.isExcluded('sub/pkg.egg-info/PKG-INFO'), true);

  assert.equal(matcher.isExcluded('node_modules/react/index.js'), true);
  assert.equal(matcher.isExcluded('packages/app/node_modules/lodash/index.js'), true);
  assert.equal(matcher.isExcluded('dist/bundle.js'), true);
  assert.equal(matcher.isExcluded('build/main.js'), true);
  assert.equal(matcher.isExcluded('.next/static/chunks/main.js'), true);
  assert.equal(matcher.isExcluded('.turbo/turbo-build.log'), true);
  assert.equal(matcher.isExcluded('coverage/lcov.info'), true);

  assert.equal(matcher.isExcluded('target/debug/app'), true);
  assert.equal(matcher.isExcluded('crates/sub/target/release/lib.rlib'), true);
  assert.equal(matcher.isExcluded('.gradle/caches/modules-2.lock'), true);
  assert.equal(matcher.isExcluded('.git/config'), true);
  assert.equal(matcher.isExcluded('sub/.git/HEAD'), true);
  assert.equal(matcher.isExcluded('.DS_Store'), true);
  assert.equal(matcher.isExcluded('deep/folder/.DS_Store'), true);
  assert.equal(matcher.isExcluded('error.log'), true);
  assert.equal(matcher.isExcluded('logs/debug.log'), true);
  assert.equal(matcher.isExcluded('tmp/scratch.txt'), true);
  assert.equal(matcher.isExcluded('temp/buffer.bin'), true);

  assert.equal(matcher.isExcluded('src/index.ts'), false);
  assert.equal(matcher.isExcluded('README.md'), false);
  assert.equal(matcher.isExcluded('package.json'), false);
  assert.equal(matcher.isExcluded('crates/host-core/src/lib.rs'), false);
  assert.equal(matcher.isExcluded('vendor/golang.org/x/net.go'), false);
});

test('exclusions: per-project include exceptions override defaults', () => {
  const matcher = new SyncExclusionMatcher({ includeExceptions: ['build', 'bin/**'] });

  assert.equal(matcher.isExcluded('build/main.js'), false);
  assert.equal(matcher.isExcluded('build/assets/style.css'), false);
  assert.equal(matcher.isExcluded('bin/run.sh'), false);

  assert.equal(matcher.isExcluded('node_modules/foo/index.js'), true);
  assert.equal(matcher.isExcluded('target/debug/app'), true);
  assert.equal(matcher.isExcluded('app.log'), true);
});

test('exclusions: .pi-desktopignore parsing supports negation', () => {
  const content = [
    '# comment line',
    '*.secret',
    'custom_cache/',
    '!safe.secret',
  ].join('\n');

  assert.deepEqual(parseIgnorePatterns(content), ['*.secret', 'custom_cache/', '!safe.secret']);

  const matcher = new SyncExclusionMatcher({ customPatterns: content });
  assert.equal(matcher.isExcluded('key.secret'), true);
  assert.equal(matcher.isExcluded('sub/key.secret'), true);
  assert.equal(matcher.isExcluded('custom_cache/file.bin'), true);
  assert.equal(matcher.isExcluded('safe.secret'), false);
});

test('exclusions: disabled default exclusions are individually switchable', () => {
  const matcher = new SyncExclusionMatcher({ disabledDefaultExclusions: ['build', '.next'] });

  assert.equal(matcher.isExcluded('build/app.js'), false);
  assert.equal(matcher.isExcluded('.next/server/pages.js'), false);

  assert.equal(matcher.isExcluded('dist/main.js'), true);
  assert.equal(matcher.isExcluded('node_modules/pkg/index.js'), true);
});

test('exclusions: normalizes Windows separators before matching', () => {
  const matcher = new SyncExclusionMatcher();
  const windowsNodeModules = String.raw`node_modules\react\index.js`;
  const windowsSource = String.raw`src\main\app.ts`;

  assert.equal(matcher.isExcluded(windowsNodeModules), true);
  assert.equal(matcher.isExcluded(windowsSource), false);
  assert.equal(normalizeRelPath('/a/b/c/'), 'a/b/c');
  assert.equal(normalizeRelPath(String.raw`a\b\c`), 'a/b/c');
});

// ── 2. Pure coalescing queue: sync-queue.ts (no I/O) ────────────────────────

test('queue: enqueue, peek, drain and clear hold no I/O', () => {
  const queue = new PathCoalescingQueue();

  assert.equal(queue.size, 0);
  assert.equal(queue.isPending, false);

  queue.enqueueCreate('src/app.ts');
  assert.equal(queue.size, 1);
  assert.equal(queue.isPending, true);
  assert.equal(queue.has('src/app.ts'), true);

  const entry = queue.get('src/app.ts');
  assert.ok(entry);
  assert.equal(entry.path, 'src/app.ts');
  assert.equal(entry.type, 'create');

  assert.equal(queue.peek().length, 1);
  assert.equal(queue.size, 1);

  const drained = queue.drain();
  assert.equal(drained.length, 1);
  assert.equal(queue.size, 0);
  assert.equal(queue.isPending, false);

  queue.dispose();
});

test('queue: create followed by modify bursts stays create', () => {
  const queue = new PathCoalescingQueue();
  queue.enqueue('src/foo.ts', 'create');
  queue.enqueue('src/foo.ts', 'modify');
  queue.enqueue('src/foo.ts', 'modify');

  const drained = queue.drain();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].path, 'src/foo.ts');
  assert.equal(drained[0].type, 'create');
  queue.dispose();
});

test('queue: modify bursts collapse to one modify', () => {
  const queue = new PathCoalescingQueue();
  queue.enqueue('src/bar.ts', 'modify');
  queue.enqueue('src/bar.ts', 'modify');

  const drained = queue.drain();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].type, 'modify');
  queue.dispose();
});

test('queue: create then delete inside the window cancels the path', () => {
  const queue = new PathCoalescingQueue();
  queue.enqueue('temp.txt', 'create');
  assert.equal(queue.size, 1);

  queue.enqueue('temp.txt', 'delete');
  assert.equal(queue.size, 0);
  assert.equal(queue.drain().length, 0);
  queue.dispose();
});

test('queue: modify then delete becomes delete', () => {
  const queue = new PathCoalescingQueue();
  queue.enqueue('existing.ts', 'modify');
  queue.enqueue('existing.ts', 'delete');

  const drained = queue.drain();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].type, 'delete');
  queue.dispose();
});

test('queue: delete then recreate becomes modify', () => {
  const queue = new PathCoalescingQueue();
  queue.enqueue('recreated.ts', 'delete');
  queue.enqueue('recreated.ts', 'create');

  const drained = queue.drain();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].type, 'modify');
  queue.dispose();
});

test('queue: rename splits into delete of the old path and create of the new', () => {
  const queue = new PathCoalescingQueue();
  queue.enqueueRename('old-name.ts', 'new-name.ts');

  const drained = queue.drain();
  assert.equal(drained.length, 2);

  const oldEntry = drained.find((entry) => entry.path === 'old-name.ts');
  const newEntry = drained.find((entry) => entry.path === 'new-name.ts');
  assert.ok(oldEntry);
  assert.equal(oldEntry.type, 'delete');
  assert.ok(newEntry);
  assert.equal(newEntry.type, 'create');
  queue.dispose();
});

test('queue: renaming a freshly created path drops the old path', () => {
  const queue = new PathCoalescingQueue();
  queue.enqueueCreate('draft.txt');
  queue.enqueueRename('draft.txt', 'final.txt');

  const drained = queue.drain();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].path, 'final.txt');
  assert.equal(drained[0].type, 'create');
  queue.dispose();
});

test('queue: debounce window flushes the coalesced set through onFlush', () => {
  let virtualTime = 1000;
  let timerCallback = null;
  let timerArmed = false;

  const mockClock = {
    setTimeout: (callback) => {
      timerCallback = callback;
      timerArmed = true;
      return 42;
    },
    clearTimeout: () => {
      timerCallback = null;
      timerArmed = false;
    },
    now: () => virtualTime,
  };

  const flushed = [];
  const queue = new PathCoalescingQueue({
    debounceMs: 300,
    clock: mockClock,
    onFlush: (entries) => {
      flushed.push(entries);
    },
  });

  queue.enqueueCreate('file1.ts');
  assert.equal(timerArmed, true);
  assert.equal(flushed.length, 0);

  virtualTime += 100;
  queue.enqueueModify('file1.ts');
  virtualTime += 100;
  queue.enqueueCreate('file2.ts');

  assert.ok(timerCallback);
  timerCallback();

  assert.equal(flushed.length, 1);
  const batch = flushed[0];
  assert.equal(batch.length, 2);
  assert.equal(batch.find((entry) => entry.path === 'file1.ts').type, 'create');
  assert.equal(batch.find((entry) => entry.path === 'file2.ts').type, 'create');
  assert.equal(queue.size, 0);
  queue.dispose();
});

// ── 3. Sync service: sync-engine.ts ─────────────────────────────────────────

function createHarness(initialBaseline = []) {
  const hostCalls = [];
  const baselineStore = new Map(initialBaseline.map((row) => [row.relPath, { ...row }]));

  const host = {
    call: async (method, params = {}) => {
      hostCalls.push({ method, params });
      if (method === 'mirror.baseline.list') {
        return { entries: Array.from(baselineStore.values()) };
      }
      if (method === 'mirror.baseline.entry.upsert') {
        baselineStore.set(params.entry.relPath, { ...params.entry });
        return { entry: params.entry };
      }
      if (method === 'mirror.baseline.entry.delete') {
        return { removed: baselineStore.delete(params.relPath) };
      }
      return {};
    },
  };

  const remoteFiles = new Map();

  const helperFs = {
    stat: async (paths) => {
      const list = typeof paths === 'string' ? [paths] : paths;
      return list.map((relPath) => {
        const file = remoteFiles.get(relPath);
        if (!file) return { path: relPath, exists: false };
        return { path: relPath, exists: true, size: file.size, mtimeMs: file.mtimeMs };
      });
    },
    putFile: async (remotePath, source) => {
      const stats = fs.statSync(source);
      const sha256 = 'd'.repeat(64);
      remoteFiles.set(remotePath, { size: stats.size, mtimeMs: 1_700_000_500_000 });
      return { path: remotePath, size: stats.size, sha256, result: {} };
    },
    getFile: async () => {
      throw new Error('getFile is not exercised by these tests');
    },
    mkdirs: async (paths) => (typeof paths === 'string' ? [paths] : paths),
    hash: async (relPath) => ({ path: relPath, sha256: 'd'.repeat(64) }),
  };

  return { host, hostCalls, baselineStore, helperFs, remoteFiles };
}

test('engine: uploads a file and upserts the baseline row with size, mtimeMs and sha256', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-sync-test-'));
  try {
    const localFile = path.join(tmpDir, 'src', 'app.ts');
    fs.mkdirSync(path.dirname(localFile), { recursive: true });
    fs.writeFileSync(localFile, 'console.log(1);', 'utf8');

    const harness = createHarness();
    const engine = new SyncEngine({
      projectId: 'project-1',
      localRoot: tmpDir,
      helperFs: harness.helperFs,
      host: harness.host,
      mode: 'manual',
    });

    engine.queue.enqueueCreate('src/app.ts');
    const result = await engine.sync();

    assert.deepEqual(result.uploaded, ['src/app.ts']);
    assert.equal(result.conflicts.length, 0);
    assert.equal(result.drifts.length, 0);

    const stored = harness.baselineStore.get('src/app.ts');
    assert.ok(stored);
    assert.equal(stored.size, fs.statSync(localFile).size);
    assert.equal(stored.mtimeMs, 1_700_000_500_000);
    assert.equal(stored.sha256, 'd'.repeat(64));

    const upsert = harness.hostCalls.find((call) => call.method === 'mirror.baseline.entry.upsert');
    assert.ok(upsert);
    assert.equal(upsert.params.projectId, 'project-1');

    engine.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('engine: a remote change since the baseline records MIRROR_CONFLICT and does not overwrite', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-conflict-test-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'data.txt'), 'local content v2', 'utf8');

    const baselineMtime = 1_700_000_000_000;
    const harness = createHarness([
      {
        relPath: 'data.txt',
        size: 10,
        mtimeMs: baselineMtime,
        sha256: 'a'.repeat(64),
        syncedAt: baselineMtime,
      },
    ]);
    harness.remoteFiles.set('data.txt', { size: 50, mtimeMs: baselineMtime + 5000 });

    const conflicts = [];
    const engine = new SyncEngine({
      projectId: 'project-1',
      localRoot: tmpDir,
      helperFs: harness.helperFs,
      host: harness.host,
      mode: 'manual',
      onConflict: (conflict) => conflicts.push(conflict),
    });
    await engine.loadBaseline();

    engine.queue.enqueueModify('data.txt');
    const result = await engine.sync();

    assert.equal(result.uploaded.length, 0);
    assert.equal(result.conflicts.length, 1);
    assert.equal(conflicts.length, 1);

    const conflict = conflicts[0];
    assert.equal(conflict.code, 'MIRROR_CONFLICT');
    assert.equal(conflict.relPath, 'data.txt');
    assert.equal(conflict.remote.size, 50);
    assert.equal(conflict.remote.mtimeMs, baselineMtime + 5000);
    assert.equal(conflict.baseline.mtimeMs, baselineMtime);
    assert.ok(conflict.local.size > 0);

    assert.equal(harness.remoteFiles.get('data.txt').size, 50);
    assert.equal(harness.hostCalls.some((call) => call.method === 'mirror.baseline.entry.upsert'), false);

    engine.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('engine: a remote file with no baseline row is a conflict, not an overwrite', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-nobaseline-test-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'untracked.txt'), 'local text', 'utf8');

    const harness = createHarness();
    harness.remoteFiles.set('untracked.txt', { size: 100, mtimeMs: 1_700_000_100_000 });

    const engine = new SyncEngine({
      projectId: 'project-1',
      localRoot: tmpDir,
      helperFs: harness.helperFs,
      host: harness.host,
      mode: 'manual',
    });

    engine.queue.enqueueCreate('untracked.txt');
    const result = await engine.sync();

    assert.equal(result.uploaded.length, 0);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].code, 'MIRROR_CONFLICT');
    assert.equal(result.conflicts[0].baseline, undefined);
    assert.equal(harness.remoteFiles.get('untracked.txt').size, 100);

    engine.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('engine: an over-limit file is skipped and reported without failing the batch', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-limit-test-'));
  const originalStat = fs.promises.stat;
  try {
    fs.writeFileSync(path.join(tmpDir, 'normal.txt'), 'normal content', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'huge.bin'), 'placeholder', 'utf8');

    fs.promises.stat = async (target, options) => {
      if (String(target).includes('huge.bin')) {
        return {
          isFile: () => true,
          isDirectory: () => false,
          size: MAX_TRANSFER_BYTES + 1024,
          mtimeMs: 1_700_000_000_000,
        };
      }
      return originalStat(target, options);
    };

    const overLimits = [];
    const harness = createHarness();
    const engine = new SyncEngine({
      projectId: 'project-1',
      localRoot: tmpDir,
      helperFs: harness.helperFs,
      host: harness.host,
      mode: 'manual',
      onOverLimit: (entry) => overLimits.push(entry),
    });

    engine.queue.enqueueCreate('huge.bin');
    engine.queue.enqueueCreate('normal.txt');
    const result = await engine.sync();

    assert.deepEqual(result.uploaded, ['normal.txt']);
    assert.equal(result.overLimit.length, 1);
    assert.equal(result.overLimit[0].relPath, 'huge.bin');
    assert.equal(result.overLimit[0].limit, MAX_TRANSFER_BYTES);
    assert.equal(overLimits.length, 1);

    engine.dispose();
  } finally {
    fs.promises.stat = originalStat;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('engine: a failed transfer is marked uncertain and never retried automatically', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-fail-test-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'fail.txt'), 'content', 'utf8');

    const harness = createHarness();
    let attempts = 0;
    harness.helperFs.putFile = async () => {
      attempts += 1;
      throw Object.assign(new Error('connection reset'), { errorCode: 'REMOTE_TRANSFER_FAILED' });
    };

    const failures = [];
    const engine = new SyncEngine({
      projectId: 'project-1',
      localRoot: tmpDir,
      helperFs: harness.helperFs,
      host: harness.host,
      mode: 'manual',
      onTransferFailure: (failure) => failures.push(failure),
    });

    engine.queue.enqueueCreate('fail.txt');
    const result = await engine.sync();

    assert.equal(result.uploaded.length, 0);
    assert.equal(result.failures.length, 1);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].relPath, 'fail.txt');
    assert.equal(failures[0].uncertain, true);
    assert.equal(failures[0].code, 'REMOTE_TRANSFER_FAILED');
    assert.equal(attempts, 1, 'a failed transfer must not be retried');
    assert.equal(engine.activeFailures.length, 1);

    engine.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('engine: a local delete reports drift and never deletes the remote file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-drift-test-'));
  try {
    const harness = createHarness([
      {
        relPath: 'deleted.txt',
        size: 20,
        mtimeMs: 1_700_000_000_000,
        sha256: 'b'.repeat(64),
        syncedAt: 1_700_000_000_000,
      },
    ]);
    harness.remoteFiles.set('deleted.txt', { size: 20, mtimeMs: 1_700_000_000_000 });

    const drifts = [];
    const engine = new SyncEngine({
      projectId: 'project-1',
      localRoot: tmpDir,
      helperFs: harness.helperFs,
      host: harness.host,
      mode: 'manual',
      onDrift: (drift) => drifts.push(drift),
    });
    await engine.loadBaseline();

    engine.queue.enqueueDelete('deleted.txt');
    const result = await engine.sync();

    assert.equal(result.drifts.length, 1);
    assert.equal(drifts.length, 1);
    assert.equal(drifts[0].relPath, 'deleted.txt');
    assert.equal(drifts[0].kind, 'local_deleted');

    assert.equal(harness.remoteFiles.has('deleted.txt'), true);
    assert.equal(harness.baselineStore.has('deleted.txt'), false);
    assert.equal(engine.getBaseline('deleted.txt'), undefined);

    engine.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('engine: dispose stops watchers, clears the queue and is idempotent', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-dispose-test-'));
  try {
    const harness = createHarness();
    const engine = new SyncEngine({
      projectId: 'project-1',
      localRoot: tmpDir,
      helperFs: harness.helperFs,
      host: harness.host,
      mode: 'auto',
    });

    engine.startWatching();
    engine.queue.enqueueCreate('a.txt');
    assert.equal(engine.queue.size, 1);

    engine.dispose();
    assert.equal(engine.queue.size, 0);
    assert.doesNotThrow(() => engine.dispose());

    engine.queue.enqueueCreate('after-dispose.txt');
    assert.equal(engine.queue.size, 0, 'a disposed queue accepts no further work');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// The real helper replaces a file only inside an existing directory, and a new
// mirror has none of the project's directories. This fake enforces that rule,
// which the permissive harness above does not.
test('engine: creates missing remote parents once per batch before uploading', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-sync-test-'));
  try {
    for (const relPath of ['src/a.ts', 'src/b.ts', 'tools/deep/c.sh', 'top.txt', 'later/d.ts']) {
      const localFile = path.join(tmpDir, ...relPath.split('/'));
      fs.mkdirSync(path.dirname(localFile), { recursive: true });
      fs.writeFileSync(localFile, relPath, 'utf8');
    }

    const harness = createHarness();
    const directories = new Set();
    const mkdirCalls = [];
    harness.helperFs.mkdirs = async (paths) => {
      const list = typeof paths === 'string' ? [paths] : paths;
      mkdirCalls.push(...list);
      for (const directory of list) {
        let current = directory;
        while (current !== '.') {
          directories.add(current);
          current = path.posix.dirname(current);
        }
      }
      return list;
    };
    const permissivePut = harness.helperFs.putFile;
    harness.helperFs.putFile = async (remotePath, source) => {
      const parent = path.posix.dirname(remotePath);
      if (parent !== '.' && !directories.has(parent)) {
        throw Object.assign(new Error('parent directory is missing'), { errorCode: 'REMOTE_PATH_NOT_FOUND' });
      }
      return permissivePut(remotePath, source);
    };

    const engine = new SyncEngine({
      projectId: 'project-1',
      localRoot: tmpDir,
      helperFs: harness.helperFs,
      host: harness.host,
      mode: 'manual',
    });
    for (const relPath of ['src/a.ts', 'src/b.ts', 'tools/deep/c.sh', 'top.txt']) {
      engine.queue.enqueueCreate(relPath);
    }
    const first = await engine.sync();
    assert.deepEqual([...first.uploaded].sort(), ['src/a.ts', 'src/b.ts', 'tools/deep/c.sh', 'top.txt']);
    assert.deepEqual(first.failures, []);
    // One request per new directory; `tools/deep` also creates `tools`.
    assert.deepEqual([...mkdirCalls].sort(), ['src', 'tools/deep']);

    // A later batch asks again, so a directory removed on the host is recreated.
    directories.clear();
    engine.queue.enqueueCreate('later/d.ts');
    const second = await engine.sync();
    assert.deepEqual(second.uploaded, ['later/d.ts']);
    assert.deepEqual(second.failures, []);
    assert.equal(mkdirCalls.at(-1), 'later');
    engine.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
