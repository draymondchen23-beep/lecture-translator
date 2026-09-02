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
