import assert from "node:assert/strict";
import test from "node:test";
import { createBoundedTranslationQueue, RealtimeCaptionNormalizer } from "../app/lecture-translator/realtime-caption-state.mjs";

test("source and late translation upsert the same stable row", () => {
  const captions = new RealtimeCaptionNormalizer("session-a");
  const source = captions.ingest({ type: "source.partial", itemId: "item-a", sequence: 0, startedAt: 10, text: "The membrane potential" });
  const translation = captions.ingest({ type: "translation.partial", itemId: "item-a", sequence: 7, startedAt: 10, text: "膜电位" });
  const final = captions.ingest({ type: "segment.final", itemId: "item-a", sequence: 7, startedAt: 10, endedAt: 20, sourceText: "The membrane potential changes.", translatedText: "膜电位发生变化。", provider: "qwen" });
  assert.equal(source.segmentId, "session-a:item-a");
  assert.equal(translation.segmentId, source.segmentId);
  assert.equal(final.segmentId, source.segmentId);
  assert.equal(final.sourceStatus, "final");
  assert.equal(final.translationStatus, "final");
  assert.equal(final.sourceRevision, 2);
});

test("a new session cannot reuse an old response identity", () => {
  const first = new RealtimeCaptionNormalizer("first").ingest({ type: "translation.partial", itemId: "same", sequence: 0, startedAt: 1, text: "旧" });
  const second = new RealtimeCaptionNormalizer("second").ingest({ type: "translation.partial", itemId: "same", sequence: 0, startedAt: 1, text: "新" });
  assert.notEqual(first.segmentId, second.segmentId);
});

test("separate runs keep provider item ids isolated while preserving session ownership", () => {
  const first = new RealtimeCaptionNormalizer("session", "session:run-a").ingest({ type: "source.partial", itemId: "item", sequence: 0, startedAt: 1, text: "first" });
  const second = new RealtimeCaptionNormalizer("session", "session:run-b").ingest({ type: "source.partial", itemId: "item", sequence: 0, startedAt: 1, text: "second" });
  assert.equal(first.sessionId, second.sessionId);
  assert.notEqual(first.segmentId, second.segmentId);
});

test("final target stays immutable while source finishes later", () => {
  const captions = new RealtimeCaptionNormalizer("s");
  captions.ingest({ type: "translation.final", itemId: "i", sequence: 0, startedAt: 1, text: "已定稿" });
  const source = captions.ingest({ type: "source.partial", itemId: "i", sequence: 9, startedAt: 1, text: "source continues" });
  const late = captions.ingest({ type: "translation.partial", itemId: "i", sequence: 9, startedAt: 1, text: "过期" });
  assert.equal(source.translationStatus, "final");
  assert.equal(late.translationText, "已定稿");
});

test("bounded queue coalesces stale revisions under sustained enqueue pressure", async () => {
  const completed = [];
  const queue = createBoundedTranslationQueue(async (job) => { completed.push(job); }, { concurrency: 2, maxPending: 24 });
  // A ten-minute-equivalent number of revisions: only the latest queued
  // revision for each of the two live rows may survive. This is queue stress,
  // not a timing or audio replay.
  for (let tick = 0; tick < 600 * 5; tick += 1) {
    queue.enqueue({ segmentId: `row-${tick % 2}`, requestId: `r-${tick}`, revision: tick });
    assert.ok(queue.size <= 26);
  }
  await queue.idle();
  assert.ok(completed.length <= 4);
  assert.deepEqual(completed.slice(-2).map((job) => job.revision).sort((a, b) => a - b), [2998, 2999]);
});
