import assert from 'node:assert/strict';
import test from 'node:test';
import { contextText, promptText } from './context.mjs';
import { startProvider, expectedText } from './provider.mjs';

for (const kind of ['ascii', 'utf8']) {
  test(`1 MiB ${kind} context reaches provider without truncation`, async () => {
    const bytes = 1048576;
    assert.equal(Buffer.byteLength(contextText(bytes, kind)), bytes);
    assert.equal(contextText(bytes, kind).isWellFormed(), true);
    const server = await startProvider({ keys: ['a'], ticks: 2, intervalMs: 20, contextBytes: bytes, contextKind: kind });
    try {
      const response = await fetch(server.baseUrl + '/chat/completions', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'p0-fixture', stream: true,
          messages: [{ role: 'user', content: promptText('a', bytes, kind) }] }) });
      assert.equal(response.status, 200);
      const output = (await response.text()).split('\n').filter(line => line.startsWith('data: {'))
        .map(line => JSON.parse(line.slice(6)).choices[0].delta.content ?? '').join('');
      assert.equal(output, expectedText('a', 2));
      server.assertHealthy(); assert.equal(server.stats.contextVerified, 1);
    } finally { await server.close(); }
  });
}

test('provider rejects a valid session prefix with truncated context', async () => {
  const server = await startProvider({ keys: ['a'], ticks: 2, intervalMs: 20, contextBytes: 1048576 });
  try {
    const response = await fetch(server.baseUrl + '/chat/completions', { method: 'POST',
      body: JSON.stringify({ model: 'p0-fixture', stream: true, messages: [{ role: 'user', content: promptText('a', 1048575) }] }) });
    assert.equal(response.status, 400); await response.text();
    assert.throws(() => server.assertHealthy(), /Context truncated/);
    assert.equal(server.stats.contextVerified, 0);
  } finally { await server.close(); }
});
