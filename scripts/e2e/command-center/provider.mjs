import { createServer } from 'node:http';
import { once } from 'node:events';
import { promptText } from './context.mjs';

export function expectedText(key, ticks) {
  return Array.from({ length: ticks }, (_, i) => `${key}:${i}:${'fixture-data '.repeat(70)}\n`).join('') + `COMPLETE:${key}`;
}

/** Real SSE boundary with an all-session barrier; no model credential or network egress. */
export async function startProvider({ keys, ticks, intervalMs, contextBytes, contextKind = 'ascii', deadlineMs = 60000 }) {
  const allowed = new Set(keys), clients = new Map();
  const stats = { requests: 0, contextVerified: 0, maxConcurrent: 0, finished: 0, aborted: 0, startedAt: null, endedAt: null, overlapMs: 0 };
  let interval, deadline, failure, index = 0, stopped = false;
  const fail = error => { failure ??= error; for (const client of clients.values()) if (!client.res.writableEnded) client.res.destroy(); };
  function frame(client, delta, finish_reason = null) {
    if (client.res.destroyed) throw new Error('Fixture stream closed prematurely');
    if (!client.res.write(`data: ${JSON.stringify({ id: client.key, object: 'chat.completion.chunk', created: 1, model: 'p0-fixture',
      choices: [{ index: 0, delta, finish_reason }] })}\n\n`)) throw new Error('Fixture transport backpressure exceeded bounded load');
  }
  function emit() {
    try {
      for (const client of clients.values()) frame(client, { content: `${client.key}:${index}:${'fixture-data '.repeat(70)}\n` });
      index++;
      if (index === ticks) {
        clearInterval(interval); clearTimeout(deadline);
        stats.endedAt = Date.now(); stats.overlapMs = stats.endedAt - stats.startedAt;
        for (const client of clients.values()) {
          frame(client, { content: `COMPLETE:${client.key}` }); frame(client, {}, 'stop');
          client.res.end('data: [DONE]\n\n'); stats.finished++;
        }
      }
    } catch (error) { clearInterval(interval); clearTimeout(deadline); fail(error); }
  }
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') throw new Error('Unexpected provider route');
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error('Fixture request too large'); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (input.model !== 'p0-fixture' || input.stream !== true) throw new Error('Unexpected model request');
      const last = input.messages.filter(m => m.role === 'user').at(-1)?.content;
      const content = typeof last === 'string' ? last : (last ?? []).map(p => p.text ?? '').join('');
      const key = /^P0_SESSION:([a-z0-9-]+)\n/.exec(content)?.[1];
      if (!key || !allowed.has(key) || clients.has(key)) throw new Error('Unexpected or duplicate session request');
      if (contextBytes !== undefined) {
        if (content !== promptText(key, contextBytes, contextKind)) throw new Error('Context truncated or changed before provider ingress');
        stats.contextVerified++;
      }
      stats.requests++;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.flushHeaders();
      const client = { key, res }; clients.set(key, client);
      frame(client, { role: 'assistant' });
      res.on('close', () => { if (!res.writableEnded && !stopped) { stats.aborted++; fail(new Error('Aborted provider stream')); } });
      stats.maxConcurrent = Math.max(stats.maxConcurrent, clients.size);
      if (clients.size === keys.length) {
        stats.startedAt = Date.now(); emit();
        if (index < ticks) interval = setInterval(emit, intervalMs);
      }
    })().catch(error => { if (!res.headersSent) res.writeHead(400); res.end(); fail(error); });
  });
  server.requestTimeout = deadlineMs;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  deadline = setTimeout(() => fail(new Error('Provider barrier/load deadline exceeded')), deadlineMs);
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    stats, assertHealthy() { if (failure) throw failure; },
    async close() { stopped = true; clearInterval(interval); clearTimeout(deadline); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
