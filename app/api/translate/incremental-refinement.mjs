export const WARN_CHARS = 5_000;
export const MAX_CHARS = 20_000;
export const WARN_TOKENS = 2_000;
export const MAX_TOKENS = 5_000;

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
  const quality = body.quality === undefined ? "fast" : body.quality;
  if (!lectureId || !sessionId || !segmentId || !text) return { error: "lectureId, sessionId, segmentId, and one text segment are required.", status: 400 };
  if (quality !== "fast" && quality !== "accurate") return { error: "quality must be fast or accurate.", status: 400 };
  const tokenEstimate = estimateTokens(text);
  if (text.length > MAX_CHARS || tokenEstimate > MAX_TOKENS) return { error: "This segment exceeds the 20,000 character / 5,000 token refinement limit.", status: 413 };
  return { value: { lectureId, sessionId, segmentId, text, quality, tokenEstimate, warning: text.length >= WARN_CHARS || tokenEstimate >= WARN_TOKENS } };
}

export function createIncrementalRefiner() {
  const cache = new Map();
  const pending = new Map();
  const counters = { requests: 0, externalRequests: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, inputChars: 0, outputChars: 0, estimatedCostUsd: 0 };
  const snapshot = () => ({ ...counters, estimatedCostUsd: Number(counters.estimatedCostUsd.toFixed(6)) });
  const keyFor = ({ lectureId, segmentId }) => `${lectureId}:${segmentId}`;

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
      counters.externalRequests += 1;
      const task = Promise.resolve().then(external).then((result) => {
        const inputTokens = Number.isFinite(result.inputTokens) ? result.inputTokens : input.tokenEstimate;
        const outputTokens = Number.isFinite(result.outputTokens) ? result.outputTokens : estimateTokens(result.translation);
        counters.inputTokens += inputTokens;
        counters.outputTokens += outputTokens;
        counters.inputChars += input.text.length;
        counters.outputChars += result.translation.length;
        // Conservative display-only estimate: $0.001 / 1K input, $0.003 / 1K output tokens. Verify against the active Qwen price card.
        counters.estimatedCostUsd += (inputTokens * 0.001 + outputTokens * 0.003) / 1_000;
        const stored = { translation: result.translation, provider: result.provider, warning: input.warning };
        cache.set(key, Promise.resolve(stored));
        return stored;
      }).finally(() => pending.delete(key));
      pending.set(key, task);
      const result = await task;
      return { ...result, cacheHit: false, usage: snapshot() };
    },
  };
}
