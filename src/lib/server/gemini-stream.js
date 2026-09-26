/**
 * Gemini's streaming answer (`streamGenerateContent?alt=sse`) folded back into the one JSON
 * `generateContent` would have returned. The proxy reads the stream so the connection to
 * Google carries bytes from the first seconds: a Worker's outbound fetch is proxied through
 * Cloudflare too, and one that stays silent for 100 seconds is answered 524 whatever the
 * client side is doing. `askGemini` is the proxy's one call, with its deadlines.
 */

/** Every `data:` payload of an SSE body, parsed, in order. */
export function parseSse(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (!data || data === '[DONE]') continue;
    try {
      events.push(JSON.parse(data));
    } catch { /* a partial or keepalive line */ }
  }
  return events;
}

/**
 * One response from many chunks: the text parts concatenated in order (thought parts kept
 * apart, as the client filters them), the last grounding metadata, finish reason, usage and
 * model seen. An error chunk becomes the response's error.
 */
export function foldChunks(chunks) {
  const parts = [];
  let last = null;
  let groundingMetadata = null;
  let finishReason = null;
  let error = null;
  for (const chunk of chunks) {
    if (chunk?.error) { error = chunk.error; continue; }
    const candidate = chunk?.candidates?.[0];
    if (!candidate) continue;
    for (const part of candidate.content?.parts || []) {
      const previous = parts[parts.length - 1];
      if (typeof part.text === 'string' && previous && typeof previous.text === 'string' && !!previous.thought === !!part.thought && Object.keys(part).every(k => k === 'text' || k === 'thought')) {
        previous.text += part.text;
      } else {
        parts.push({ ...part });
      }
    }
    if (candidate.groundingMetadata) groundingMetadata = candidate.groundingMetadata;
    if (candidate.finishReason) finishReason = candidate.finishReason;
    last = chunk;
  }
  if (error && !parts.length) return { error: error.message || 'Gemini stream failed', status: error.code || 502 };
  return {
    candidates: [{ content: { role: 'model', parts }, ...(groundingMetadata ? { groundingMetadata } : {}), ...(finishReason ? { finishReason } : {}), index: 0 }],
    ...(last?.usageMetadata ? { usageMetadata: last.usageMetadata } : {}),
    ...(last?.modelVersion ? { modelVersion: last.modelVersion } : {})
  };
}

/**
 * Reads a streaming Gemini response to the end and folds it. `onAnswer` is called once, when the
 * first event arrives: the moment Gemini has started answering.
 */
export async function foldStream(response, { onAnswer } = {}) {
  if (!response.body) return foldChunks(parseSse(await response.text()));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (onAnswer && text.includes('data:')) { onAnswer(); onAnswer = null; }
  }
  text += decoder.decode();
  return foldChunks(parseSse(text));
}

/** A kept-alive call that had not started answering in time: worth asking again. */
export class NoAnswerYet extends Error {
  constructor() {
    super('Gemini had not started answering');
    this.name = 'TimeoutError';
    this.firstAnswer = true;
  }
}

/**
 * One call to Gemini from the proxy: `{ ok, status, body }`, or a TimeoutError thrown. `stream`
 * reads a `streamGenerateContent?alt=sse` answer and folds it; the kept-alive path streams from
 * Google too, or the Worker's own fetch is the silent leg. `timeoutMs` bounds the whole call,
 * `firstAnswerMs` only the wait for the stream's first event (NoAnswerYet).
 */
export async function askGemini(endpoint, body, { stream = false, timeoutMs, firstAnswerMs = 0, fetchImpl = (...args) => fetch(...args) } = {}) {
  const controller = new AbortController();
  let unanswered = false;
  const overall = setTimeout(() => controller.abort(new DOMException('Gemini did not answer in time', 'TimeoutError')), timeoutMs);
  const first = firstAnswerMs && stream ? setTimeout(() => { unanswered = true; controller.abort(new NoAnswerYet()); }, firstAnswerMs) : null;
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Gemini Proxy] API error:', response.status, errorText);
      return { ok: false, status: response.status, body: { error: 'Gemini API request failed', details: errorText, status: response.status } };
    }
    const answer = stream ? await foldStream(response, { onAnswer: () => clearTimeout(first) }) : await response.json();
    if (answer?.error) return { ok: false, status: answer.status || 502, body: { error: answer.error, status: answer.status || 502 } };
    return { ok: true, status: 200, body: answer };
  } catch (err) {
    if (unanswered) throw new NoAnswerYet();
    if (controller.signal.aborted && err?.name !== 'TimeoutError') throw new DOMException('Gemini did not answer in time', 'TimeoutError');
    throw err;
  } finally {
    clearTimeout(overall);
    clearTimeout(first);
  }
}
