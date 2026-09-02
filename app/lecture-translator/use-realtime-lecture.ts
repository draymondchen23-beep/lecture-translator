"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { bestTranscript, contextTail, fallbackFinalCorrectionSegmentId, shouldProcessBrowserResult, shouldStartBrowserFallbackImmediately } from "./browser-incremental.mjs";
import type { LectureState, ProviderPreference, RealtimeServerEvent } from "./types";

type Options = {
  provider: ProviderPreference;
  sourceLanguage: string;
  targetLanguage: string;
  vad: boolean;
  terminology: Record<string, string>;
  saveAudio: boolean;
  onAudioReady(audio: Blob): void;
  onEvent(event: RealtimeServerEvent): void;
};

type Metrics = { audioChunks: number; audioSent: number; audioQueued: number; partialEvents: number; finalEvents: number; latency: number };
type DebugState = { micActive: boolean; rms: number; webSocketState: string; lastServerEvent: string; lastError: string };
type BrowserSpeechAlternative = { transcript?: string; confidence?: number };
type BrowserSpeechResult = { isFinal: boolean; length: number; [index: number]: BrowserSpeechAlternative };
type BrowserSpeechEvent = { resultIndex: number; results: { length: number; [index: number]: BrowserSpeechResult } };
type BrowserSpeechError = { error?: string };
type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives?: number;
  lang: string;
  onresult: ((event: BrowserSpeechEvent) => void) | null;
  onerror: ((event: BrowserSpeechError) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
type BrowserSpeechConstructor = new () => BrowserSpeechRecognition;
type FallbackLiveBlock = {
  sequence: number;
  startedAt: number;
  sourceText: string;
  translatedText: string;
  context: string;
  finalSource: string | null;
  finalRequested: boolean;
};

const SAMPLE_RATE = 16_000;
const CHUNK_SAMPLES = 1_600;
const MAX_QUEUED_CHUNKS = 300;
const DEBUG = process.env.NODE_ENV !== "production";
function trace(event: string, details: Record<string, unknown> = {}) {
  if (DEBUG) console.debug("[lecture-realtime]", { event, ...details });
}

export function useRealtimeLecture(options: Options) {
  const [state, setState] = useState<LectureState>("IDLE");
  const [level, setLevel] = useState(0);
  const [message, setMessage] = useState("");
  const [metrics, setMetrics] = useState<Metrics>({ audioChunks: 0, audioSent: 0, audioQueued: 0, partialEvents: 0, finalEvents: 0, latency: 0 });
  const [debug, setDebug] = useState<DebugState>({ micActive: false, rms: 0, webSocketState: "CLOSED", lastServerEvent: "—", lastError: "—" });
  const optionsRef = useRef(options);
  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const queuedRef = useRef<ArrayBuffer[]>([]);
  const intentionalCloseRef = useRef(false);
  const pausedRef = useRef(false);
  const reconnectRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const flushPcmRef = useRef<(() => Promise<void>) | null>(null);
  const connectRef = useRef<() => Promise<void>>(async () => undefined);
  const speechRef = useRef<BrowserSpeechRecognition | null>(null);
  const fallbackActiveRef = useRef(false);
  const fallbackSequenceRef = useRef(0);
  const fallbackStartedAtRef = useRef(0);
  const fallbackSessionRef = useRef("");
  const fallbackContextRef = useRef("");
  const fallbackFinalIndexesRef = useRef(new Set<number>());
  const fallbackFinalQueueRef = useRef<Promise<void>>(Promise.resolve());
  const fallbackWorkRef = useRef(new Set<Promise<void>>());
  const fallbackRestartRef = useRef<number | null>(null);
  const fallbackEpochRef = useRef(0);
  const fallbackBlockRef = useRef<FallbackLiveBlock | null>(null);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const emit = useCallback((event: RealtimeServerEvent) => {
    if (event.type === "state") {
      setState(event.state);
      setMessage(event.message ?? "");
    } else if (event.type === "error") {
      setMessage(event.message);
      if (DEBUG) setDebug((current) => ({ ...current, lastError: event.message }));
      if (!event.recoverable) setState("ERROR");
    } else if (event.type === "metrics") {
      setMetrics(event);
    }
    optionsRef.current.onEvent(event);
  }, []);

  const cleanupSocket = useCallback(() => {
    if (reconnectRef.current !== null) window.clearTimeout(reconnectRef.current);
    reconnectRef.current = null;
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "client cleanup");
  }, []);

  const connect = useCallback(async () => {
    cleanupSocket();
    const current = optionsRef.current;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const realtimeOrigin = DEBUG ? `${protocol}//${window.location.hostname}:3002` : `${protocol}//${window.location.host}`;
    const url = new URL(`${realtimeOrigin}/api/lecture-realtime`);
    url.searchParams.set("provider", "qwen");
    url.searchParams.set("source", current.sourceLanguage);
    url.searchParams.set("target", current.targetLanguage);
    if (DEBUG) url.searchParams.set("debug", "1");
    setState(reconnectAttemptRef.current ? "RECONNECTING" : "CONNECTING");
    if (DEBUG) setDebug((current) => ({ ...current, webSocketState: "CONNECTING" }));
    trace("socket.connecting", { attempt: reconnectAttemptRef.current + 1, url: url.pathname });

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      let opened = false;
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      const timeout = window.setTimeout(() => {
        socket.close();
        reject(new Error("Realtime connection timed out"));
      }, 12_000);

      socket.onopen = () => {
        opened = true;
        window.clearTimeout(timeout);
        reconnectAttemptRef.current = 0;
        trace("socket.open");
        if (DEBUG) setDebug((current) => ({ ...current, webSocketState: "OPEN" }));
        socket.send(JSON.stringify({
          type: "session.start",
          vad: current.vad,
          terminology: current.terminology,
        }));
        const queued = queuedRef.current.splice(0);
        queued.forEach((chunk) => socket.send(chunk));
        resolve();
      };
      socket.onmessage = (messageEvent) => {
        if (typeof messageEvent.data !== "string") return;
        try {
          const event = JSON.parse(messageEvent.data) as RealtimeServerEvent;
          trace("socket.event", { type: event.type });
          if (DEBUG) setDebug((current) => ({ ...current, lastServerEvent: event.type }));
          emit(event);
        } catch {
          emit({ type: "error", message: "The realtime service returned an unreadable event.", recoverable: true });
        }
      };
      socket.onerror = () => {
        trace("socket.error", { readyState: socket.readyState });
        if (DEBUG) setDebug((current) => ({ ...current, webSocketState: "ERROR" }));
        window.clearTimeout(timeout);
        if (socket.readyState !== WebSocket.OPEN) reject(new Error("Realtime connection failed"));
      };
      socket.onclose = () => {
        window.clearTimeout(timeout);
        trace("socket.close", { intentional: intentionalCloseRef.current });
        if (DEBUG) setDebug((current) => ({ ...current, webSocketState: "CLOSED" }));
        if (!opened) {
          reject(new Error("Realtime connection closed before opening"));
          return;
        }
        if (intentionalCloseRef.current || fallbackActiveRef.current || !streamRef.current) return;
        setState("RECONNECTING");
        setMessage("Connection lost. Audio is being preserved locally.");
        const attempt = Math.min(reconnectAttemptRef.current + 1, 8);
        reconnectAttemptRef.current = attempt;
        const delay = Math.min(1_000 * 2 ** (attempt - 1), 20_000) + Math.random() * 300;
        reconnectRef.current = window.setTimeout(() => void connectRef.current().catch(() => undefined), delay);
      };
    });
  }, [cleanupSocket, emit]);

  useEffect(() => { connectRef.current = connect; }, [connect]);

  const sendChunk = useCallback((chunk: ArrayBuffer) => {
    if (pausedRef.current || fallbackActiveRef.current) return;
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(chunk);
    else {
      queuedRef.current.push(chunk);
      if (queuedRef.current.length > MAX_QUEUED_CHUNKS) queuedRef.current.shift();
    }
    setMetrics((current) => ({ ...current, audioChunks: current.audioChunks + 1 }));
    if (DEBUG && queuedRef.current.length) trace("audio.queued", { bytes: chunk.byteLength, queued: queuedRef.current.length });
  }, []);

  const clearFallbackBlock = useCallback(() => {
    fallbackBlockRef.current = null;
  }, []);

  const trackFallbackWork = useCallback((task: Promise<void>) => {
    fallbackWorkRef.current.add(task);
    void task.finally(() => fallbackWorkRef.current.delete(task));
  }, []);

  const waitForFallbackWork = useCallback(async () => {
    while (fallbackWorkRef.current.size) await Promise.all([...fallbackWorkRef.current]);
  }, []);

  const translateFallback = useCallback(async (sessionId: string, text: string, segmentId: string, quality: "accurate", context: string) => {
    const response = await fetch("/api/translate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lectureId: sessionId, sessionId, segmentId, text, context, quality, terminology: optionsRef.current.terminology }),
    });
    const result = await response.json().catch(() => ({})) as { translation?: unknown; error?: unknown };
    if (!response.ok || typeof result.translation !== "string" || !result.translation.trim()) {
      throw new Error(typeof result.error === "string" ? result.error : "Translation failed.");
    }
    return result.translation.trim();
  }, []);

  const queueFallbackFinal = useCallback((block: FallbackLiveBlock) => {
    const sessionId = fallbackSessionRef.current;
    const epoch = fallbackEpochRef.current;
    const task = fallbackFinalQueueRef.current.then(async () => {
      const sourceText = block.finalSource;
      if (epoch !== fallbackEpochRef.current || !sourceText) return;
      try {
        setState("PROCESSING");
        const translated = await translateFallback(sessionId, sourceText, fallbackFinalCorrectionSegmentId(sessionId, block.sequence), "accurate", block.context);
        if (epoch !== fallbackEpochRef.current) return;
        block.translatedText = translated;
        fallbackContextRef.current = contextTail(sourceText);
        emit({ type: "translation.partial", text: translated, sequence: block.sequence, startedAt: block.startedAt });
      } catch (error) {
        if (epoch !== fallbackEpochRef.current) return;
        emit({ type: "error", message: error instanceof Error ? error.message : "Translation failed.", recoverable: true });
      }
      if (epoch !== fallbackEpochRef.current) return;
      emit({ type: "segment.final", sequence: block.sequence, sourceText, translatedText: block.translatedText, startedAt: block.startedAt, endedAt: Date.now(), provider: "qwen", refined: true });
      if (fallbackActiveRef.current && !pausedRef.current) setState("LISTENING");
    });
    fallbackFinalQueueRef.current = task;
    trackFallbackWork(task);
  }, [emit, trackFallbackWork, translateFallback]);

  const flushFallbackBlock = useCallback(() => {
    const block = fallbackBlockRef.current;
    if (!block) return;
    fallbackBlockRef.current = null;
    if (block.sourceText && !block.finalRequested) {
      block.finalRequested = true;
      block.finalSource = block.sourceText;
      fallbackContextRef.current = contextTail(block.finalSource);
      queueFallbackFinal(block);
    }
    fallbackStartedAtRef.current = Date.now();
  }, [queueFallbackFinal]);

  const startBrowserFallback = useCallback(() => {
    const speechWindow = window as unknown as {
      SpeechRecognition?: BrowserSpeechConstructor;
      webkitSpeechRecognition?: BrowserSpeechConstructor;
    };
    const SpeechRecognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!SpeechRecognition) return false;

    fallbackActiveRef.current = true;
    cleanupSocket();
    queuedRef.current = [];
    fallbackSequenceRef.current = 0;
    fallbackStartedAtRef.current = Date.now();
    fallbackSessionRef.current = crypto.randomUUID();
    fallbackContextRef.current = "";
    fallbackFinalIndexesRef.current = new Set();
    fallbackFinalQueueRef.current = Promise.resolve();
    fallbackWorkRef.current.clear();
    fallbackEpochRef.current += 1;
    clearFallbackBlock();

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    if ("maxAlternatives" in recognition) recognition.maxAlternatives = 3;
    recognition.lang = "en-GB";
    recognition.onresult = (event) => {
      if (!shouldProcessBrowserResult({ fallbackActive: fallbackActiveRef.current, paused: pausedRef.current, intentionalClose: intentionalCloseRef.current })) return;
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = bestTranscript(result);
        if (!text) continue;
        if (result.isFinal) {
          if (fallbackFinalIndexesRef.current.has(index)) continue;
          fallbackFinalIndexesRef.current.add(index);
          const block = fallbackBlockRef.current || {
            sequence: fallbackSequenceRef.current++, startedAt: fallbackStartedAtRef.current || Date.now(), sourceText: text,
            translatedText: "", context: fallbackContextRef.current, finalSource: null, finalRequested: false,
          };
          if (block.finalRequested) continue;
          block.sourceText = text;
          block.finalRequested = true;
          block.finalSource = text;
          fallbackContextRef.current = contextTail(text);
          emit({ type: "source.partial", text, sequence: block.sequence, startedAt: block.startedAt });
          queueFallbackFinal(block);
          fallbackBlockRef.current = null;
          fallbackStartedAtRef.current = Date.now();
        } else {
          interim = `${interim} ${text}`.trim();
        }
      }
      if (interim) {
        if (!fallbackStartedAtRef.current) fallbackStartedAtRef.current = Date.now();
        const block = fallbackBlockRef.current || {
          sequence: fallbackSequenceRef.current++, startedAt: fallbackStartedAtRef.current, sourceText: "",
          translatedText: "", context: fallbackContextRef.current, finalSource: null, finalRequested: false,
        };
        block.sourceText = interim;
        fallbackBlockRef.current = block;
        emit({ type: "source.partial", text: interim, sequence: block.sequence, startedAt: block.startedAt });
        setState("SPEAKING");
      }
    };
    recognition.onerror = (event) => {
      if (event.error === "aborted" || event.error === "no-speech") return;
      emit({ type: "error", message: `Browser transcription failed${event.error ? `: ${event.error}` : "."}`, recoverable: true });
    };
    recognition.onend = () => {
      if (!fallbackActiveRef.current || pausedRef.current || intentionalCloseRef.current) return;
      flushFallbackBlock();
      fallbackFinalIndexesRef.current = new Set();
      fallbackRestartRef.current = window.setTimeout(() => {
        try { recognition.start(); } catch { /* already restarting */ }
      }, 250);
    };
    speechRef.current = recognition;
    recognition.start();
    emit({ type: "state", state: "LISTENING", provider: "qwen", message: "Browser transcription compatibility mode" });
    return true;
  }, [cleanupSocket, clearFallbackBlock, emit, flushFallbackBlock, queueFallbackFinal]);

  const startMicrophone = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot access a microphone.");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    const context = new AudioContext({ latencyHint: "interactive" });
    await context.audioWorklet.addModule("/audio/pcm-capture-worklet.js");
    const source = context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(context, "pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { targetSampleRate: SAMPLE_RATE, chunkSamples: CHUNK_SAMPLES },
    });
    const silent = context.createGain();
    silent.gain.value = 0;
    source.connect(worklet).connect(silent).connect(context.destination);
    worklet.port.onmessage = (event: MessageEvent<{ type?: string; pcm?: ArrayBuffer; value?: number }>) => {
      const payload = event.data;
      if (payload.type === "level" && typeof payload.value === "number") {
        setLevel(Math.min(1, payload.value * 5));
        if (DEBUG) setDebug((current) => ({ ...current, rms: payload.value ?? 0 }));
      } else if (payload.type === "pcm" && payload.pcm instanceof ArrayBuffer && !pausedRef.current) {
        sendChunk(payload.pcm);
      } else if (payload.type === "flushed") {
        flushPcmRef.current = null;
      }
    };
    flushPcmRef.current = () => new Promise((resolve) => {
      const timeout = window.setTimeout(resolve, 250);
      const original = worklet.port.onmessage;
      worklet.port.onmessage = (event: MessageEvent<{ type?: string; pcm?: ArrayBuffer; value?: number }>) => {
        original?.call(worklet.port, event);
        if (event.data.type === "flushed") { window.clearTimeout(timeout); resolve(); }
      };
      worklet.port.postMessage({ type: "flush" });
    });
    await context.resume();
    if (DEBUG) setDebug((current) => ({ ...current, micActive: true }));
    trace("microphone.ready", { inputRate: context.sampleRate, targetRate: SAMPLE_RATE, chunkSamples: CHUNK_SAMPLES });
    streamRef.current = stream;
    contextRef.current = context;
    workletRef.current = worklet;
    if (optionsRef.current.saveAudio && typeof MediaRecorder !== "undefined") {
      const recorder = new MediaRecorder(stream);
      recordingChunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size) recordingChunksRef.current.push(event.data); };
      recorderRef.current = recorder;
      recorder.start(1_000);
    }
  }, [sendChunk]);

  const start = useCallback(async () => {
    if (streamRef.current || fallbackActiveRef.current) return;
    intentionalCloseRef.current = false;
    pausedRef.current = false;
    queuedRef.current = [];
    setMessage("");
    setState("CONNECTING");
    try {
      if (shouldStartBrowserFallbackImmediately(window.location.hostname) && !optionsRef.current.saveAudio && startBrowserFallback()) return;
      await startMicrophone();
      try {
        await connect();
      } catch (error) {
        if (!startBrowserFallback()) throw error;
      }
    } catch (error) {
      const currentStream = streamRef.current as MediaStream | null;
      currentStream?.getTracks().forEach((track: MediaStreamTrack) => track.stop());
      recorderRef.current = null;
      recordingChunksRef.current = [];
      streamRef.current = null;
      contextRef.current?.close().catch(() => undefined);
      contextRef.current = null;
      if (DEBUG) setDebug((current) => ({ ...current, micActive: false, rms: 0 }));
      const permissionDenied = error instanceof DOMException && error.name === "NotAllowedError";
      const errorMessage = permissionDenied
        ? "Microphone access is required for live transcription."
        : error instanceof Error ? error.message : "Unable to start the lecture.";
      emit({ type: "error", message: errorMessage, recoverable: false });
      throw error;
    }
  }, [connect, emit, startBrowserFallback, startMicrophone]);

  const pause = useCallback(async () => {
    pausedRef.current = true;
    contextRef.current?.suspend().catch(() => undefined);
    if (fallbackActiveRef.current) speechRef.current?.stop();
    socketRef.current?.send(JSON.stringify({ type: "session.pause" }));
    setLevel(0);
    flushFallbackBlock();
    await Promise.race([waitForFallbackWork(), new Promise<void>((resolve) => window.setTimeout(resolve, 20_000))]);
    fallbackEpochRef.current += 1;
    setState("PAUSED");
  }, [flushFallbackBlock, waitForFallbackWork]);

  const resume = useCallback(() => {
    pausedRef.current = false;
    contextRef.current?.resume().catch(() => undefined);
    if (fallbackActiveRef.current) {
      fallbackEpochRef.current += 1;
      clearFallbackBlock();
      fallbackFinalIndexesRef.current = new Set();
      try { speechRef.current?.start(); } catch { /* already active */ }
    }
    socketRef.current?.send(JSON.stringify({ type: "session.resume" }));
    setState("LISTENING");
  }, [clearFallbackBlock]);

  const changeProvider = useCallback((provider: ProviderPreference) => {
    socketRef.current?.send(JSON.stringify({ type: "provider.change", provider }));
  }, []);

  const end = useCallback(async () => {
    intentionalCloseRef.current = true;
    setState("ENDING");
    const socket = socketRef.current;
    await flushPcmRef.current?.();
    pausedRef.current = true;
    await contextRef.current?.suspend().catch(() => undefined);
    flushFallbackBlock();
    if (fallbackRestartRef.current !== null) window.clearTimeout(fallbackRestartRef.current);
    fallbackRestartRef.current = null;
    speechRef.current?.stop();
    speechRef.current = null;
    await Promise.race([waitForFallbackWork(), new Promise<void>((resolve) => window.setTimeout(resolve, 20_000))]);
    fallbackActiveRef.current = false;
    fallbackContextRef.current = "";
    fallbackEpochRef.current += 1;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "session.end" }));
      await new Promise<void>((resolve) => {
        const timeout = window.setTimeout(resolve, 16_000);
        socket.addEventListener("close", () => { window.clearTimeout(timeout); resolve(); }, { once: true });
      });
    }
    cleanupSocket();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        recorder.addEventListener("stop", () => resolve(), { once: true });
        recorder.stop();
      });
      if (recordingChunksRef.current.length) {
        optionsRef.current.onAudioReady(new Blob(recordingChunksRef.current, { type: recorder.mimeType || "audio/webm" }));
      }
    }
    recorderRef.current = null;
    recordingChunksRef.current = [];
    workletRef.current?.disconnect();
    workletRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    await contextRef.current?.close().catch(() => undefined);
    contextRef.current = null;
    queuedRef.current = [];
    flushPcmRef.current = null;
    setLevel(0);
    if (DEBUG) setDebug((current) => ({ ...current, micActive: false, rms: 0 }));
    setState("ENDED");
  }, [cleanupSocket, flushFallbackBlock, waitForFallbackWork]);

  useEffect(() => () => {
    intentionalCloseRef.current = true;
    fallbackActiveRef.current = false;
    fallbackContextRef.current = "";
    fallbackEpochRef.current += 1;
    clearFallbackBlock();
    if (fallbackRestartRef.current !== null) window.clearTimeout(fallbackRestartRef.current);
    speechRef.current?.abort();
    cleanupSocket();
    if (recorderRef.current?.state !== "inactive") recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    contextRef.current?.close().catch(() => undefined);
  }, [cleanupSocket, clearFallbackBlock]);

  return { state, level, message, metrics, debug, start, pause, resume, end, changeProvider };
}
