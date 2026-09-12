/**
 * Browser-only SaT runner.  The tokenizer package does not expose offsets, so
 * offsets are derived only when re-tokenising source prefixes proves them.
 */
const CLS_ID = 0;
const SEP_ID = 2;
// These are the local benchmark's SaT settings; wtpsplit-lite uses 0.25 for sm.
const DEFAULTS = { threshold: 0.25, stride: 128, blockSize: 256, batchSize: 32, weighting: 'hat' };

function float32ToHalf(value) {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, false);
  const bits = view.getUint32(0, false);
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x7fffff;
  if (exponent === 0xff) return sign | (mantissa ? 0x7e00 : 0x7c00);
  let halfExponent = exponent - 127 + 15;
  if (halfExponent > 30) return sign | 0x7c00;
  if (halfExponent <= 0) {
    if (halfExponent < -10) return sign;
    const significand = mantissa | 0x800000;
    const shift = 14 - halfExponent;
    let rounded = significand >>> shift;
    const remainder = significand & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (remainder > halfway || (remainder === halfway && (rounded & 1))) rounded += 1;
    return sign | rounded;
  }
  let roundedMantissa = (mantissa + 0xfff + ((mantissa >>> 13) & 1)) >>> 13;
  if (roundedMantissa === 0x400) {
    halfExponent += 1;
    roundedMantissa = 0;
  }
  return halfExponent > 30 ? sign | 0x7c00 : sign | (halfExponent << 10) | roundedMantissa;
}

function halfToFloat(bits) {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exponent = (bits >>> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return mantissa ? sign * mantissa * 2 ** -24 : sign * 0;
  if (exponent === 31) return mantissa ? NaN : sign * Infinity;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

function halfRound(value) {
  return halfToFloat(float32ToHalf(value));
}

function commonPrefixLength(left, right) {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index;
}

function codePointEnds(text) {
  const ends = [];
  for (let index = 0; index < text.length;) {
    index += text.codePointAt(index) > 0xffff ? 2 : 1;
    ends.push(index);
  }
  return ends;
}

/**
 * Return UTF-16 exclusive token offsets.  A token is accepted only when an
 * encoding of an exact source prefix has the same leading token IDs.  This is
 * deliberately slower than guessing from SentencePiece token strings, but it
 * preserves the reference tokenizer's offsets (including normalisation and
 * overlapping metaspace spans) or fails loudly.
 */
function firstCodePointEnd(text, start) {
  return start + (text.codePointAt(start) > 0xffff ? 2 : 1);
}

function wordStartBefore(text, end) {
  let start = end;
  while (start > 0) {
    const previous = start - (text.codePointAt(start - 1) >= 0xdc00 && text.codePointAt(start - 1) <= 0xdfff ? 2 : 1);
    if (/^\s$/u.test(text.slice(previous, start))) return start;
    start = previous;
  }
  return 0;
}

function validatedOffsets(tokenizer, text, ids, tokens = []) {
  const offsets = new Array(ids.length);
  let confirmed = 0;
  for (const end of codePointEnds(text)) {
    const prefixIds = tokenizer.encode(text.slice(0, end), { add_special_tokens: false }).ids;
    const matched = commonPrefixLength(ids, prefixIds);
    if (matched === confirmed + 1) {
      offsets[confirmed++] = end;
      continue;
    }
    // SentencePiece's standalone metaspace token (▁) spans the first source
    // code point of the following word in Rust tokenizers. Validate that exact
    // pair before reproducing its documented overlapping offset.
    if (matched === confirmed + 2 && tokens[confirmed] === '▁') {
      const start = wordStartBefore(text, end);
      const source = text.slice(start, end);
      const probe = tokenizer.encode(` ${source}`, { add_special_tokens: false }).ids;
      if (probe.length === 2 && probe[0] === ids[confirmed] && probe[1] === ids[confirmed + 1]) {
        offsets[confirmed++] = firstCodePointEnd(text, start);
        offsets[confirmed++] = end;
        continue;
      }
    }
    // tokenizers.js has no offsets and this source span cannot be proven.
    if (matched > confirmed) {
      throw new Error('Tokenizer offset validation is ambiguous for this text; refusing approximate sentence boundaries.');
    }
  }
  if (confirmed !== ids.length) {
    throw new Error(`Tokenizer offset validation failed: mapped ${confirmed}/${ids.length} tokens.`);
  }
  return offsets;
}

function chunksFor(tokenCount, blockSize, stride) {
  const chunks = [];
  for (let start = 0; ; start += stride) {
    let end = start + blockSize;
    if (end >= tokenCount) {
      end = tokenCount;
      start = Math.max(end - blockSize, 0);
      chunks.push([start, end]);
      return chunks;
    }
    chunks.push([start, end]);
  }
}

function chunkWeights(blockSize, weighting) {
  if (weighting === 'uniform') return Array(blockSize).fill(1);
  if (weighting !== 'hat') throw new TypeError(`Unsupported SaT weighting: ${weighting}`);
  if (blockSize === 1) return [1];
  return Array.from({ length: blockSize }, (_, index) => {
    const x = -1 + 1 / blockSize + (2 - 2 / blockSize) * index / (blockSize - 1);
    return halfRound(1 - Math.abs(halfRound(x)));
  });
}

function sentenceSlices(text, boundaries, stripWhitespace) {
  const sentences = [];
  let offset = 0;
  for (const boundary of boundaries) {
    let end = boundary + 1;
    while (end < text.length) {
      const point = text.codePointAt(end);
      const width = point > 0xffff ? 2 : 1;
      if (!/^\s$/u.test(text.slice(end, end + width))) break;
      end += width;
    }
    const sentence = stripWhitespace ? text.slice(offset, end).trim() : text.slice(offset, end);
    if (sentence) sentences.push(sentence);
    offset = end;
  }
  const tail = stripWhitespace ? text.slice(offset).trim() : text.slice(offset);
  if (tail) sentences.push(tail);
  return sentences;
}

function tensorDataToNumber(data, type) {
  if (type === 'float16' || data instanceof Uint16Array) return halfToFloat(data);
  return data;
}

export async function createEngine({ ort, Tokenizer, modelBytes, tokenizerJSON, tokenizerConfig = {}, backend = 'wasm' }) {
  if (!ort?.InferenceSession || !ort?.Tensor || !Tokenizer) throw new TypeError('ort and Tokenizer are required.');
  const tokenizer = new Tokenizer(tokenizerJSON, tokenizerConfig);
  const session = await ort.InferenceSession.create(modelBytes, { executionProviders: [backend] });
  const inputNames = new Set(session.inputNames || ['input_ids', 'attention_mask']);
  if (!inputNames.has('input_ids') || !inputNames.has('attention_mask')) {
    throw new Error(`Unexpected SaT ONNX inputs: ${(session.inputNames || []).join(', ')}`);
  }

  async function logitsFor(ids, options) {
    const blockSize = Math.min(options.blockSize, ids.length) > 510 ? 510 : Math.min(options.blockSize, ids.length);
    const chunks = chunksFor(ids.length, blockSize, options.stride);
    const weights = chunkWeights(blockSize, options.weighting);
    const sums = new Float32Array(ids.length);
    const counts = new Float32Array(ids.length);
    const sequence = blockSize + 2;
    for (let batchStart = 0; batchStart < chunks.length; batchStart += options.batchSize) {
      const batch = chunks.slice(batchStart, batchStart + options.batchSize);
      const inputIds = new BigInt64Array(batch.length * sequence);
      const attentionMask = new Uint16Array(batch.length * sequence);
      for (let row = 0; row < batch.length; row += 1) {
        const [start, end] = batch[row];
        const base = row * sequence;
        inputIds[base] = BigInt(CLS_ID);
        attentionMask[base] = 0x3c00;
        for (let token = start; token < end; token += 1) {
          inputIds[base + 1 + token - start] = BigInt(ids[token]);
          attentionMask[base + 1 + token - start] = 0x3c00;
        }
        inputIds[base + 1 + end - start] = BigInt(SEP_ID);
        attentionMask[base + 1 + end - start] = 0x3c00;
      }
      const output = await session.run({
        input_ids: new ort.Tensor('int64', inputIds, [batch.length, sequence]),
        attention_mask: new ort.Tensor('float16', attentionMask, [batch.length, sequence]),
      });
      const logits = output.logits;
      if (!logits) throw new Error('SaT ONNX output "logits" is missing.');
      const values = logits.data;
      for (let row = 0; row < batch.length; row += 1) {
        const [start, end] = batch[row];
        for (let token = start; token < end; token += 1) {
          const value = tensorDataToNumber(values[row * sequence + 1 + token - start], logits.type);
          // NumPy reference stores both accumulators and the final average as fp16.
          const weight = weights[token - start];
          sums[token] = halfRound(sums[token] + halfRound(weight * value));
          counts[token] = halfRound(counts[token] + weight);
        }
      }
    }
    return sums.map((sum, index) => halfRound(sum / counts[index]));
  }

  return {
    backend,
    async split(text, overrides = {}) {
      if (typeof text !== 'string') throw new TypeError('text must be a string.');
      const options = { ...DEFAULTS, ...overrides };
      if (!text) return { sentences: [], boundaries: [], probabilities: [] };
      if (text.normalize('NFKC') !== text) {
        throw new Error('Tokenizer offset mapping supports NFKC-stable text only; refusing normalized-source boundary approximation.');
      }
      const encoded = tokenizer.encode(text, { add_special_tokens: false });
      if (!encoded.ids.length) return { sentences: sentenceSlices(text, [], options.stripWhitespace), boundaries: [], probabilities: Array(text.length).fill(0) };
      const offsets = validatedOffsets(tokenizer, text, encoded.ids, encoded.tokens);
      const logits = await logitsFor(encoded.ids, options);
      const probabilities = Array(text.length).fill(0);
      for (let index = 0; index < offsets.length; index += 1) {
        probabilities[offsets[index] - 1] = 1 / (1 + Math.exp(-logits[index]));
      }
      const boundaries = probabilities.flatMap((probability, index) => probability > options.threshold ? [index] : []);
      return { sentences: sentenceSlices(text, boundaries, options.stripWhitespace), boundaries, probabilities };
    },
  };
}

export const __test__ = { float32ToHalf, halfToFloat, validatedOffsets, sentenceSlices, chunksFor, chunkWeights };
