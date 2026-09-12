import assert from 'node:assert/strict';
import test from 'node:test';
import { SatCaptionAccumulator } from '../app/lecture-translator/sat-caption-accumulator.mjs';

const sentence = 'The nerve cell transmits information in a single direction';
const tail = 'It will transmit information from this side';
const split = async text => ({ boundaries: [text.indexOf('direction') + 'direction'.length - 1, text.length - 1] });

test('SaT requires two growing stable hypotheses plus right context, not final IDs or silence', async () => {
  const a = new SatCaptionAccumulator();
  assert.equal(a.update('r:0', `${sentence} ${tail}`, true, 0).commits.length, 0);
  assert.equal(a.advance(60_000).commits.length, 0);
  assert.equal((await a.segment(split)).commits.length, 0);
  assert.equal((await a.segment(split)).commits.length, 0);
  a.update('r:0', `${sentence} ${tail} to this side`, true, 2);
  const update = await a.segment(split);
  assert.deepEqual(update.commits.map(c => c.sourceText), [sentence]);
  assert.equal(update.displayText, `${tail} to this side`);
});

test('a withdrawn provisional cut never commits', async () => {
  const a = new SatCaptionAccumulator();
  a.update('0', `${sentence} ${tail}`, true);
  await a.segment(split);
  a.update('0', `${sentence} ${tail} again`, true);
  assert.equal((await a.segment(async () => ({ boundaries: [] }))).commits.length, 0);
});

test('ASR correction rejects an in-flight proposal without losing canonical words', async () => {
  const a = new SatCaptionAccumulator();
  a.update('0', `${sentence} ${tail}`, true);
  await a.segment(split);
  a.update('0', `${sentence} ${tail} again`, true);
  let resolve;
  const pending = a.segment(() => new Promise(r => { resolve = r; }));
  const corrected = 'The neuron sends a signal through the axon';
  a.update('0', corrected, true);
  resolve({ boundaries: [sentence.length - 1] });
  assert.equal((await pending).commits.length, 0);
  assert.equal(a.displayText(), corrected);
});

test('stop invalidates late output then retains corrected interim tail exactly once', async () => {
  const a = new SatCaptionAccumulator();
  a.update('0', `${sentence} ${tail}`, true);
  let resolve;
  const pending = a.segment(() => new Promise(r => { resolve = r; }));
  a.invalidate();
  a.update('0', `${sentence} ${tail} to the other side`, false);
  resolve({ boundaries: [sentence.length - 1] });
  assert.equal((await pending).commits.length, 0);
  const expected = a.displayText();
  const final = await a.segment(split, { force: true });
  assert.equal(final.commits.map(c => c.sourceText).join(' '), expected);
  assert.equal(a.displayText(), '');
  assert.equal((await a.segment(split, { force: true })).commits.length, 0);
});

test('word-exact cuts across result IDs preserve genuine repetition', async () => {
  const a = new SatCaptionAccumulator();
  a.update('0', 'very very', true);
  a.update('1', 'good neurons carry carry signals', true);
  const result = await a.segment(async () => ({ boundaries: [13, 0, -1, 999, 13] }), { force: true });
  assert.equal(result.commits.map(c => c.sourceText).join(' '), 'very very good neurons carry carry signals');
  assert.equal(a.displayText(), '');
});

test('failed model falls back and invalidates outstanding proposals', async () => {
  const a = new SatCaptionAccumulator();
  a.update('0', `${sentence} ${tail}`, true);
  let resolve;
  const pending = a.segment(() => new Promise(r => { resolve = r; }));
  const fallback = a.fallback(Date.now(), true);
  assert.equal(fallback.commits.map(c => c.sourceText).join(' '), `${sentence} ${tail}`);
  resolve({ boundaries: [sentence.length - 1] });
  assert.equal((await pending).commits.length, 0);
  assert.equal(a.displayText(), '');
});
