import assert from "node:assert/strict";
import test from "node:test";
import { applyFinalCorrection, bestTranscript, coalescePendingWords, contextForFastRequest, contextTail, fallbackFinalCorrectionSegmentId, fallbackRequestSegmentId, hasSemanticBoundary, isReadyStablePhrase, nextFallbackRequestKind, planInterimTranslation, previewResultAction, shouldProcessBrowserResult, shouldStartBrowserFallbackImmediately, stableWords, uncommittedTail } from "../app/lecture-translator/browser-incremental.mjs";

test("stable prefixes yield a new interim chunk without a timer", () => {
  let stable = [];
  stable = stableWords(["The", "quick"], ["The", "quick", "brown"], stable);
  assert.deepEqual(stable, ["The", "quick"]);
  stable = stableWords(["The", "quick", "brown"], ["The", "quick", "brown", "fox"], stable);
  assert.deepEqual(stable, ["The", "quick", "brown"]);
  assert.equal(uncommittedTail("The quick brown fox", stable.join(" ")), "fox");
});

test("each browser fallback request has a unique cache key", () => {
  const ids = [0, 1, 2].map((index) => fallbackRequestSegmentId("session", 4, index));
  assert.equal(new Set(ids).size, ids.length);
  assert.notEqual(fallbackFinalCorrectionSegmentId("session", 4), ids[0]);
});

test("pending stable words coalesce without repeating already committed words", () => {
  const committed = "The quick";
  const stable = stableWords(["The", "quick", "brown"], ["The", "quick", "brown", "fox"], ["The", "quick", "brown"]);
  const first = uncommittedTail(stable.join(" "), committed);
  assert.equal(first, "brown");
  assert.equal(coalescePendingWords(first, uncommittedTail("The quick brown fox", "The quick brown")), "brown fox");
});

test("only a semantic boundary opens the legacy stable phrase gate", () => {
  assert.equal(isReadyStablePhrase("one two three four five"), false);
  assert.equal(isReadyStablePhrase("A long sentence,"), false);
  assert.equal(hasSemanticBoundary("A complete sentence."), true);
});

test("rolling previews send stable current prefixes before browser finalization", () => {
  const short = "This is stable";
  assert.deepEqual(planInterimTranslation({ sourceText: "Chrome heard this complete prefix", stableText: "" }), { text: "Chrome heard this complete prefix", mode: "replace" });
  assert.deepEqual(planInterimTranslation({ sourceText: "This is stable but unfinished", stableText: short }), { text: short, mode: "replace" });
  assert.equal(planInterimTranslation({ sourceText: "This is stable but unfinished", stableText: short, lastPreviewText: short }), null);
  const nextPrefix = "This is stable but unfinished while the lecturer speaks today";
  assert.deepEqual(planInterimTranslation({ sourceText: `${nextPrefix} continues`, stableText: nextPrefix, lastPreviewText: short, interimCount: 1 }), { text: nextPrefix, mode: "replace" });
  assert.equal(planInterimTranslation({ sourceText: "one two three four five six seven eight nine", stableText: "one two three four five six seven eight nine", lastPreviewText: nextPrefix, interimCount: 3 }), null);
});

test("preview results publish, drain, or discard according to the current block", () => {
  assert.equal(previewResultAction({ finalRequested: false, pendingPreviewText: "" }), "publish");
  assert.equal(previewResultAction({ finalRequested: false, pendingPreviewText: "newer prefix" }), "drain");
  assert.equal(previewResultAction({ finalRequested: true, pendingPreviewText: "newer prefix" }), "discard");
});

test("context is limited to the preceding finalized block tail", () => {
  const source = `Earlier sentence ${"x".repeat(450)} final term`;
  const context = contextTail(source);
  assert.ok(context.length <= 400);
  assert.ok(context.endsWith("final term"));
});

test("fast context is sent only with a block's first request", () => {
  assert.equal(contextForFastRequest("previous block", 0), "previous block");
  assert.equal(contextForFastRequest("previous block", 1), "");
});

test("final correction replaces interim Chinese and chooses the best browser alternative", () => {
  assert.equal(applyFinalCorrection("快速 分段 翻译", "完整句子的准确翻译"), "完整句子的准确翻译");
  assert.equal(bestTranscript({ length: 2, 0: { transcript: "first", confidence: 0.2 }, 1: { transcript: "best", confidence: 0.9 } }), "best");
});

test("a final correction wins over pending fast words", () => {
  assert.equal(nextFallbackRequestKind({ finalRequested: true, finalSource: "The full utterance.", pendingSource: "remaining interim words" }), "accurate");
  assert.equal(nextFallbackRequestKind({ finalRequested: false, finalSource: null, pendingSource: "new words" }), "fast");
});

test("paused recognition ignores late final results and Sites starts the fallback immediately", () => {
  assert.equal(shouldProcessBrowserResult({ fallbackActive: true, paused: true, intentionalClose: false }), false);
  assert.equal(shouldProcessBrowserResult({ fallbackActive: true, paused: false, intentionalClose: false }), true);
  assert.equal(shouldStartBrowserFallbackImmediately("lecture.chatgpt.site"), true);
  assert.equal(shouldStartBrowserFallbackImmediately("localhost"), false);
});
