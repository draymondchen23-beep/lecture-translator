export const WARN_CHARS = 5_000;
export const MAX_CHARS = 20_000;
export const WARN_TOKENS = 2_000;
export const MAX_TOKENS = 5_000;
export const MAX_CONTEXT_CHARS = 400;

export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

export function validateIncrementalRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Invalid refinement request.", status: 400 };
  if ("transcript" in body || "history" in body || "segments" in body) return { error: "Only one incremental segment may be refined.", status: 400 };
  const lectureId = typeof body.lectureId === "string" ? body.lectureId.trim() : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const segmentId = typeof body.segmentId === "string" ? body.segmentId.trim() : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  // Kept only for backwards-compatible request validation. Qwen-MT has no
  // general prompt/context field, so callers must not rely on it for output.
  const context = body.context === undefined ? "" : typeof body.context === "string" ? body.context.trim() : null;
  const quality = body.quality === undefined ? "fast" : body.quality;
  if (!lectureId || !sessionId || !segmentId || !text) return { error: "lectureId, sessionId, segmentId, and one text segment are required.", status: 400 };
  if (context === null || context.length > MAX_CONTEXT_CHARS) return { error: "context must be a string up to 400 characters.", status: 400 };
  if (quality !== "fast" && quality !== "accurate") return { error: "quality must be fast or accurate.", status: 400 };
  const terminology = body.terminology && typeof body.terminology === "object" && !Array.isArray(body.terminology)
    ? Object.entries(body.terminology).filter(([source, target]) => typeof source === "string" && typeof target === "string" && source.length <= 160 && target.length <= 160).slice(0, 100)
    : [];
  if (terminology.reduce((total, [source, target]) => total + source.length + target.length, 0) > 4_000) return { error: "Terminology is too large for one incremental segment.", status: 413 };
  const terminologyKey = JSON.stringify(terminology.sort(([a], [b]) => a.localeCompare(b)));
  // Retain the legacy validation estimate so old callers receive the same
  // quota warning, although only `text` is sent upstream.
  const tokenEstimate = estimateTokens(text) + estimateTokens(context) + estimateTokens(terminology.flat().join(""));
  if (text.length > MAX_CHARS || tokenEstimate > MAX_TOKENS) return { error: "This segment exceeds the 20,000 character / 5,000 token refinement limit.", status: 413 };
  return { value: { lectureId, sessionId, segmentId, text, context, terminology, terminologyKey, quality, tokenEstimate, warning: text.length >= WARN_CHARS || tokenEstimate >= WARN_TOKENS } };
}

export function createIncrementalRefiner() {
  const MAX_CACHE_ENTRIES = 1_000;
  const MAX_PENDING_ENTRIES = 128;
  const cache = new Map();
  const pending = new Map();
  const counters = { requests: 0, externalRequests: 0, cacheHits: 0, measuredInputTokens: 0, measuredOutputTokens: 0, unknownUsageResponses: 0, inputChars: 0, outputChars: 0 };
  const snapshot = () => ({ ...counters });
  const keyFor = ({ text, terminologyKey = "", quality = "fast", provider = "qwen-mt", model = "", sourceLanguage = "English", targetLanguage = "Chinese" }) => `${provider}:${model}:${sourceLanguage}:${targetLanguage}:${quality}:${terminologyKey}:${text}`;

  return {
    usage: snapshot,
    async run(input, external) {
      counters.requests += 1;
      const key = keyFor(input);
      const existing = cache.get(key) || pending.get(key);
      if (existing) {
        counters.cacheHits += 1;
        const result = await existing;
        return { ...result, cacheHit: true, usage: snapshot() };
      }
      if (pending.size >= MAX_PENDING_ENTRIES) throw new Error("Translation queue is at capacity.");
      counters.externalRequests += 1;
      const task = Promise.resolve().then(external).then((result) => {
        const inputTokens = Number.isFinite(result.inputTokens) ? result.inputTokens : null;
        const outputTokens = Number.isFinite(result.outputTokens) ? result.outputTokens : null;
        if (inputTokens !== null) counters.measuredInputTokens += inputTokens;
        if (outputTokens !== null) counters.measuredOutputTokens += outputTokens;
        if (inputTokens === null || outputTokens === null) counters.unknownUsageResponses += 1;
        counters.inputChars += input.text.length;
        counters.outputChars += result.translation.length;
        const stored = { translation: result.translation, provider: result.provider, model: result.model, warning: input.warning, usage: { inputTokens, outputTokens, measured: inputTokens !== null && outputTokens !== null } };
        if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
        cache.set(key, Promise.resolve(stored));
        return stored;
      }).finally(() => pending.delete(key));
      pending.set(key, task);
      const result = await task;
      return { ...result, cacheHit: false, usage: snapshot() };
    },
  };
}
