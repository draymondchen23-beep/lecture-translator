import assert from "node:assert/strict";
import test from "node:test";
import { commonStablePrefix, createSentenceTranslationQueue, DEFAULT_BOUNDARY_CONFIG, findSentenceBoundaries, normalizeCaptionSnapshot, SentenceAccumulator, textAfterStablePrefix } from "../app/lecture-translator/caption-stabilizer.mjs";

test("normalizes browser-style snapshots without inventing an id", () => {
  assert.deepEqual(normalizeCaptionSnapshot({ transcript: "  Hello   world ", final: true, startedAt: 42 }), {
    id: "", text: "Hello world", stableText: "", tentativeText: "", isFinal: true, at: 42,
  });
});

test("interim snapshots replace the tentative caption", () => {
  const captions = new SentenceAccumulator();
  captions.ingest({ id: "interim", text: "The initial guess", isFinal: false }, 0);
  const update = captions.ingest({ id: "interim", text: "The corrected guess", isFinal: false }, 1);
  assert.equal(update.stableText, "");
  assert.equal(update.tentativeText, "The corrected guess");
  assert.equal(update.displayText, "The corrected guess");
});

test("replayed final snapshots are idempotent", () => {
  const captions = new SentenceAccumulator();
  const first = captions.ingest({ id: "r:0", text: "One complete sentence.", isFinal: true }, 0);
  const replay = captions.ingest({ id: "r:0", text: "One complete sentence.", isFinal: true }, 1);
  assert.deepEqual(first.commits.map((item) => item.sourceText), ["One complete sentence."]);
  assert.deepEqual(replay.commits, []);
  assert.equal(replay.displayText, "");
});

test("a natural sentence spans separate recognizer utterances", () => {
  const captions = new SentenceAccumulator();
  assert.deepEqual(captions.ingest({ id: "0", text: "This sentence spans", isFinal: true }, 0).commits, []);
  const update = captions.ingest({ id: "1", text: "two utterances.", isFinal: true }, 10);
  assert.deepEqual(update.commits.map((item) => item.sourceText), ["This sentence spans two utterances."]);
});

test("periods in decimals and abbreviations are not false terminators", () => {
  assert.deepEqual(findSentenceBoundaries("Dr. Smith measured 3.14."), [{ start: 23, end: 24, kind: "hard" }]);
  assert.equal(findSentenceBoundaries("Use e.g. a control sample. Then compare.").length, 2);
});

test("safe semicolon and comma clauses commit from stable speech without a pause", () => {
  const semicolon = new SentenceAccumulator({ softMinWords: 3, boundaryGraceMs: 350 });
  const firstInterim = "We collect samples carefully; then we compare";
  const secondInterim = "We collect samples carefully; then we compare results";
  const stablePrefix = commonStablePrefix(firstInterim, secondInterim);
  semicolon.ingest({ id: "0", stableText: stablePrefix, tentativeText: textAfterStablePrefix(secondInterim, stablePrefix), isFinal: false }, 0);
  assert.deepEqual(semicolon.ingest({ id: "1", tentativeText: "still speaking", isFinal: false }, 350).commits.map((item) => item.sourceText), ["We collect samples carefully;"]);

  const comma = new SentenceAccumulator({ softMinWords: 3, boundaryGraceMs: 350 });
  comma.ingest({ id: "0", stableText: "We collect samples carefully, then we compare results", tentativeText: "still speaking", isFinal: false }, 0);
  assert.deepEqual(comma.ingest({ id: "1", tentativeText: "still speaking", isFinal: false }, 350).commits.map((item) => item.sourceText), ["We collect samples carefully,"]);
});

test("a short pause merges instead of prematurely flushing speech", () => {
  const captions = new SentenceAccumulator({ hardSilenceMs: 1_800, resumeMergeMs: 1_200 });
  captions.ingest({ id: "0", stableText: "The claim is", isFinal: false }, 0);
  assert.deepEqual(captions.advance(1_200).commits, []);
  const update = captions.ingest({ id: "1", text: "that sodium affects the membrane.", isFinal: true }, 1_201);
  assert.deepEqual(update.commits.map((item) => item.sourceText), ["The claim is that sodium affects the membrane."]);
});

test("forced boundaries cap unpunctuated caption growth", () => {
  const captions = new SentenceAccumulator({ ...DEFAULT_BOUNDARY_CONFIG, maxWords: 5, maxChars: 100 });
  const update = captions.ingest({ id: "0", text: "one two three four five six seven", isFinal: true }, 0);
  assert.deepEqual(update.commits.map((item) => [item.sourceText, item.boundary]), [["one two three four five", "forced"]]);
  assert.equal(update.displayText, "six seven");
});

test("translation lag preserves committed source-to-translation order", async () => {
  const started = [];
  const finished = [];
  let releaseFirst;
  const queue = createSentenceTranslationQueue(async (item) => {
    started.push(item.sourceText);
    if (item.sourceText === "First.") await new Promise((resolve) => { releaseFirst = resolve; });
    finished.push([item.sourceText, `zh:${item.sourceText}`]);
  });
  const first = queue.enqueue({ sourceText: "First." });
  const second = queue.enqueue({ sourceText: "Second." });
  await Promise.resolve();
  assert.deepEqual(started, ["First."]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(started, ["First.", "Second."]);
  assert.deepEqual(finished, [["First.", "zh:First."], ["Second.", "zh:Second."]]);
});
