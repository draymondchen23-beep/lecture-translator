type RealtimeSocket = WebSocket & { accept?: () => void };

// The hosted Worker now owns this relay; the local Node development server uses
// the same protocol through server/realtime-proxy.ts.

export interface RealtimeEnvironment {
  DASHSCOPE_API_KEY?: string;
  DASHSCOPE_WORKSPACE_ID?: string;
  QWEN_REALTIME_MODEL?: string;
  QWEN_REALTIME_REGION?: string;
}

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
  let sourceText = "";
  let translatedText = "";
  let sequence = 0;
  let segmentStartedAt = 0;
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
  const finalize = () => {
    if (!sourceText.trim() && !translatedText.trim()) return;
    const endedAt = Date.now();
    jsonMessage(client, { type: "segment.final", sequence: sequence++, sourceText: sourceText.trim(), translatedText: translatedText.trim(), startedAt: segmentStartedAt || endedAt, endedAt, provider: "qwen" });
    sourceText = "";
    translatedText = "";
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
        jsonMessage(client, { type: "state", state: "SPEAKING", provider: "qwen" });
      } else if (type === "input_audio_buffer.speech_stopped") {
        jsonMessage(client, { type: "state", state: "PROCESSING", provider: "qwen" });
      } else if (type === "conversation.item.input_audio_transcription.text") {
        sourceText = `${typeof payload.text === "string" ? payload.text : ""}${typeof payload.stash === "string" ? payload.stash : ""}`;
        if (sourceText) jsonMessage(client, { type: "source.partial", text: sourceText, sequence, startedAt: segmentStartedAt || Date.now() });
      } else if (type === "conversation.item.input_audio_transcription.completed") {
        sourceText = typeof payload.transcript === "string" ? payload.transcript : sourceText;
      } else if (type === "response.text.text") {
        translatedText = `${typeof payload.text === "string" ? payload.text : ""}${typeof payload.stash === "string" ? payload.stash : ""}`;
        if (translatedText) jsonMessage(client, { type: "translation.partial", text: translatedText, sequence, startedAt: segmentStartedAt || Date.now() });
      } else if (type === "response.text.done") {
        translatedText = typeof payload.text === "string" ? payload.text : translatedText;
        finalize();
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
