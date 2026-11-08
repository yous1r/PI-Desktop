// Observe immediately after spawn. A spawn error emits close, but never exit.
export function observeExit(child, onError = () => {}) {
  let error;
  child.on('error', cause => { error = cause; onError(cause); });
  return new Promise(resolve => child.once('close', (code, signal) => {
    resolve({ code, signal, ...(error ? { error: String(error.message ?? error) } : {}) });
  }));
}
