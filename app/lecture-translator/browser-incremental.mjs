export function splitWords(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

export function stableWords(previous, current, stable) {
  let length = 0;
  while (length < previous.length && length < current.length && previous[length].toLowerCase() === current[length].toLowerCase()) length += 1;
  return length > stable.length ? current.slice(0, length) : stable;
}

export function completedSentencePrefix(text) {
  const source = text.trim();
  const matches = [...source.matchAll(/[.!?]["')\]]*(?:\s+|$)/g)];
  const last = matches.at(-1);
  return last && last.index !== undefined ? source.slice(0, last.index + last[0].trimEnd().length).trim() : "";
}

export function newCompletedSentenceText({ sourceText = "", requestedSourcePrefix = "" }) {
  const completed = completedSentencePrefix(sourceText);
  if (!completed || !completed.startsWith(requestedSourcePrefix)) return "";
  return completed.slice(requestedSourcePrefix.length).trim();
}

export function appendAccurateTranslation(accumulated = "", next = "") {
  const current = accumulated.trim();
  const incoming = next.trim();
  if (!current || !incoming) return current || incoming;
  const currentChars = Array.from(current);
  const incomingChars = Array.from(incoming);
  for (let length = Math.min(currentChars.length, incomingChars.length); length > 0; length -= 1) {
    if (currentChars.slice(-length).join("") === incomingChars.slice(0, length).join("")) return `${current}${incomingChars.slice(length).join("")}`;
  }
  return `${current}${incoming}`;
}

export function contextTail(source, maxChars = 400) {
  const text = source.trim();
  if (text.length <= maxChars) return text;
  const tail = text.slice(-maxChars);
  const boundary = tail.search(/\s/);
  return boundary >= 0 ? tail.slice(boundary).trim() : tail;
}

export function shouldProcessBrowserResult({ fallbackActive, paused, intentionalClose }) {
  return fallbackActive && !paused && !intentionalClose;
}

export function shouldStartBrowserFallbackImmediately(hostname) {
  return typeof hostname === "string" && /\.chatgpt\.site$/i.test(hostname);
}

export function fallbackFinalCorrectionSegmentId(sessionId, sequence) {
  return `${sessionId}:${sequence}:final`;
}

export function fallbackRequestSegmentId(sessionId, sequence, requestIndex) {
  return `${sessionId}:${sequence}:${requestIndex}`;
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
