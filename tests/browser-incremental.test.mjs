import assert from "node:assert/strict";
import test from "node:test";
import { appendAccurateTranslation, bestTranscript, completedSentencePrefix, contextTail, fallbackFinalCorrectionSegmentId, hasTokenPrefix, NATURAL_PAUSE_MS, shouldCommitAfterPause, shouldProcessBrowserResult, shouldStartBrowserFallbackImmediately, tentativeTranslationPlan } from "../app/lecture-translator/browser-incremental.mjs";

test("final correction request ids are unique per block", () => {
  assert.notEqual(fallbackFinalCorrectionSegmentId("session", 1), fallbackFinalCorrectionSegmentId("session", 2));
});

test("tentative translation commits sentence boundaries, pauses, and stable growth once", () => {
  const first = "First complete sentence.";
  assert.equal(completedSentencePrefix(`${first} unfinished tail`), first);
  assert.equal(tentativeTranslationPlan({ sourceText: `${first} unfinished tail`, stableText: `${first} unfinished` })?.text, first);
  assert.equal(shouldCommitAfterPause(NATURAL_PAUSE_MS - 1), false);
  assert.equal(shouldCommitAfterPause(NATURAL_PAUSE_MS), true);
  const words = Array.from({ length: 12 }, (_, index) => `word${index + 1}`);
  const firstPlan = tentativeTranslationPlan({ sourceText: words.join(" "), stableText: words.join(" ") });
  assert.deepEqual(firstPlan, { sourcePrefix: words.join(" "), text: words.join(" ") });
  const tail = ["word13", "word14", "word15"];
  assert.deepEqual(tentativeTranslationPlan({ sourceText: [...words, ...tail].join(" "), stableText: [...words, ...tail].join(" "), requestedSourcePrefix: firstPlan.sourcePrefix, force: true }), { sourcePrefix: [...words, ...tail].join(" "), text: tail.join(" ") });
  assert.equal(hasTokenPrefix("Clinical lectures continue.", "Clinical"), true);
  assert.equal(hasTokenPrefix("Clinically relevant lectures.", "Clinical"), false);
  assert.equal(tentativeTranslationPlan({ sourceText: "Clinically relevant lectures.", stableText: "Clinically relevant lectures.", requestedSourcePrefix: "Clinical" }), null);
  assert.equal(appendAccurateTranslation("第一句。", "第二句。"), "第一句。第二句。");
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
