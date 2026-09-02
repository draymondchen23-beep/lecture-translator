import assert from "node:assert/strict";
import test from "node:test";
import { bestTranscript, collectLiveTranslationWords, contextTail, fallbackFinalCorrectionSegmentId, fallbackRequestSegmentId, hasSemanticBoundary, shouldProcessBrowserResult, shouldStartBrowserFallbackImmediately, splitWords, stableWords, takeLiveTranslationChunk } from "../app/lecture-translator/browser-incremental.mjs";

test("stable prefixes yield a new interim chunk without a timer", () => {
  let stable = [];
  stable = stableWords(["The", "quick"], ["The", "quick", "brown"], stable);
  assert.deepEqual(stable, ["The", "quick"]);
  stable = stableWords(["The", "quick", "brown"], ["The", "quick", "brown", "fox"], stable);
  assert.deepEqual(stable, ["The", "quick", "brown"]);
});

test("each browser fallback request has a unique cache key", () => {
  const ids = [0, 1, 2].map((index) => fallbackRequestSegmentId("session", 4, index));
  assert.equal(new Set(ids).size, ids.length);
  assert.notEqual(fallbackFinalCorrectionSegmentId("session", 4), ids[0]);
});

test("semantic boundaries exclude unfinished clauses", () => {
  assert.equal(hasSemanticBoundary("A long sentence,"), false);
  assert.equal(hasSemanticBoundary("A complete sentence."), true);
});

test("a long live block produces unique linear fast chunks before finalization", () => {
  const words = Array.from({ length: 60 }, (_, index) => `word${index + 1}`);
  const collected = collectLiveTranslationWords({ sourceText: words.join(" "), stableText: "one two" });
  assert.equal(collected.committedWordCount, words.length);
  const chunks = [];
  let pending = collected.words;
  while (pending.length) {
    const chunk = takeLiveTranslationChunk(pending);
    assert.ok(chunk);
    chunks.push(chunk.text);
    pending = chunk.remainingWords;
  }
  assert.ok(chunks.length > 3);
  assert.deepEqual(chunks.flatMap(splitWords), words);
});

test("context is limited to the preceding finalized block tail", () => {
  const source = `Earlier sentence ${"x".repeat(450)} final term`;
  const context = contextTail(source);
  assert.ok(context.length <= 400);
  assert.ok(context.endsWith("final term"));
});

test("best browser alternative uses confidence", () => {
  assert.equal(bestTranscript({ length: 2, 0: { transcript: "first", confidence: 0.2 }, 1: { transcript: "best", confidence: 0.9 } }), "best");
});

test("paused recognition ignores late final results and Sites starts the fallback immediately", () => {
  assert.equal(shouldProcessBrowserResult({ fallbackActive: true, paused: true, intentionalClose: false }), false);
  assert.equal(shouldProcessBrowserResult({ fallbackActive: true, paused: false, intentionalClose: false }), true);
  assert.equal(shouldStartBrowserFallbackImmediately("lecture.chatgpt.site"), true);
  assert.equal(shouldStartBrowserFallbackImmediately("localhost"), false);
});
