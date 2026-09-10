import assert from 'node:assert/strict';
import test from 'node:test';
import { stopBrowserRecognition } from '../app/lecture-translator/browser-recognition-stop.mjs';

function fakeTimers() {
  let nextId = 0;
  const jobs = new Map();
  const cleared = [];
  return {
    cleared,
    setTimeout(callback, delay) {
      const id = ++nextId;
      jobs.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
      jobs.delete(id);
    },
    run() {
      for (const [id, job] of jobs) {
        jobs.delete(id);
        job.callback();
      }
    },
  };
}

test('handles a synchronous onend from stop and restores the prior handler', async () => {
  let ended = 0;
  const recognition = {
    onend() { ended += 1; },
    stop() { this.onend('ended'); },
  };
  const previous = recognition.onend;

  await stopBrowserRecognition(recognition);

  assert.equal(ended, 1);
  assert.equal(recognition.onend, previous);
});

test('leaves final results available until the asynchronous end event', async () => {
  const timers = fakeTimers();
  const events = [];
  const recognition = {
    onend() { events.push('end'); },
    onresult() { events.push('final-result'); },
    stop() {},
  };
  const stopped = stopBrowserRecognition(recognition, timers);

  recognition.onresult();
  recognition.onend();
  await stopped;

  assert.deepEqual(events, ['final-result', 'end']);
  assert.deepEqual(timers.cleared, [1]);
});

test('resolves on its fallback timeout and restores the prior handler', async () => {
  const timers = fakeTimers();
  const recognition = { onend: () => {}, stop() {} };
  const previous = recognition.onend;
  const stopped = stopBrowserRecognition(recognition, { ...timers, timeoutMs: 42 });

  timers.run();
  await stopped;

  assert.equal(recognition.onend, previous);
  assert.deepEqual(timers.cleared, [1]);
});

test('settles cleanly when stop throws', async () => {
  const timers = fakeTimers();
  const recognition = { onend: () => {}, stop() { throw new Error('already stopped'); } };
  const previous = recognition.onend;

  await stopBrowserRecognition(recognition, timers);

  assert.equal(recognition.onend, previous);
  assert.deepEqual(timers.cleared, []);
});
