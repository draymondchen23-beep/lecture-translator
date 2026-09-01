import assert from "node:assert/strict";
import test from "node:test";

async function render(path = "/lecture-translator") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders the lecture workspace route", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /Lecture — Real-time Translation &amp; Notes/);
  assert.match(html, /Start a lecture/);
  assert.match(html, /Live transcription, translation and AI notes/);
  assert.match(html, /New lecture/);
  assert.doesNotMatch(html, /Building your site|Your site is taking shape/);
});

