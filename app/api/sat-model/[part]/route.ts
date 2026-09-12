const MODEL_URL = 'https://huggingface.co/segment-any-text/sat-3l-sm/resolve/137da054051ad9f1eac42025f758db4ac9f22535/model_optimized.onnx';
const MODEL_BYTES = 427756189;
const PART_BYTES = 20 * 1024 * 1024;

// Only fixed public weights: no caller-supplied URL, transcript or credentials.
// A bounded HTTP range is streamed, never buffered or used for server inference.
export async function GET(request: Request) {
  const match = new URL(request.url).pathname.match(/\/sat-model\/part-(\d{2})\.bin$/);
  const part = match ? Number(match[1]) : -1;
  if (part < 0 || part >= Math.ceil(MODEL_BYTES / PART_BYTES)) return new Response('Unknown model part', { status: 404 });
  const start = part * PART_BYTES;
  const end = Math.min(start + PART_BYTES, MODEL_BYTES) - 1;
  try {
    const upstream = await fetch(MODEL_URL, {
      headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' },
      signal: AbortSignal.timeout(45_000),
    });
    if (upstream.status !== 206 || upstream.headers.get('content-range') !== `bytes ${start}-${end}/${MODEL_BYTES}`) {
      await upstream.body?.cancel();
      return new Response('Model range unavailable', { status: 502, headers: { 'Cache-Control': 'no-store' } });
    }
    return new Response(upstream.body, { headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(end - start + 1),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    } });
  } catch {
    return new Response('Model download unavailable', { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
