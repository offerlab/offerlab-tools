/**
 * Gemini's streaming answer (`streamGenerateContent?alt=sse`) folded back into the one JSON
 * `generateContent` would have returned. The proxy reads the stream so the connection to
 * Google carries bytes from the first seconds: a Worker's outbound fetch is proxied through
 * Cloudflare too, and one that stays silent for 100 seconds is answered 524 whatever the
 * client side is doing.
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

/** Reads a streaming Gemini response to the end and folds it. */
export async function foldStream(response) {
  return foldChunks(parseSse(await response.text()));
}
