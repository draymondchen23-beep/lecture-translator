import assert from "node:assert/strict";
import test from "node:test";
import { bestTranscript, contextTail, fallbackFinalCorrectionSegmentId, shouldProcessBrowserResult, shouldStartBrowserFallbackImmediately } from "../app/lecture-translator/browser-incremental.mjs";

test("final correction request ids are unique per block", () => {
  assert.notEqual(fallbackFinalCorrectionSegmentId("session", 1), fallbackFinalCorrectionSegmentId("session", 2));
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
