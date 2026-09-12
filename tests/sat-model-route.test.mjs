import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../app/api/sat-model/[part]/route.ts', import.meta.url), 'utf8');
function load(fetch) {
  const exports = {};
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, URL, Response, AbortSignal, fetch });
  return exports.GET;
}

test('model endpoint only streams the pinned range and never forwards visitor credentials', async () => {
  const get = load(async (url, options) => {
    assert.equal(url, 'https://huggingface.co/segment-any-text/sat-3l-sm/resolve/137da054051ad9f1eac42025f758db4ac9f22535/model_optimized.onnx');
    assert.equal(options.headers.Range, 'bytes=419430400-427756188');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers.Cookie, undefined);
    return new Response(new Uint8Array([1, 2]), { status: 206, headers: { 'content-range': 'bytes 419430400-427756188/427756189' } });
  });
  const result = await get(new Request('https://example.test/api/sat-model/part-20.bin?url=https://evil.test', { headers: { Authorization: 'private' } }));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('content-length'), '8325789');
  assert.deepEqual([...new Uint8Array(await result.arrayBuffer())], [1, 2]);
});

test('invalid parts never fetch and ignored ranges fail closed instead of streaming the full model', async () => {
  const get = load(async () => { throw new Error('must not fetch'); });
  for (const name of ['part-21.bin', 'part-99.bin', 'anything']) assert.equal((await get(new Request('https://example.test/api/sat-model/' + name))).status, 404);
  const full = load(async () => new Response('whole model', { status: 200 }));
  assert.equal((await full(new Request('https://example.test/api/sat-model/part-00.bin'))).status, 502);
  const wrong = load(async () => new Response('wrong chunk', { status: 206, headers: { 'content-range': 'bytes 0-1/2' } }));
  assert.equal((await wrong(new Request('https://example.test/api/sat-model/part-00.bin'))).status, 502);
});
