/**
 * Stop a browser SpeechRecognition instance without discarding its final event
 * cycle. Resolves once `onend` runs, or after the bounded fallback timeout.
 */
export function stopBrowserRecognition(
  recognition,
  { timeoutMs = 1500, setTimeout: schedule = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout } = {},
) {
  return new Promise((resolve) => {
    const previousOnEnd = recognition.onend;
    let done = false;
    let timeoutId;

    const finish = () => {
      if (done) return;
      done = true;
      if (timeoutId !== undefined) cancel(timeoutId);
      if (recognition.onend === onEnd) recognition.onend = previousOnEnd;
      resolve();
    };

    function onEnd(...args) {
      try {
        if (typeof previousOnEnd === 'function') previousOnEnd.apply(this, args);
      } finally {
        finish();
      }
    }

    recognition.onend = onEnd;
    try {
      recognition.stop();
    } catch {
      finish();
      return;
    }

    if (done) return;
    timeoutId = schedule(finish, timeoutMs);
    if (done) cancel(timeoutId);
  });
}
