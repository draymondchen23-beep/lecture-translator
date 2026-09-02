import assert from "node:assert/strict";
import test from "node:test";
import { reducePartialEvent } from "../app/lecture-translator/partial-events.mjs";
import { advanceDisplayedText, centeredScrollTop, commonPrefixByCodePoint, progressiveDelay, reconcileDisplayedPrefix, shouldRecenter, splitSentences, visibleContentRect } from "../app/lecture-translator/live-display.mjs";

test("late translations and finals cannot replace a newer live block", () => {
  let partial = { source: "first", translation: "第一", sequence: 3 };
  partial = reducePartialEvent(partial, { type: "source.partial", text: "second", sequence: 4 });
  assert.deepEqual(partial, { source: "second", translation: "", sequence: 4 });
  assert.equal(reducePartialEvent(partial, { type: "translation.partial", text: "第一", sequence: 3 }), partial);
  assert.equal(reducePartialEvent(partial, { type: "segment.final", sequence: 3 }), partial);
  assert.deepEqual(reducePartialEvent(partial, { type: "translation.partial", text: "第二", sequence: 4 }), { source: "second", translation: "第二", sequence: 4 });
});

test("progressive display advances one Unicode code point per tick", () => {
  assert.equal(advanceDisplayedText("你", "你好🙂"), "你好");
  assert.equal(advanceDisplayedText("你好", "你好🙂"), "你好🙂");
  assert.equal(advanceDisplayedText("", "🙂好"), "🙂");
  assert.ok(progressiveDelay(12) < progressiveDelay(1));
});

test("rewritten cumulative targets retain their valid displayed prefix", () => {
  assert.equal(commonPrefixByCodePoint("你好世界", "你好同学"), "你好");
  assert.equal(reconcileDisplayedPrefix("你好世界", "你好世界", "你好同学"), "你好");
  assert.equal(reconcileDisplayedPrefix("你好世界", "你好", "你好同学"), "你好");
  assert.equal(reconcileDisplayedPrefix("你好", "你", "再见"), "");
});

test("final text remains complete instead of replaying from an old display prefix", () => {
  const liveTarget = "欢迎来到课堂";
  const displayed = "欢迎来到";
  const finalTarget = "欢迎来到课堂。";
  assert.equal(reconcileDisplayedPrefix(liveTarget, displayed, finalTarget), displayed);
  assert.equal(advanceDisplayedText(finalTarget, finalTarget), finalTarget);
});

test("center recentering ignores small character-growth drift", () => {
  const container = { top: 100, height: 600 };
  assert.equal(shouldRecenter(container, { top: 350, height: 100 }), false);
  assert.equal(shouldRecenter(container, { top: 390, height: 100 }), true);
  assert.deepEqual(visibleContentRect(container, 620), { top: 100, height: 508 });
});

test("centered column scroll is dock-aware and bounded by runway", () => {
  const base = { currentScrollTop: 300, scrollHeight: 1_200, clientHeight: 600, containerTop: 100, targetHeight: 40, dockTop: 620, stickyTop: 48 };
  assert.equal(centeredScrollTop({ ...base, targetTop: 400 }), 342);
  assert.equal(centeredScrollTop({ ...base, targetTop: 1_000 }), 600);
  assert.equal(centeredScrollTop({ ...base, targetTop: 50 }), 0);
});

test("sentence display splits English and Chinese without dropping closers or an unfinished tail", () => {
  assert.deepEqual(splitSentences('First point. "Second point!" Tail'), ['First point.', '"Second point!"', 'Tail']);
  assert.deepEqual(splitSentences("第一句。第二句！未完成", "zh"), ["第一句。", "第二句！", "未完成"]);
  assert.deepEqual(splitSentences("Wait... really?", "en"), ["Wait...", "really?"]);
});
