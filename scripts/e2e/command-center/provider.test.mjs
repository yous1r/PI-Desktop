import assert from 'node:assert/strict';
import test from 'node:test';
import { startProvider, expectedText } from './provider.mjs';

function request(baseUrl, key, signal) {
  return fetch(baseUrl + '/chat/completions', { method: 'POST', signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'p0-fixture', stream: true, messages: [{ role: 'user', content: `P0_SESSION:${key}\ncontext` }] }) });
}
function textFrom(body) {
  return body.split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)).choices[0].delta.content ?? '').join('');
}

test('provider waits for all sessions and produces independently verifiable output', async () => {
  const server = await startProvider({ keys: ['a','b'], ticks: 4, intervalMs: 20, deadlineMs: 3000 });
  try {
    const first = await request(server.baseUrl, 'a');
    assert.equal(server.stats.startedAt, null);
    const second = await request(server.baseUrl, 'b');
    const [a, b] = await Promise.all([first.text(), second.text()]);
    server.assertHealthy();
    assert.equal(textFrom(a), expectedText('a', 4)); assert.equal(textFrom(b), expectedText('b', 4));
    assert.equal(server.stats.maxConcurrent, 2); assert.equal(server.stats.finished, 2);
  } finally { await server.close(); }
});

test('unexpected or repeated session input is a failure rather than an extra stream', async () => {
  const server = await startProvider({ keys: ['a'], ticks: 2, intervalMs: 20, deadlineMs: 3000 });
  try {
    const response = await request(server.baseUrl, 'unknown');
    assert.equal(response.status, 400); await response.text();
    assert.throws(() => server.assertHealthy(), /Unexpected or duplicate/);
    assert.equal(server.stats.maxConcurrent, 0);
  } finally { await server.close(); }
});
