import { describe, expect, it } from 'vitest';
import { parseSse, foldChunks } from '$lib/server/gemini-stream.js';

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
