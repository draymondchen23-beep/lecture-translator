import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";
import * as browser from "../app/lecture-translator/browser-incremental.mjs";
import * as captions from "../app/lecture-translator/caption-stabilizer.mjs";
import * as realtime from "../app/lecture-translator/realtime-caption-state.mjs";

const requireFromApp = createRequire(import.meta.url);
const ts = requireFromApp("typescript");
const hookSource = fs.readFileSync(new URL("../app/lecture-translator/use-realtime-lecture.ts", import.meta.url), "utf8");

function result(text, isFinal) {
  return { isFinal, length: 1, 0: { transcript: text, confidence: 1 } };
}

function event(results, resultIndex = 0) {
  return { resultIndex, results: Object.assign(results, { length: results.length }) };
}

function loadHook(onEvent) {
  const refs = [];
  let refIndex = 0;
  const react = {
    useRef(value) { const ref = refs[refIndex] || { current: value }; refs[refIndex++] = ref; return ref; },
    useState(value) { return [value, () => undefined]; },
    useCallback(fn) { return fn; },
    useEffect() {},
  };
  let recognition;
  class SpeechRecognition {
    start() {}
    stop() {}
    abort() {}
    constructor() { recognition = this; }
  }
  const compiled = ts.transpileModule(hookSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const context = {
    exports: {}, module: { exports: {} }, console, process: { env: { NODE_ENV: "production" } }, crypto: { randomUUID: () => "uuid" },
    fetch: async (_url, options) => ({ ok: true, json: async () => ({ translation: `译：${JSON.parse(options.body).text}` }) }),
    window: { location: { hostname: "demo.chatgpt.site", protocol: "https:", host: "demo.chatgpt.site" }, setTimeout, clearTimeout, SpeechRecognition },
    require(id) {
      if (id === "react") return react;
      if (id.endsWith("browser-incremental.mjs")) return browser;
      if (id.endsWith("caption-stabilizer.mjs")) return captions;
      if (id.endsWith("realtime-caption-state.mjs")) return realtime;
      return {};
    },
  };
  context.exports = context.module.exports;
  vm.runInNewContext(compiled, context);
  refIndex = 0;
  const api = context.module.exports.useRealtimeLecture({ sessionId: "s", sequenceBase: 0, provider: "qwen", sourceLanguage: "en", targetLanguage: "zh", vad: true, terminology: {}, saveAudio: false, onAudioReady() {}, onEvent });
  return { api, get recognition() { return recognition; } };
}

test("fallback finals flush independent unpunctuated result streams without loss", async () => {
  const events = [];
  const runtime = loadHook((item) => events.push(item));
  await runtime.api.start();
  const first = result("first unpunctuated utterance", true);
  runtime.recognition.onresult(event([first]));
  runtime.recognition.onresult(event([first, result("second unpunctuated utterance", true)], 1));
  assert.deepEqual(events.filter((item) => item.type === "segment.upsert" && item.sourceStatus === "final").map((item) => item.sourceText), ["first unpunctuated utterance", "second unpunctuated utterance"]);
  await new Promise(setImmediate);
  const translated = events.filter((item) => item.type === "segment.upsert" && item.translationStatus === "final");
  assert.equal(translated.length, 2);
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
  const finals = events.filter((item) => item.type === "segment.upsert" && item.sourceStatus === "final").map((item) => item.sourceText);
  assert.equal(finals.slice(0, 2).join(" "), corrected);
  assert.deepEqual(finals.slice(2), ["separate first", "separate second"]);
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
  await new Promise(setImmediate);
  const finals = [...rows.values()].filter((row) => row.sourceStatus === "final");
  assert.equal(finals.map((row) => row.sourceText).join(" "), source);
  assert.ok(finals.every((row) => row.sourceText.split(" ").length <= 18 && row.sourceText.length <= 120));
  assert.ok(finals.every((row) => row.translationText === `译：${row.sourceText}`));
});
