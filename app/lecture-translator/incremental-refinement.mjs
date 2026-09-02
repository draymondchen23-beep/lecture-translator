/** Keeps realtime reconnects from submitting the same final segment twice. */
export function createFinalSegmentGate() {
  const sent = new Set();
  return {
    claim(lectureId, segmentId) {
      const key = `${lectureId}:${segmentId}`;
      if (sent.has(key)) return false;
      sent.add(key);
      return true;
    },
  };
}

export function shouldRefineFinal(event) {
  return Boolean(event && typeof event === "object" && event.type === "segment.final" && !event.refined && typeof event.sourceText === "string" && event.sourceText.trim());
}
