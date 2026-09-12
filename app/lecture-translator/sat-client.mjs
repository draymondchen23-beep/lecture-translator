export function createSatClient(onProgress = (_progress) => {}) {
  const worker = new Worker('/sat/worker.mjs', { type: 'module' });
  const pending = new Map();
  let sequence = 0, closed = false;
  const close = () => {
    closed = true;
    worker.terminate();
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('SaT 已停止')); }
    pending.clear();
  };
  worker.onmessage = ({ data }) => {
    if ('progress' in data) { onProgress(data.progress); return; }
    const item = pending.get(data.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(data.id);
    data.error ? item.reject(new Error(data.error)) : item.resolve(data.result);
  };
  worker.onerror = () => close();
  const request = (action, payload = {}, timeout = 15_000) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('SaT 已停止')); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('SaT 响应超时')); close(); }, timeout);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, action, ...payload });
  });
  return { load: () => request('load', {}, 180_000), split: text => request('split', { text }), close };
}
