import assert from 'node:assert/strict';
import { eventually } from './ai-memory-upstream.mjs';
import { AgentSidecar } from '../../electron/main/agent-sidecar.ts';

/** Production Main wrapper + bundled child; only Host persistence and model are fixtures. */
export function candidateSidecar({ entry, executable, host, events, logs }) {
  const runtimeIds = new Map();
  const sidecar = new AgentSidecar(text => logs.push(text), {
    command: executable ?? process.execPath,
    args: [entry], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  sidecar.setHost({ ...host, onNotification: () => () => {}, onExit: () => () => {} });
  sidecar.onNotification((method, envelope) => { if (method === 'agent.event') events.push(envelope); });
  function attach(bridge) {
    sidecar.setExtensionOwnerLifecycle(bridge);
    sidecar.setTrustedExtensionBridge({ ...bridge,
      registerRuntime: async params => {
        const result = await bridge.registerRuntime(params);
        runtimeIds.set(params.sessionId, params.runtimeId); return result;
      },
    });
  }
  function create(config) {
    let disposed = false; let runtimeId;
    const { host: _host, onEvent: _onEvent, ...wire } = config;
    return {
      get runtimeId() { return runtimeId; },
      // The actual sidecar initializes extensions within runtimeFor on its first prompt.
      async loadTrustedExtensions() {},
      async prompt(content, _messageId, turnId) {
        let timer; let unsubscribe = () => {};
        const end = new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Candidate turn timed out')), 20000);
          unsubscribe = sidecar.onNotification((method, envelope) => {
            if (method !== 'agent.event' || envelope.sessionId !== config.sessionId || envelope.turnId !== turnId) return;
            if (envelope.event.type === 'agent_end') resolve();
            if (envelope.event.type === 'error') reject(new Error(JSON.stringify(envelope.event.error)));
          });
        });
        try {
          const [accepted] = await Promise.all([sidecar.call('agent.prompt', { ...wire, content, turnId }), end]);
          assert.equal(accepted.accepted, true);
          runtimeId = runtimeIds.get(config.sessionId);
          await eventually(() => sidecar.call('agent.getStatus', { sessionId: config.sessionId }),
            value => value.status.isRunning === false, 'candidate turn complete');
        } finally { clearTimeout(timer); unsubscribe(); }
      },
      async abort() { await sidecar.call('agent.abort', { sessionId: config.sessionId }); },
      async dispose(reason = 'reconfigure') {
        if (disposed) return;
        disposed = true; await sidecar.call('agent.disposeSession', { sessionId: config.sessionId, reason });
      },
    };
  }
  return { sidecar, launches: sidecar.extensionOwnerLaunches, attach, create, close: () => sidecar.shutdown() };
}
