import * as ort from './vendor/ort.wasm.bundle.min.mjs';
import { Tokenizer } from './vendor/tokenizers.mjs';
import { createEngine } from './engine.mjs';

let engine;
const base = '/sat/model/137da054051ad9f1eac42025f758db4ac9f22535/';
async function asset(file, sha256) {
  let cache;
  try { cache = await caches.open('lecture-sat-v1'); } catch { /* Storage denied: use network. */ }
  const url = new URL(base + file, self.location.origin).href;
  const cached = await cache?.match(url);
  const response = cached || await fetch(url);
  if (!response.ok) throw new Error(`模型文件加载失败 (${response.status})`);
  const data = await response.arrayBuffer();
  if (sha256) {
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== sha256) { await cache?.delete(url); throw new Error('模型文件校验失败，请重试'); }
  }
  if (!cached) { try { await cache?.put(url, new Response(data)); } catch { /* Quota: inference still works. */ } }
  return data;
}
self.onmessage = async ({ data: { id, action, text } }) => {
  try {
    if (action === 'load') {
      // One thread also works on Sites pages without cross-origin isolation.
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.wasmPaths = new URL('./vendor/', self.location.href).href;
      const response = await fetch(base + 'manifest.json');
      if (!response.ok) throw new Error('SaT 模型暂不可用');
      const manifest = await response.json();
      const bytes = new Uint8Array(manifest.bytes);
      let offset = 0;
      for (const part of manifest.parts) {
        const data = new Uint8Array(await asset(part.file, part.sha256));
        if (data.length !== part.bytes || offset + data.length > bytes.length) throw new Error('SaT 模型不完整');
        bytes.set(data, offset); offset += data.length;
        self.postMessage({ progress: Math.round(offset / bytes.length * 100) });
      }
      if (offset !== bytes.length) throw new Error('SaT 模型不完整');
      const tokenizerJSON = JSON.parse(new TextDecoder().decode(await asset('tokenizer.json', manifest.tokenizerSha256)));
      engine = await createEngine({ ort, Tokenizer, modelBytes: bytes, tokenizerJSON, backend: 'wasm' });
      self.postMessage({ id, result: true });
    } else {
      if (!engine) throw new Error('SaT 尚未加载');
      if (typeof text !== 'string' || text.length > 6000) throw new Error('待断句文本过长，已切回规则模式');
      const result = await engine.split(text);
      self.postMessage({ id, result: { boundaries: result.boundaries } });
    }
  } catch (error) { self.postMessage({ id, error: error.message || 'SaT 断句失败' }); }
};
