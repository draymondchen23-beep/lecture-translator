import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("lecture translator uses continuous PCM streaming through Qwen's realtime protocol", async () => {
  const [page, hook, relay, worklet, route, viteConfig, worker] = await Promise.all([
    read("app/lecture-translator/page.tsx"),
    read("app/lecture-translator/use-realtime-lecture.ts"),
    read("server/realtime-proxy.ts"),
    read("public/audio/pcm-capture-worklet.js"),
    read("app/api/translate/route.ts"),
    read("vite.config.ts"),
    read("worker/realtime.ts"),
  ]);

  assert.doesNotMatch(page, /webkitSpeechRecognition|SpeechRecognition/);
  assert.match(hook, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(hook, /AudioWorkletNode/);
  assert.match(hook, /CHUNK_SAMPLES = 1_600/);
  assert.doesNotMatch(hook, /FALLBACK_TRANSLATION_INTERVAL/);
  assert.doesNotMatch(hook, /timer: number/);
  assert.match(hook, /MAX_QUEUED_CHUNKS = 300/);
  assert.match(hook, /webkitSpeechRecognition/);
  assert.match(hook, /Realtime connection closed before opening/);
  assert.match(hook, /recognition\.interimResults = true/);
  assert.match(hook, /recognition\.maxAlternatives = 3/);
  assert.match(hook, /shouldProcessBrowserResult/);
  assert.match(hook, /shouldStartBrowserFallbackImmediately\(window\.location\.hostname\)/);
  assert.match(hook, /fetch\("\/api\/translate"/);
  assert.match(hook, /fallbackCorrectionQueueRef/);
  assert.match(hook, /fallbackFinalCorrectionSegmentId/);
  assert.match(hook, /fallbackFinalCorrectionSegmentId\(sessionId, block\.sequence\), "accurate", block\.context/);
  assert.match(hook, /fallbackRequestSegmentId\(sessionId, block\.sequence, block\.requestIndex\+\+\), "accurate", block\.context/);
  assert.match(hook, /isReadyStablePhrase\(block\.pendingSource\)/);
  assert.ok((hook.match(/fallbackContextRef\.current = ""/g) || []).length >= 2);
  assert.match(hook, /url\.searchParams\.set\("provider", "qwen"\)/);
  assert.match(hook, /hostname}:3002/);
  assert.match(hook, /processorOptions: \{ targetSampleRate: SAMPLE_RATE, chunkSamples: CHUNK_SAMPLES \}/);
  const publicFallback = hook.indexOf("shouldStartBrowserFallbackImmediately(window.location.hostname) && !optionsRef.current.saveAudio && startBrowserFallback()");
  assert.ok(publicFallback >= 0 && publicFallback < hook.indexOf("await startMicrophone();", publicFallback));
  assert.match(worklet, /registerProcessor\("pcm-capture"/);
  assert.match(worklet, /this\.step = sampleRate \/ this\.targetSampleRate/);
  assert.match(relay, /qwen3\.5-livetranslate-flash-realtime/);
  assert.match(relay, /new WebSocket\(endpoint, \{ headers: \{ Authorization/);
  assert.match(relay, /WebSocketServer\(\{ noServer: true \}\)/);
  assert.match(relay, /\[CLIENT\] Connecting/);
  assert.match(relay, /\[QWEN\] Connecting/);
  assert.match(relay, /\[QWEN\] OPEN/);
  assert.match(relay, /input_audio_buffer\.append/);
  assert.match(relay, /response\.text\.text/);
  assert.match(relay, /response\.text\.done/);
  assert.match(relay, /session\.updated/);
  assert.match(relay, /session\.finished/);
  assert.match(relay, /corpus: \{ phrases: this\.terminology \}/);
  assert.doesNotMatch(relay, /speech_translate|HMAC.*SHA-1/s);
  assert.doesNotMatch(worker, /fetch\(.*wss:|input_audio_buffer\.append/s);
  assert.match(worker, /local Node development server/);
  assert.match(viteConfig, /qwenRealtimeProxy\(qwen\)/);
  assert.match(viteConfig, /port: 3001/);
  assert.doesNotMatch(page, /Preview fake stream|runFakeStream/);
  assert.match(page, /Jump to live/);
  assert.match(page, /useProgressiveText/);
  assert.match(page, /enabled: activeSession\.status === "recording"/);
  assert.match(page, /resetKey: partial\.sequence/);
  assert.doesNotMatch(page, /finalVisual|animateTranslation|translationDisplay/);
  assert.match(page, /programmaticScrollRef/);
  assert.match(page, /onWheel=/);
  assert.match(page, /requestAnimationFrame/);
  assert.match(page, /ResizeObserver/);
  assert.doesNotMatch(page, /partial\.translation, liveTranslation\.displayed/);
  assert.doesNotMatch(page, /setPartial\(\(current\) => \(\{ \.\.\.current, translation: liveTranslation\.displayed/);
  assert.match(page, /loadWorkspace/);
  assert.match(page, /\/api\/summarize/);
  assert.match(route, /qwen-mt-flash/);
  assert.match(route, /QWEN_API_URL\?\.trim\(\)/);
  assert.match(route, /cn-beijing\.maas\.aliyuncs\.com\/compatible-mode\/v1\/chat\/completions/);
  assert.match(route, /workspace && \(!override \|\| isGenericDashScopeUrl\(override\)\)/);
  assert.match(route, /\[400, 404, 422\]\.includes\(response\.status\)/);
  assert.match(route, /model = "qwen-mt-plus"/);
  assert.match(route, /!explicitModel/);
  assert.match(route, /Qwen-MT upstream request failed/);
  assert.doesNotMatch(route, /response\.text\(/);

  // Configuration names may be shown as setup guidance, but credentials must
  // remain server-side and never be embedded as client-side string literals.
  for (const variable of [
    "DASHSCOPE_API_KEY",
    "DASHSCOPE_WORKSPACE_ID",
    "TENCENT_SECRET_ID",
    "TENCENT_SECRET_KEY",
    "TENCENT_APP_ID",
  ]) assert.match(page, new RegExp(variable));
  assert.doesNotMatch(page, /(?:DASHSCOPE_API_KEY|DASHSCOPE_WORKSPACE_ID|TENCENT_SECRET_ID|TENCENT_SECRET_KEY|TENCENT_APP_ID)\s*[:=]\s*["'`][^"'`]+["'`]/);

  assert.match(page, /Pin to top/);
  assert.match(page, /Delete/);
  assert.match(page, /Qwen realtime translation is not configured/);
  assert.match(page, /setSettingsOpen\(true\)/);
  assert.match(page, /if \(providerStatusLoaded && !providerStatus\.qwen\)/);
  assert.doesNotMatch(page, /const startLecture = async \(\) => \{\s*const status = await refreshProviderStatus\(\)/);
});
