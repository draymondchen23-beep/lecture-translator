import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";
import * as browser from "../app/lecture-translator/browser-incremental.mjs";
import * as captions from "../app/lecture-translator/caption-stabilizer.mjs";
import * as realtime from "../app/lecture-translator/realtime-caption-state.mjs";
import * as browserCaptions from "../app/lecture-translator/browser-caption-accumulator.mjs";
import * as recognitionStop from "../app/lecture-translator/browser-recognition-stop.mjs";
import * as satCaptions from "../app/lecture-translator/sat-caption-accumulator.mjs";

const requireFromApp = createRequire(import.meta.url);
const ts = requireFromApp("typescript");
const hookSource = fs.readFileSync(new URL("../app/lecture-translator/use-realtime-lecture.ts", import.meta.url), "utf8");

function result(text, isFinal) {
  return { isFinal, length: 1, 0: { transcript: text, confidence: 1 } };
}

function event(results, resultIndex = 0) {
  return { resultIndex, results: Object.assign(results, { length: results.length }) };
}

function loadHook(onEvent, translate = async (text) => `译：${text}`, control = {}) {
  const refs = [];
  let refIndex = 0;
  const react = {
    useRef(value) { const ref = refs[refIndex] || { current: value }; refs[refIndex++] = ref; return ref; },
    useState(value) { return [value, () => undefined]; },
    useCallback(fn) { return fn; },
    useEffect() {},
  };
  let recognition;
  const recognitions = [];
  class SpeechRecognition {
    start() {}
    stop() {
      if (control.stop) control.stop(this);
      else queueMicrotask(() => this.onend?.());
    }
    abort() {}
    constructor() { recognition = this; recognitions.push(this); }
  }
  const compiled = ts.transpileModule(hookSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = {
    exports: {}, module: { exports: {} }, console, process: { env: { NODE_ENV: "production" } }, crypto: { randomUUID: () => "uuid" },
    WebSocket: { OPEN: 1, CLOSING: 2 },
    fetch: async (_url, options) => ({ ok: true, json: async () => ({ translation: await translate(JSON.parse(options.body).text) }) }),
    window: { location: { hostname: "demo.chatgpt.site", protocol: "https:", host: "demo.chatgpt.site" }, setTimeout: (fn, delay) => {
      const testDelay = control.delays?.[delay];
      const timer = setTimeout(fn, testDelay ?? delay);
      if (testDelay === undefined) timer.unref();
      return timer;
    }, clearTimeout, SpeechRecognition },
    require(id) {
      if (id === "react") return react;
      if (id.endsWith("browser-incremental.mjs")) return browser;
      if (id.endsWith("caption-stabilizer.mjs")) return captions;
      if (id.endsWith("realtime-caption-state.mjs")) return realtime;
      if (id.endsWith("browser-caption-accumulator.mjs")) return browserCaptions;
      if (id.endsWith("browser-recognition-stop.mjs")) return recognitionStop;
      if (id.endsWith("sat-caption-accumulator.mjs")) return satCaptions;
      if (id.endsWith("sat-client.mjs")) return { createSatClient() {
        if (!control.sat) throw new Error('model unavailable in fallback tests');
        return { load: async () => true, split: control.sat, close() {} };
      } };
      return {};
    },
  };
  context.exports = context.module.exports;
  vm.runInNewContext(compiled, context);
  refIndex = 0;
  const api = context.module.exports.useRealtimeLecture({ sessionId: "s", sequenceBase: 0, provider: "qwen", sourceLanguage: "en", targetLanguage: "zh", vad: true, terminology: {}, saveAudio: false, onAudioReady() {}, onEvent });
  return { api, recognitions, get recognition() { return recognition; } };
}

test("SaT commits a confirmed long sentence without the legacy 18-word cut and translates the final tail", async () => {
  const events = [];
  const sentence = 'The electrical signal travels along the entire length of the nerve cell and carries information from one part of the body to another';
  const tail = 'This next sentence is still being spoken';
  const runtime = loadHook(item => events.push(item), undefined, {
    sat: async text => ({ boundaries: text.startsWith(sentence) ? [sentence.length - 1, text.length - 1] : [text.length - 1] }),
  });
  await runtime.api.start();
  runtime.recognition.onresult(event([result(`${sentence} ${tail}`, true)]));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(events.filter(item => item.sourceStatus === 'final').length, 0);
  runtime.recognition.onresult(event([result(`${sentence} ${tail} now`, true)]));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(events.some(item => item.sourceStatus === 'final' && item.sourceText === sentence && item.segmentation === 'sat'));
  await runtime.api.end();
  const rows = [...new Map(events.filter(item => item.type === 'segment.upsert').map(item => [item.segmentId, item])).values()].filter(row => row.sourceText);
  assert.deepEqual(rows.map(row => row.sourceText), [sentence, `${tail} now`]);
  assert.ok(rows.every(row => row.sourceStatus === 'final' && row.translationText === `译：${row.sourceText}`));
});

test("SaT model failure during stop preserves the final corrected words", async () => {
  const events = [];
  let rejectSplit;
  const runtime = loadHook(item => events.push(item), undefined, {
    sat: () => new Promise((_, reject) => { rejectSplit = reject; }),
    stop(recognition) {
      rejectSplit(new Error('worker failed'));
      queueMicrotask(() => { recognition.onresult(event([result('the final corrected neuron', true)])); recognition.onend?.(); });
    },
  });
  await runtime.api.start();
  runtime.recognition.onresult(event([result('the original wrong word', true)]));
  await runtime.api.end();
  const rows = [...new Map(events.filter(item => item.type === 'segment.upsert').map(item => [item.segmentId, item])).values()].filter(row => row.sourceText);
  assert.equal(rows.map(row => row.sourceText).join(' '), 'the final corrected neuron');
  assert.ok(rows.every(row => row.translationText === `译：${row.sourceText}`));
});

test("unpunctuated final result ids accumulate until capture pause without loss", async () => {
  const events = [];
  const runtime = loadHook((item) => events.push(item));
  await runtime.api.start();
  const first = result("first unpunctuated utterance", true);
  runtime.recognition.onresult(event([first]));
  runtime.recognition.onresult(event([first, result("second unpunctuated utterance", true)], 1));
  assert.equal(events.filter((item) => item.type === "segment.upsert" && item.sourceStatus === "final").length, 0);
  await runtime.api.pause();
  assert.deepEqual(events.filter((item) => item.type === "segment.upsert" && item.sourceStatus === "final" && !item.translationText).map((item) => item.sourceText), ["first unpunctuated utterance second unpunctuated utterance"]);
  await new Promise(setImmediate);
  const translated = events.filter((item) => item.type === "segment.upsert" && item.translationStatus === "final");
  assert.equal(translated.length, 1);
  assert.ok(translated.every((item) => item.translationText === `译：${item.sourceText}`));
});

test("fallback cursor handles an interim-to-final revision and a multi-index callback", async () => {
  const events = [];
  const runtime = loadHook((item) => events.push(item));
  await runtime.api.start();
  const revised = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty";
  runtime.recognition.onresult(event([result(revised, false)]));
  runtime.recognition.onresult(event([result(revised, false)]));
  const corrected = revised.replace("nineteen twenty", "corrected nineteen twenty");
  const final = result(corrected, true);
  runtime.recognition.onresult(event([final]));
  runtime.recognition.onresult(event([final, result("separate first", true), result("separate second", true)], 1));
  await runtime.api.pause();
  const finals = [...new Map(events.filter((item) => item.type === "segment.upsert" && item.sourceStatus === "final").map((item) => [item.segmentId, item])).values()];
  assert.equal(finals.map((item) => item.sourceText).join(" "), `${corrected} separate first separate second`);
  assert.ok(finals.every((item) => item.sourceText.split(" ").length <= 18));
});

test("hardware lecture grows through repeated ASR snapshots without duplicate or missing source", async () => {
  const source = "hello and welcome back to hardware architecture now you might ask you know why do I tell you about hardware architecture you're not probably you're not going to build any hardware although it's fun stuff to do and if you're going to become a computer scientist most of you won't want to be it's a great thing to";
  const words = source.split(" ");
  const rows = new Map();
  const runtime = loadHook((item) => { if (item.type === "segment.upsert") rows.set(item.segmentId, item); });
  await runtime.api.start();
  for (let end = 4; end <= words.length; end += 4) {
    const snapshot = result(words.slice(0, end).join(" "), false);
    runtime.recognition.onresult(event([snapshot]));
    runtime.recognition.onresult(event([snapshot]));
  }
  runtime.recognition.onresult(event([result(source, true)]));
  await runtime.api.pause();
  await new Promise(setImmediate);
  const finals = [...rows.values()].filter((row) => row.sourceStatus === "final");
  assert.equal(finals.map((row) => row.sourceText).join(" "), source);
  assert.ok(finals.every((row) => row.sourceText.split(" ").length <= 18 && row.sourceText.length <= 120));
  assert.ok(finals.every((row) => row.translationText === `译：${row.sourceText}`));
});

test("screenshot word finals and recognizer restarts produce one phrase and one translation", async () => {
  const rows = new Map();
  const requests = [];
  const runtime = loadHook((item) => { if (item.type === "segment.upsert") rows.set(item.segmentId, item); }, async (text) => { requests.push(text); return `译：${text}`; });
  await runtime.api.start();
  for (const word of ["and", "it's", "a", "really", "rewarding"]) {
    runtime.recognition.onresult(event([result(word, true)]));
    assert.equal([...rows.values()].filter((row) => row.sourceStatus === "final").length, 0);
    runtime.recognition.onend();
    await new Promise((resolve) => setTimeout(resolve, 275));
  }
  runtime.recognition.onresult(event([result("experience.", true)]));
  await runtime.api.pause();
  const finals = [...rows.values()].filter((row) => row.sourceStatus === "final");
  assert.equal(finals.length, 1);
  assert.equal(finals[0].sourceText, "and it's a really rewarding experience.");
  assert.equal(finals[0].translationText, "译：and it's a really rewarding experience.");
  assert.deepEqual(requests, ["and it's a really rewarding experience."]);
});

test("explicit pause preserves the full tentative tail without duplicating stable words", async () => {
  const rows = new Map();
  const runtime = loadHook((item) => { if (item.type === "segment.upsert") rows.set(item.segmentId, item); });
  await runtime.api.start();
  runtime.recognition.onresult(event([result("this is", true), result("the very last audible phrase", false)]));
  await runtime.api.pause();
  const finals = [...rows.values()].filter((row) => row.sourceStatus === "final");
  assert.equal(finals.map((row) => row.sourceText).join(" "), "this is the very last audible phrase");
});

test("a late short draft translation cannot replace the completed sentence translation", async () => {
  const events = [];
  let releaseDraft;
  const runtime = loadHook((item) => events.push(item), async (text) => {
    if (text === "the membrane controls the movement of") await new Promise((resolve) => { releaseDraft = resolve; });
    return `译：${text}`;
  });
  await runtime.api.start();
  const prefix = result("the membrane controls the movement of", true);
  runtime.recognition.onresult(event([prefix]));
  // The existing debounce has a one-second max wait while silence checks run.
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(typeof releaseDraft, "function");
  runtime.recognition.onresult(event([prefix, result("ions.", true)], 1));
  await new Promise(setImmediate);
  releaseDraft();
  await runtime.api.pause();
  const rows = [...new Map(events.filter((item) => item.type === "segment.upsert").map((item) => [item.segmentId, item])).values()];
  const finals = rows.filter((row) => row.sourceStatus === "final");
  assert.equal(finals.length, 1);
  assert.equal(finals[0].translationText, "译：the membrane controls the movement of ions.");
  assert.equal(events.some((item) => item.sourceText?.endsWith("ions.") && item.translationText === "译：the membrane controls the movement of"), false);
});

for (const action of ["pause", "end"]) {
  test(`${action} waits for stop-time final corrections before translating the tail`, async () => {
    const rows = new Map();
    const requests = [];
    const runtime = loadHook((item) => { if (item.type === "segment.upsert") rows.set(item.segmentId, item); }, async (text) => {
      requests.push(text);
      return `译：${text}`;
    }, { stop(recognition) {
      queueMicrotask(() => {
        recognition.onresult(event([result("the cell.", true)]));
        recognition.onresult(event([result("the cell membrane.", true)]));
        assert.equal([...rows.values()].filter((row) => row.sourceStatus === "final").length, 0);
        recognition.onend();
      });
    } });
    await runtime.api.start();
    runtime.recognition.onresult(event([result("the sell", false)]));
    await runtime.api[action]();
    const finals = [...rows.values()].filter((row) => row.sourceStatus === "final");
    assert.equal(finals.length, 1);
    assert.equal(finals[0].sourceText, "the cell membrane.");
    assert.equal(finals[0].translationText, "译：the cell membrane.");
    assert.deepEqual(requests, ["the cell membrane."]);
  });
}

test("stop timeout saves a short tentative tail and quarantines stale callbacks after resume", async () => {
  const rows = new Map();
  const runtime = loadHook((item) => { if (item.type === "segment.upsert") rows.set(item.segmentId, item); }, undefined,
    { stop() {}, delays: { 1500: 5 } });
  await runtime.api.start();
  const oldRecognition = runtime.recognition;
  oldRecognition.onresult(event([result("thank you", false)]));
  const lateResult = oldRecognition.onresult;
  const lateEnd = oldRecognition.onend;
  await runtime.api.pause();
  assert.equal([...rows.values()][0].sourceText, "thank you");
  assert.equal([...rows.values()][0].translationText, "译：thank you");
  assert.equal(await runtime.api.resume(), true);
  assert.notEqual(runtime.recognition, oldRecognition);
  lateResult(event([result("thank you thank you ghost words.", true)]));
  lateEnd();
  runtime.recognition.onresult(event([result("new lecture words", false)]));
  await runtime.api.pause();
  const finals = [...rows.values()].filter((row) => row.sourceStatus === "final");
  assert.deepEqual(finals.map((row) => row.sourceText), ["thank you", "new lecture words"]);
});

test("immediate resume waits for recognition and translation to finish exactly once", async () => {
  const rows = new Map();
  let stopped;
  let releaseTranslation;
  const runtime = loadHook((item) => { if (item.type === "segment.upsert") rows.set(item.segmentId, item); }, async (text) => {
    await new Promise((resolve) => { releaseTranslation = resolve; });
    return `译：${text}`;
  }, { stop(recognition) { stopped = recognition; } });
  await runtime.api.start();
  runtime.recognition.onresult(event([result("last thought", false)]));
  const pausing = runtime.api.pause();
  const resuming = runtime.api.resume();
  stopped.onresult(event([result("last thought completed", true)]));
  stopped.onend();
  await new Promise(setImmediate);
  assert.equal(runtime.recognitions.length, 1);
  assert.equal(typeof releaseTranslation, "function");
  releaseTranslation();
  await pausing;
  assert.equal(await resuming, true);
  assert.equal(runtime.recognitions.length, 2);
  const finals = [...rows.values()].filter((row) => row.sourceStatus === "final");
  assert.equal(finals.length, 1);
  assert.equal(finals[0].translationText, "译：last thought completed");
  const cleanup = runtime.api.pause();
  stopped.onend();
  await cleanup;
});

test("translation timeout preserves source and marks the last row as failed instead of pending", async () => {
  const rows = new Map();
  let release;
  const runtime = loadHook((item) => { if (item.type === "segment.upsert") rows.set(item.segmentId, item); }, async () => {
    await new Promise((resolve) => { release = resolve; });
    return "迟到的译文";
  }, { delays: { 20000: 5 } });
  await runtime.api.start();
  runtime.recognition.onresult(event([result("goodbye", false)]));
  await runtime.api.end();
  const final = [...rows.values()].find((row) => row.sourceStatus === "final");
  assert.equal(final.sourceText, "goodbye");
  assert.equal(final.translationStatus, "error");
  release();
  await new Promise(setImmediate);
  assert.equal(rows.get(final.segmentId).translationText, "");
});
