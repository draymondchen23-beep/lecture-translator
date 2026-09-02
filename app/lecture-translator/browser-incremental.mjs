export function splitWords(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

export function stableWords(previous, current, stable) {
  let length = 0;
  while (length < previous.length && length < current.length && previous[length].toLowerCase() === current[length].toLowerCase()) length += 1;
  return length > stable.length ? current.slice(0, length) : stable;
}

export function uncommittedTail(source, committed) {
  return splitWords(source).slice(splitWords(committed).length).join(" ");
}

export function coalescePendingWords(pending, next) {
  return `${pending} ${next}`.trim();
}

export const MAX_INTERIM_TRANSLATIONS = 3;

export function hasSemanticBoundary(text) {
  return /[.!?]["')\]]*$/.test(text.trim());
}

export function isReadyStablePhrase(text) {
  return hasSemanticBoundary(text);
}

export function planInterimTranslation({ sourceText = "", stableText, interimCount = 0, lastPreviewText = "", maxInterims = MAX_INTERIM_TRANSLATIONS }) {
  const source = sourceText.trim();
  const stable = stableText.trim();
  if (!stable || interimCount >= maxInterims) return null;
  const wordCount = splitWords(stable).length;
  if (wordCount < 3 || stable === lastPreviewText) return null;
  if (wordCount <= 8) return stable === source ? { text: stable, mode: "replace" } : null;
  const previousWords = splitWords(lastPreviewText).length;
  if (!previousWords || wordCount - previousWords >= 7) return { text: stable, mode: "replace" };
  return null;
}

export function previewResultAction({ finalRequested, pendingPreviewText }) {
  if (finalRequested) return "discard";
  return pendingPreviewText ? "drain" : "publish";
}

export function contextTail(source, maxChars = 400) {
  const text = source.trim();
  if (text.length <= maxChars) return text;
  const tail = text.slice(-maxChars);
  const boundary = tail.search(/\s/);
  return boundary >= 0 ? tail.slice(boundary).trim() : tail;
}

export function contextForFastRequest(context, requestIndex) {
  return requestIndex === 0 ? context : "";
}

export function applyFinalCorrection(accumulated, correction) {
  return correction.trim() || accumulated;
}

export function nextFallbackRequestKind({ finalRequested, finalSource, pendingSource }) {
  if (finalRequested && finalSource) return "accurate";
  return pendingSource ? "fast" : null;
}

export function shouldProcessBrowserResult({ fallbackActive, paused, intentionalClose }) {
  return fallbackActive && !paused && !intentionalClose;
}

export function shouldStartBrowserFallbackImmediately(hostname) {
  return typeof hostname === "string" && /\.chatgpt\.site$/i.test(hostname);
}

export function fallbackRequestSegmentId(sessionId, sequence, requestIndex) {
  return `${sessionId}:${sequence}:${requestIndex}`;
}

export function fallbackFinalCorrectionSegmentId(sessionId, sequence) {
  return `${sessionId}:${sequence}:final`;
}

export function bestTranscript(result) {
  let transcript = "";
  let confidence = -Infinity;
  for (let index = 0; index < (result?.length || 0); index += 1) {
    const alternative = result[index];
    const text = alternative?.transcript?.trim();
    if (!text) continue;
    const score = typeof alternative.confidence === "number" ? alternative.confidence : -Infinity;
    if (!transcript || score > confidence) {
      transcript = text;
      confidence = score;
    }
  }
  return transcript;
}
