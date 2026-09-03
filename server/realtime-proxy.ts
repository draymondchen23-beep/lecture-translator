import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { createServer, type Server as HttpServer } from "node:http";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import type { Plugin } from "vite";
import { createQwenItemPairer } from "../app/lecture-translator/qwen-item-pairing.mjs";

type ProxyConfig = {
  apiKey?: string;
  workspaceId?: string;
  model?: string;
  region?: string;
};

type ClientControl = { type?: unknown; vad?: unknown; terminology?: unknown };
type LiveItem = { itemId: string; responseId?: string; sourceText: string; translatedText: string; startedAt: number };

const MAX_AUDIO_QUEUE = 300;
const FINISH_TIMEOUT_MS = 15_000;

function qwenEndpoint(config: ProxyConfig) {
  const region = config.region === "singapore" ? "ap-southeast-1" : "cn-beijing";
  const model = config.model || "qwen3.5-livetranslate-flash-realtime";
  return `wss://${config.workspaceId}.${region}.maas.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(model)}`;
}

function asBuffer(data: RawData) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}

function send(client: WebSocket, payload: object) {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload));
}

function errorMessage(value: unknown, fallback: string) {
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

class QwenRelay {
  private upstream: WebSocket | null = null;
  private upstreamReady = false;
  private started = false;
  private ending = false;
  private closed = false;
  private vad = true;
  private terminology: Record<string, string> = {};
  private source = "en";
  private target = "zh";
  private queue: Buffer[] = [];
  private sequence = 0;
  private segmentStartedAt = 0;
  private activeItemId = "";
  private items = new Map<string, LiveItem>();
  private responseItems = new Map<string, string>();
  private itemPairer = createQwenItemPairer();
  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  private audioReceived = 0;
  private audioSent = 0;

  constructor(private client: WebSocket, private request: IncomingMessage, private config: ProxyConfig) {
    const url = new URL(request.url || "/", "http://localhost");
    this.source = url.searchParams.get("source") || "en";
    this.target = url.searchParams.get("target") || "zh";
  }

  async start() {
    const cookie = this.request.headers.cookie;
    if (!cookie) {
      send(this.client, { type: "error", message: "请先登录后再开始课堂。", recoverable: false });
      this.client.close(1008, "authentication required");
      return;
    }
    try {
      const authUrl = process.env.LECTURE_APP_ORIGIN ? `${process.env.LECTURE_APP_ORIGIN.replace(/\/$/, "")}/api/auth/session` : "http://127.0.0.1:3001/api/auth/session";
      const sessionResponse = await fetch(authUrl, { headers: { cookie }, signal: AbortSignal.timeout(3_000) });
      const session = await sessionResponse.json().catch(() => ({})) as { user?: { role?: string } | null };
      if (!sessionResponse.ok || !session.user || !["admin", "user"].includes(session.user.role || "")) {
        send(this.client, { type: "error", message: "登录状态已失效，请重新登录。", recoverable: false });
        this.client.close(1008, "authentication required");
        return;
      }
    } catch {
      send(this.client, { type: "error", message: "无法验证登录状态，请先启动应用服务。", recoverable: true });
      this.client.close(1011, "authentication unavailable");
      return;
    }
    console.info("[CLIENT] Connecting", { source: this.source, target: this.target });
    this.client.on("message", (data, isBinary) => void this.onClientMessage(data, isBinary));
    this.client.on("close", () => this.close());
    this.client.on("error", (error) => console.error("[CLIENT] Error", errorMessage(error, "WebSocket error")));
    send(this.client, { type: "state", state: "CONNECTING", provider: "qwen" });
  }

  private onClientMessage(data: RawData, isBinary: boolean) {
    if (isBinary) {
      if (this.ending || this.closed) return;
      const chunk = asBuffer(data);
      this.audioReceived += 1;
      if (!this.upstreamReady) {
        this.queue.push(chunk);
        if (this.queue.length > MAX_AUDIO_QUEUE) this.queue.shift();
      } else this.sendAudio(chunk);
      if (this.audioReceived % 25 === 0) this.sendMetrics();
      return;
    }
    let control: ClientControl;
    try { control = JSON.parse(asBuffer(data).toString("utf8")) as ClientControl; } catch { return; }
    if (control.type === "session.start") {
      this.vad = control.vad !== false;
      if (control.terminology && typeof control.terminology === "object" && !Array.isArray(control.terminology)) this.terminology = control.terminology as Record<string, string>;
      this.connect();
    } else if (control.type === "session.pause") {
      send(this.client, { type: "state", state: "PAUSED", provider: "qwen" });
    } else if (control.type === "session.resume" || control.type === "provider.change") {
      send(this.client, { type: "state", state: this.upstreamReady ? "LISTENING" : "CONNECTING", provider: "qwen" });
    } else if (control.type === "session.end") this.finish();
  }

  private connect() {
    if (this.started || this.closed || this.ending) return;
    this.started = true;
    if (!this.config.apiKey || !this.config.workspaceId) {
      console.error("[QWEN] Error: DASHSCOPE_API_KEY/WORKSPACE_ID missing");
      send(this.client, { type: "error", message: "Qwen realtime translation is not configured on the server.", recoverable: false });
      send(this.client, { type: "state", state: "ERROR", provider: "qwen" });
      return;
    }
    const endpoint = qwenEndpoint(this.config);
    console.info("[QWEN] Connecting", new URL(endpoint).host);
    const upstream = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${this.config.apiKey}` } });
    this.upstream = upstream;
    upstream.on("open", () => {
      console.info("[QWEN] OPEN");
      upstream.send(JSON.stringify({
        event_id: crypto.randomUUID(),
        type: "session.update",
        session: {
          modalities: ["text"],
          sample_rate: 16000,
          input_audio_format: "pcm",
          input_audio_transcription: { model: "qwen3-asr-flash-realtime", ...(this.source === "auto" ? {} : { language: this.source }) },
          translation: { language: this.target, ...(Object.keys(this.terminology).length ? { corpus: { phrases: this.terminology } } : {}) },
          turn_detection: this.vad ? { type: "server_vad", threshold: 0.2, silence_duration_ms: 480 } : null,
        },
      }));
    });
    upstream.on("message", (data, isBinary) => { if (!isBinary) this.onQwenMessage(asBuffer(data)); });
    upstream.on("error", (error) => this.fail(errorMessage(error, "Qwen WebSocket error")));
    upstream.on("close", () => {
      if (this.ending) this.complete();
      else if (!this.closed) this.fail("Qwen disconnected.");
    });
  }

  private sendAudio(chunk: Buffer) {
    if (!this.upstream || !this.upstreamReady || this.upstream.readyState !== WebSocket.OPEN) return;
    this.upstream.send(JSON.stringify({ event_id: crypto.randomUUID(), type: "input_audio_buffer.append", audio: chunk.toString("base64") }));
    this.audioSent += 1;
    if (this.audioSent % 25 === 0) {
      console.info("[QWEN] Audio", { received: this.audioReceived, sent: this.audioSent, queued: this.queue.length });
      this.sendMetrics();
    }
  }

  private flushQueue() {
    const queued = this.queue.splice(0);
    queued.forEach((chunk) => this.sendAudio(chunk));
    console.info("[QWEN] Audio queue flushed", { chunks: queued.length });
  }

  private onQwenMessage(data: Buffer) {
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(data.toString("utf8")) as Record<string, unknown>; } catch { return; }
    const type = typeof payload.type === "string" ? payload.type : "unknown";
    if (type === "session.created" || type === "session.updated") console.info(`[QWEN] ${type}`);
    if (type === "session.updated") {
      this.upstreamReady = true;
      this.flushQueue();
      send(this.client, { type: "state", state: "LISTENING", provider: "qwen" });
    } else if (type === "input_audio_buffer.speech_started") {
      this.segmentStartedAt = Date.now();
      this.activeItemId = `speech:${crypto.randomUUID()}`;
      this.item(this.activeItemId);
      send(this.client, { type: "state", state: "SPEAKING", provider: "qwen" });
    } else if (type === "input_audio_buffer.speech_stopped") {
      send(this.client, { type: "state", state: "PROCESSING", provider: "qwen" });
    } else if (type === "conversation.item.created") {
      this.itemPairer.captureCreated(payload);
    } else if (type === "conversation.item.input_audio_transcription.text") {
      const item = this.sourceItem(payload);
      item.sourceText = normalizedUpstreamText(payload.text, payload.stash);
      this.partial("source.partial", item.sourceText, item);
    } else if (type === "conversation.item.input_audio_transcription.completed") {
      const item = this.sourceItem(payload);
      item.sourceText = normalizedUpstreamText(payload.transcript) || item.sourceText;
    } else if (type === "response.text.text") {
      const item = this.translationItem(payload);
      item.translatedText = normalizedUpstreamText(payload.text, payload.stash);
      this.partial("translation.partial", item.translatedText, item);
    } else if (type === "response.text.done") {
      const item = this.translationItem(payload);
      item.translatedText = normalizedUpstreamText(payload.text) || item.translatedText;
      this.finalize(item.itemId);
    } else if (type === "session.finished") {
      this.finalize();
      this.complete();
    } else if (type === "error" || type === "conversation.item.input_audio_transcription.failed") {
      this.fail(errorMessage(payload.error, "Qwen realtime translation failed."));
    }
  }

  private item(itemId: string) {
    let item = this.items.get(itemId);
    if (!item) {
      item = { itemId, sourceText: "", translatedText: "", startedAt: this.segmentStartedAt || Date.now() };
      this.items.set(itemId, item);
    }
    return item;
  }

  private sourceItem(payload: Record<string, unknown>) {
    const itemId = upstreamId(payload, "item_id", "itemId", "conversation_item_id") || this.activeItemId || `speech:${crypto.randomUUID()}`;
    this.activeItemId = itemId;
    return this.item(itemId);
  }

  private translationItem(payload: Record<string, unknown>) {
    const responseId = upstreamId(payload, "response_id", "responseId");
    const itemId = this.itemPairer.resolve(payload) || (responseId && this.responseItems.get(responseId)) || this.activeItemId || upstreamId(payload, "item_id", "itemId", "conversation_item_id") || `speech:${crypto.randomUUID()}`;
    const item = this.item(itemId);
    if (responseId) {
      item.responseId = responseId;
      this.responseItems.set(responseId, itemId);
      this.itemPairer.rememberResponse(payload, itemId);
    }
    return item;
  }

  private partial(type: "source.partial" | "translation.partial", text: string, item: LiveItem) {
    if (text) send(this.client, { type, text, sequence: this.sequence, startedAt: item.startedAt, itemId: item.itemId, ...(item.responseId ? { responseId: item.responseId } : {}) });
  }

  private finalize(itemId?: string) {
    const ids = itemId ? [itemId] : [...this.items.keys()];
    for (const id of ids) this.finalizeItem(id);
  }

  private finalizeItem(itemId: string) {
    const item = this.items.get(itemId);
    if (!item || (!item.sourceText && !item.translatedText)) return;
    const endedAt = Date.now();
    send(this.client, { type: "segment.final", sequence: this.sequence++, sourceText: item.sourceText, translatedText: item.translatedText, startedAt: item.startedAt || endedAt, endedAt, provider: "qwen", itemId: item.itemId, ...(item.responseId ? { responseId: item.responseId } : {}) });
    this.items.delete(itemId);
    if (item.responseId) this.responseItems.delete(item.responseId);
    this.itemPairer.forgetSource(itemId);
    if (this.activeItemId === itemId) this.activeItemId = "";
    this.segmentStartedAt = 0;
    this.sendMetrics();
  }

  private sendMetrics() {
    send(this.client, { type: "metrics", audioChunks: this.audioReceived, audioSent: this.audioSent, audioQueued: this.queue.length, partialEvents: 0, finalEvents: this.sequence, latency: 0 });
  }

  private fail(reason: string) {
    if (this.closed || this.ending) return;
    console.error("[QWEN] Error", reason);
    send(this.client, { type: "error", message: `${reason} Audio is being preserved locally.`, recoverable: true });
    send(this.client, { type: "state", state: "ERROR", provider: "qwen" });
  }

  private finish() {
    if (this.ending || this.closed) return;
    this.ending = true;
    send(this.client, { type: "state", state: "PROCESSING", provider: "qwen" });
    if (!this.upstream || this.upstream.readyState !== WebSocket.OPEN) return this.complete();
    this.upstream.send(JSON.stringify({ event_id: crypto.randomUUID(), type: "session.finish" }));
    this.finishTimer = setTimeout(() => this.complete(), FINISH_TIMEOUT_MS);
  }

  private complete() {
    if (this.closed) return;
    this.finalize();
    send(this.client, { type: "state", state: "ENDED", provider: "qwen" });
    this.close();
  }

  private close() {
    if (this.closed) return;
    this.closed = true;
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.upstream?.close(1000, "lecture ended");
    if (this.client.readyState === WebSocket.OPEN) this.client.close(1000, "lecture ended");
  }
}

export function qwenRealtimeProxy(config: ProxyConfig, port = 3002): Plugin {
  const clients = new WebSocketServer({ noServer: true });
  return {
    name: "qwen-realtime-proxy",
    configureServer(server) {
      console.info(`[QWEN] Config DASHSCOPE_API_KEY=${config.apiKey ? "YES" : "NO"} DASHSCOPE_WORKSPACE_ID=${config.workspaceId ? "YES" : "NO"}`);
      clients.on("connection", (client, request) => new QwenRelay(client, request, config).start());
      const upgrade = (request: IncomingMessage, socket: Socket, head: Buffer) => {
        if (new URL(request.url || "/", "http://localhost").pathname !== "/api/lecture-realtime") return;
        clients.handleUpgrade(request, socket, head, (client) => clients.emit("connection", client, request));
      };
      // Keep the proxy on a standalone Node HTTP server. The Cloudflare
      // development server owns its own upgrade lifecycle and closes unknown
      // sockets before a long-lived upstream relay can finish connecting.
      const proxyServer: HttpServer = createServer((_request, response) => {
        response.writeHead(426, { "content-type": "text/plain" });
        response.end("WebSocket upgrade required");
      });
      proxyServer.on("upgrade", upgrade);
      proxyServer.listen(port, "127.0.0.1", () => console.info(`[QWEN] Local Node proxy listening ws://127.0.0.1:${port}/api/lecture-realtime`));
      return () => {
        void server;
        return () => {
          proxyServer.off("upgrade", upgrade);
          proxyServer.close();
          clients.close();
        };
      };
    },
  };
}

// Intentionally not invoked by the app or tests. It opens a Qwen WebSocket
// without sending audio, for a credential/connectivity smoke check when approved.
export function smokeQwenConnection(config: ProxyConfig) {
  return new Promise<void>((resolve, reject) => {
    if (!config.apiKey || !config.workspaceId) return reject(new Error("DASHSCOPE_API_KEY and DASHSCOPE_WORKSPACE_ID are required."));
    const socket = new WebSocket(qwenEndpoint(config), { headers: { Authorization: `Bearer ${config.apiKey}` } });
    socket.on("open", () => { socket.close(1000, "smoke test"); resolve(); });
    socket.on("error", reject);
  });
}
