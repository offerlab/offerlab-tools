import { describe, expect, it } from 'vitest';
import { parseSse, foldChunks, askGemini } from '$lib/server/gemini-stream.js';

const chunk = (text, extra = {}) => ({ candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0, ...extra }] });

describe('the Gemini stream folded into one answer', () => {
  it('reads the data lines of an SSE body', () => {
    const body = 'data: {"a":1}\r\n\r\ndata: {"b":2}\n\n: keepalive\n\ndata: [DONE]\n\n';
    expect(parseSse(body)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('joins the text parts in order and keeps the last grounding, finish reason and usage', () => {
    const folded = foldChunks([
      chunk('{"brands": ['),
      { candidates: [{ content: { parts: [{ text: 'thinking', thought: true }] } }] },
      chunk('{"name": "Graza"}'),
      { ...chunk(']}', { finishReason: 'STOP', groundingMetadata: { groundingChunks: [{ web: { uri: 'https://graza.co', title: 'Graza' } }] } }), usageMetadata: { promptTokenCount: 10 }, modelVersion: 'gemini-2.5-flash' }
    ]);
    expect(folded.candidates[0].content.parts).toEqual([{ text: '{"brands": [' }, { text: 'thinking', thought: true }, { text: '{"name": "Graza"}]}' }]);
    expect(folded.candidates[0].groundingMetadata.groundingChunks).toHaveLength(1);
    expect(folded.candidates[0].finishReason).toBe('STOP');
    expect(folded.usageMetadata).toEqual({ promptTokenCount: 10 });
    expect(folded.modelVersion).toBe('gemini-2.5-flash');
  });

  it('turns a stream that only carried an error into an error', () => {
    expect(foldChunks([{ error: { code: 503, message: 'overloaded' } }])).toEqual({ error: 'overloaded', status: 503 });
  });
});

describe('askGemini', () => {
  const encoder = new TextEncoder();
  // A streamed answer whose events arrive at the given moments, ms after the call; it honours the abort.
  const streaming = (events) => async (url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      const timers = events.map(([at, payload]) => setTimeout(() => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        if (payload === events[events.length - 1][1]) controller.close();
      }, at));
      signal.addEventListener('abort', () => { timers.forEach(clearTimeout); controller.error(signal.reason); });
    }
  }), { status: 200 });

  it('lets an answer that has started run past the first-answer deadline', async () => {
    const fetchImpl = streaming([[20, chunk('{"a":')], [120, { ...chunk('1}'), usageMetadata: { promptTokenCount: 3 } }]]);
    const answer = await askGemini('https://gemini.test', {}, { stream: true, timeoutMs: 1000, firstAnswerMs: 60, fetchImpl });
    expect(answer.ok).toBe(true);
    expect(answer.body.candidates[0].content.parts[0].text).toBe('{"a":1}');
    expect(answer.body.usageMetadata).toEqual({ promptTokenCount: 3 });
  });

  it('gives up on a stream that has not started by the deadline, so it can be asked again', async () => {
    const fetchImpl = streaming([[200, chunk('late')]]);
    const error = await askGemini('https://gemini.test', {}, { stream: true, timeoutMs: 1000, firstAnswerMs: 40, fetchImpl }).catch(err => err);
    expect(error.firstAnswer).toBe(true);
    expect(error.name).toBe('TimeoutError');
  });

  it('holds the whole call to its overall budget', async () => {
    const fetchImpl = streaming([[10, chunk('{"a":')], [300, chunk('1}')]]);
    const error = await askGemini('https://gemini.test', {}, { stream: true, timeoutMs: 80, firstAnswerMs: 40, fetchImpl }).catch(err => err);
    expect(error.name).toBe('TimeoutError');
    expect(error.firstAnswer).toBeUndefined();
  });

  it('answers an error from Gemini as one', async () => {
    const fetchImpl = async () => new Response('quota', { status: 429 });
    expect(await askGemini('https://gemini.test', {}, { timeoutMs: 1000, fetchImpl })).toMatchObject({ ok: false, status: 429 });
  });
});
