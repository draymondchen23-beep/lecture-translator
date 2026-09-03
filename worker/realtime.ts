type RealtimeSocket = WebSocket & { accept?: () => void };
import { createQwenItemPairer } from "../app/lecture-translator/qwen-item-pairing.mjs";

// The hosted Worker now owns this relay; the local Node development server uses
// the same protocol through server/realtime-proxy.ts.

export interface RealtimeEnvironment {
  DASHSCOPE_API_KEY?: string;
  DASHSCOPE_WORKSPACE_ID?: string;
  QWEN_REALTIME_MODEL?: string;
  QWEN_REALTIME_REGION?: string;
}

type LiveItem = { itemId: string; responseId?: string; sourceText: string; translatedText: string; startedAt: number };

const MAX_AUDIO_QUEUE = 300;

function endpoint(env: RealtimeEnvironment) {
  const region = env.QWEN_REALTIME_REGION === "singapore" ? "ap-southeast-1" : "cn-beijing";
  const model = env.QWEN_REALTIME_MODEL || "qwen3.5-livetranslate-flash-realtime";
  // Workers' fetch performs the WebSocket upgrade from an HTTPS URL. The
  // Upgrade header below switches this request to a WebSocket connection.
  return `https://${env.DASHSCOPE_WORKSPACE_ID}.${region}.maas.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(model)}`;
}

function jsonMessage(socket: RealtimeSocket, payload: object) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function textFromEvent(data: unknown) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return "";
}

function errorText(value: unknown, fallback: string) {
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string") return value.message;
  return fallback;
}

function normalizedUpstreamText(...values: unknown[]) {
  return values.filter((value): value is string => typeof value === "string").join("").replace(/\s+/g, " ").trim();
}

function upstreamId(payload: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) if (typeof payload[key] === "string" && payload[key]) return payload[key] as string;
  return "";
}

export async function handleRealtimeUpgrade(request: Request, env: RealtimeEnvironment) {
  console.info("[CLIENT] Realtime upgrade", {
    apiKeyLoaded: Boolean(env.DASHSCOPE_API_KEY),
    workspaceLoaded: Boolean(env.DASHSCOPE_WORKSPACE_ID),
  });
  if (!request.headers.get("cookie")?.includes("lecture_session=")) return new Response("Authentication required", { status: 401 });
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade", { status: 426 });

  const Pair = (globalThis as unknown as { WebSocketPair?: new () => { 0: RealtimeSocket; 1: RealtimeSocket } }).WebSocketPair;
  if (!Pair) return new Response("WebSocket runtime is unavailable", { status: 501 });
  const pair = new Pair();
  const client = pair[0];
  const server = pair[1];
  server.accept?.();
  console.info("[CLIENT] Browser connected");

  const source = new URL(request.url).searchParams.get("source") || "en";
  const target = new URL(request.url).searchParams.get("target") || "zh";
  let upstream: RealtimeSocket | null = null;
  let upstreamReady = false;
  let closed = false;
  let ending = false;
  let vad = true;
  let terminology: Record<string, string> = {};
  let sequence = 0;
  let segmentStartedAt = 0;
  let activeItemId = "";
  const items = new Map<string, LiveItem>();
  const responseItems = new Map<string, string>();
  const itemPairer = createQwenItemPairer();
  let audioReceived = 0;
  let audioSent = 0;
  const queued: ArrayBuffer[] = [];

  const sendAudio = (audio: ArrayBuffer) => {
    if (!upstream || !upstreamReady || upstream.readyState !== WebSocket.OPEN) return;
    let binary = "";
    for (const byte of new Uint8Array(audio)) binary += String.fromCharCode(byte);
    upstream.send(JSON.stringify({ event_id: crypto.randomUUID(), type: "input_audio_buffer." + "append", audio: btoa(binary) }));
    audioSent += 1;
  };
  const flush = () => { queued.splice(0).forEach(sendAudio); };
  const item = (itemId: string) => {
    let value = items.get(itemId);
    if (!value) {
      value = { itemId, sourceText: "", translatedText: "", startedAt: segmentStartedAt || Date.now() };
      items.set(itemId, value);
    }
    return value;
  };
  const sourceItem = (payload: Record<string, unknown>) => {
    const itemId = upstreamId(payload, "item_id", "itemId", "conversation_item_id") || activeItemId || `speech:${crypto.randomUUID()}`;
    activeItemId = itemId;
    return item(itemId);
  };
  const translationItem = (payload: Record<string, unknown>) => {
    const responseId = upstreamId(payload, "response_id", "responseId");
    const itemId = itemPairer.resolve(payload) || (responseId && responseItems.get(responseId)) || activeItemId || upstreamId(payload, "item_id", "itemId", "conversation_item_id") || `speech:${crypto.randomUUID()}`;
    const value = item(itemId);
    if (responseId) {
      value.responseId = responseId;
      responseItems.set(responseId, itemId);
      itemPairer.rememberResponse(payload, itemId);
    }
    return value;
  };
  const partial = (type: "source.partial" | "translation.partial", text: string, value: LiveItem) => {
    if (text) jsonMessage(client, { type, text, sequence, startedAt: value.startedAt, itemId: value.itemId, ...(value.responseId ? { responseId: value.responseId } : {}) });
  };
  const finalize = (itemId?: string) => {
    const ids = itemId ? [itemId] : [...items.keys()];
    for (const id of ids) {
      const value = items.get(id);
      if (!value || (!value.sourceText && !value.translatedText)) continue;
      const endedAt = Date.now();
      jsonMessage(client, { type: "segment.final", sequence: sequence++, sourceText: value.sourceText, translatedText: value.translatedText, startedAt: value.startedAt || endedAt, endedAt, provider: "qwen", itemId: value.itemId, ...(value.responseId ? { responseId: value.responseId } : {}) });
      items.delete(id);
      if (value.responseId) responseItems.delete(value.responseId);
      itemPairer.forgetSource(id);
      if (activeItemId === id) activeItemId = "";
    }
    segmentStartedAt = 0;
  };
  const fail = (message: string) => {
    if (closed || ending) return;
    jsonMessage(client, { type: "error", message: `${message} Audio is being preserved locally.`, recoverable: true });
    jsonMessage(client, { type: "state", state: "ERROR", provider: "qwen" });
  };

  const connect = async () => {
    if (!env.DASHSCOPE_API_KEY || !env.DASHSCOPE_WORKSPACE_ID) {
      jsonMessage(client, { type: "error", message: "Qwen realtime translation is not configured on the server.", recoverable: false });
      jsonMessage(client, { type: "state", state: "ERROR", provider: "qwen" });
      return;
    }
    jsonMessage(client, { type: "state", state: "CONNECTING", provider: "qwen" });
    console.info("[QWEN] Connecting", { region: env.QWEN_REALTIME_REGION || "beijing" });
    const response = await fetch(endpoint(env), { headers: { Authorization: `Bearer ${env.DASHSCOPE_API_KEY}`, Upgrade: "websocket" } });
    const socket = (response as Response & { webSocket?: RealtimeSocket }).webSocket;
    console.info("[QWEN] Upgrade response", { status: response.status, hasSocket: Boolean(socket) });
    if (response.status !== 101 || !socket) throw new Error(`Qwen WebSocket handshake failed (${response.status}).`);
    upstream = socket;
    socket.accept?.();
    socket.addEventListener("message", (event) => {
      const raw = textFromEvent(event.data);
      if (!raw) return;
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
      const type = typeof payload.type === "string" ? payload.type : "unknown";
      if (type === "session.created" || type === "session.updated" || type === "error") console.info("[QWEN EVENT]", type);
      if (type === "session.updated") {
        upstreamReady = true;
        flush();
        jsonMessage(client, { type: "state", state: "LISTENING", provider: "qwen" });
      } else if (type === "input_audio_buffer.speech_started") {
        segmentStartedAt = Date.now();
        activeItemId = `speech:${crypto.randomUUID()}`;
        item(activeItemId);
        jsonMessage(client, { type: "state", state: "SPEAKING", provider: "qwen" });
      } else if (type === "input_audio_buffer.speech_stopped") {
        jsonMessage(client, { type: "state", state: "PROCESSING", provider: "qwen" });
      } else if (type === "conversation.item.created") {
        itemPairer.captureCreated(payload);
      } else if (type === "conversation.item.input_audio_transcription.text") {
        const value = sourceItem(payload);
        value.sourceText = normalizedUpstreamText(payload.text, payload.stash);
        partial("source.partial", value.sourceText, value);
      } else if (type === "conversation.item.input_audio_transcription.completed") {
        const value = sourceItem(payload);
        value.sourceText = normalizedUpstreamText(payload.transcript) || value.sourceText;
      } else if (type === "response.text.text") {
        const value = translationItem(payload);
        value.translatedText = normalizedUpstreamText(payload.text, payload.stash);
        partial("translation.partial", value.translatedText, value);
      } else if (type === "response.text.done") {
        const value = translationItem(payload);
        value.translatedText = normalizedUpstreamText(payload.text) || value.translatedText;
        finalize(value.itemId);
      } else if (type === "session.finished") {
        finalize();
        jsonMessage(client, { type: "state", state: "ENDED", provider: "qwen" });
        client.close(1000, "lecture ended");
      } else if (type === "error" || type === "conversation.item.input_audio_transcription.failed") fail(errorText(payload.error, "Qwen realtime translation failed."));
    });
    socket.addEventListener("close", () => { if (!ending && !closed) fail("Qwen disconnected."); });
    socket.addEventListener("error", () => fail("Qwen WebSocket error."));
    socket.send(JSON.stringify({
      event_id: crypto.randomUUID(), type: "session.update", session: {
        modalities: ["text"], sample_rate: 16000, input_audio_format: "pcm",
        input_audio_transcription: { model: "qwen3-asr-flash-realtime", ...(source === "auto" ? {} : { language: source }) },
        translation: { language: target, ...(Object.keys(terminology).length ? { corpus: { phrases: terminology } } : {}) },
        turn_detection: vad ? { type: "server_vad", threshold: 0.2, silence_duration_ms: 480 } : null,
      },
    }));
  };

  server.addEventListener("message", async (event) => {
    if (typeof event.data !== "string") {
      const buffer = event.data instanceof ArrayBuffer ? event.data : await event.data.arrayBuffer();
      audioReceived += 1;
      if (!upstreamReady) { queued.push(buffer); if (queued.length > MAX_AUDIO_QUEUE) queued.shift(); } else sendAudio(buffer);
      if (audioReceived % 25 === 0) jsonMessage(client, { type: "metrics", audioChunks: audioReceived, audioSent, audioQueued: queued.length, partialEvents: 0, finalEvents: sequence, latency: 0 });
      return;
    }
    let control: { type?: unknown; vad?: unknown; terminology?: unknown };
    try { control = JSON.parse(event.data) as { type?: unknown; vad?: unknown; terminology?: unknown }; } catch { return; }
    if (control.type === "session.start") {
      console.info("[CLIENT] Session start");
      vad = control.vad !== false;
      if (control.terminology && typeof control.terminology === "object" && !Array.isArray(control.terminology)) terminology = control.terminology as Record<string, string>;
      try { await connect(); } catch (error) {
        const message = errorText(error, "Unable to connect to Qwen realtime.");
        console.error("[QWEN] Connection failed", message);
        fail(message);
      }
    } else if (control.type === "session.pause") jsonMessage(client, { type: "state", state: "PAUSED", provider: "qwen" });
    else if (control.type === "session.resume") jsonMessage(client, { type: "state", state: upstreamReady ? "LISTENING" : "CONNECTING", provider: "qwen" });
    else if (control.type === "session.end") {
      ending = true;
      jsonMessage(client, { type: "state", state: "PROCESSING", provider: "qwen" });
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ event_id: crypto.randomUUID(), type: "session.finish" }));
      else { finalize(); jsonMessage(client, { type: "state", state: "ENDED", provider: "qwen" }); client.close(1000, "lecture ended"); }
    }
  });
  server.addEventListener("close", () => { closed = true; upstream?.close(1000, "client closed"); });

  const init = { status: 101, webSocket: client } as unknown as ResponseInit;
  return new Response(null, init);
}
