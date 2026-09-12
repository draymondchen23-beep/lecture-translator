// Generated static assets only: inference stays in the visitor's browser.
import { mkdir, readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const revision = '137da054051ad9f1eac42025f758db4ac9f22535';
const tokenizerRevision = 'e73636d4f797dec63c3081bb6ed5c7b0bb3f2089';
const modelSHA256 = '8573277b4dbea9c5fb1b4cfd8c21e5aa628069ac8258d1342ba664e1b64ada6d';
const tokenizerSHA256 = 'a898ea75433890f6610f4e470b8ebeb0c21dce5c8dd61f892eb09eb5919d2e2c';
const root = fileURLToPath(new URL('../', import.meta.url));
const modelDir = path.join(root, 'public/sat/model', revision);
const vendorDir = path.join(root, 'public/sat/vendor');
await mkdir(modelDir, { recursive: true });
await mkdir(vendorDir, { recursive: true });
const digest = value => createHash('sha256').update(value).digest('hex');
async function cachedAsset(repo, rev, name) {
  const cache = path.join(homedir(), '.cache/huggingface/hub', `models--${repo.replace('/', '--')}`, 'snapshots', rev, name);
  try { return await readFile(cache); } catch { /* Reproducible clean checkout build. */ }
  const response = await fetch(`https://huggingface.co/${repo}/resolve/${rev}/${name}`, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`SaT asset unavailable: ${repo}/${name} (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}
const manifestPath = path.join(modelDir, 'manifest.json');
let prepared = false;
try {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await Promise.all([...manifest.parts.map(part => part.file), 'tokenizer.json'].map(file => access(path.join(modelDir, file))));
  prepared = manifest.revision === revision && manifest.bytes === 427756189 && manifest.sha256 === modelSHA256 && manifest.tokenizerSha256 === tokenizerSHA256;
} catch { /* Generate missing model assets. */ }
if (!prepared) {
  const model = await cachedAsset('segment-any-text/sat-3l-sm', revision, 'model_optimized.onnx');
  if (model.length !== 427756189 || digest(model) !== modelSHA256) throw new Error('Unexpected SaT model bytes');
  const parts = [];
  // Each object is below the hosting platform's per-static-file size limit.
  for (let offset = 0, index = 0; offset < model.length; offset += 20 * 1024 * 1024, index++) {
    const data = model.subarray(offset, offset + 20 * 1024 * 1024);
    const file = `part-${String(index).padStart(2, '0')}.bin`;
    await writeFile(path.join(modelDir, file), data);
    parts.push({ file, bytes: data.length, sha256: digest(data) });
  }
  const tokenizer = await cachedAsset('facebookAI/xlm-roberta-base', tokenizerRevision, 'tokenizer.json');
  if (digest(tokenizer) !== tokenizerSHA256) throw new Error('Unexpected SaT tokenizer bytes');
  await writeFile(path.join(modelDir, 'tokenizer.json'), tokenizer);
  await writeFile(manifestPath, JSON.stringify({ revision, bytes: model.length, sha256: digest(model), parts, tokenizerSha256: digest(tokenizer) }));
}
for (const name of ['ort.wasm.bundle.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  await copyFile(path.join(root, 'node_modules/onnxruntime-web/dist', name), path.join(vendorDir, name));
}
await copyFile(path.join(root, 'node_modules/@huggingface/tokenizers/dist/tokenizers.mjs'), path.join(vendorDir, 'tokenizers.mjs'));
await copyFile(path.join(root, 'node_modules/@huggingface/tokenizers/LICENSE'), path.join(vendorDir, 'tokenizers-LICENSE'));
console.log('SaT browser assets ready (pinned model, same-origin static files).');
