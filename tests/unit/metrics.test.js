import { describe, expect, it } from 'vitest';
import { createMeter, geminiCost, reading, PRICES } from '$lib/shared/metrics.js';

const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status });
// The proxy's kept-alive answer: the spaces it pulsed while Gemini worked, then the JSON.
const keptAlive = (payload) => new Response(`   ${JSON.stringify(payload)}`, { status: 200 });

function clock() {
  let t = 1000;
  const tick = (ms) => { t += ms; };
  return { now: () => t, tick };
}

describe('createMeter', () => {
  it('counts every outside call and reads each Gemini answer for its usage, handing it on unchanged', async () => {
    const time = clock();
    const answer = {
      candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, groundingMetadata: { webSearchQueries: ['a', 'b', 'c'] } }],
      usageMetadata: { promptTokenCount: 1000, toolUsePromptTokenCount: 500, candidatesTokenCount: 200, thoughtsTokenCount: 100 }
    };
    const api = {
      gemini: async () => { time.tick(4000); return keptAlive(answer); },
      serp: async () => json({}),
      jev: async () => json({}),
      catalog: async () => json({})
    };
    const meter = createMeter(api, { clock: time.now });
    const response = await meter.api.gemini({ tools: [{ google_search: {} }] }, undefined, { keepalive: true, label: 'Recommendations' });
    expect(JSON.parse((await response.text()).trim())).toEqual(answer);
    await meter.api.gemini({}, 'gemini-2.5-pro');
    await meter.api.serp('q=x');
    await meter.api.jev({});
    await meter.api.jev({});
    await meter.api.catalog('x.com');
    time.tick(1000);

    const metrics = meter.reading();
    expect(metrics.durationMs).toBe(9000);
    expect(metrics.calls).toMatchObject({ serp: 1, jev: 2, catalog: 1, socials: 0 });
    // Both answers carry the same usage; only the first call was grounded.
    expect(metrics.gemini).toMatchObject({ calls: 2, groundedPrompts: 1, groundedQueries: 6, inputTokens: 3000, outputTokens: 600, thoughtTokens: 200 });
    expect(metrics.gemini.log[0]).toEqual({ label: 'Recommendations', model: 'gemini-2.5-flash', grounded: true, at: 0, ms: 4000, ok: true, input: 1500, output: 300, queries: 3 });
    expect(metrics.gemini.log[1]).toMatchObject({ model: 'gemini-2.5-pro', grounded: false, at: 4000, ms: 4000 });
  });

  it('times named steps and marks moments', async () => {
    const time = clock();
    const meter = createMeter({}, { clock: time.now });
    time.tick(500);
    await meter.step('analysis', async () => { time.tick(2500); return 'profile'; });
    meter.mark('brandsReady');
    await expect(meter.step('broken', Promise.reject(new Error('down')))).rejects.toThrow('down');
    const metrics = meter.reading();
    expect(metrics.steps.analysis).toEqual({ at: 500, ms: 2500 });
    expect(metrics.steps.broken).toEqual({ at: 3000, ms: 0 });
    expect(metrics.brandsReadyMs).toBe(3000);
  });

  it('counts a Gemini call that failed, without its grounding or tokens', async () => {
    const meter = createMeter({ gemini: async () => keptAlive({ error: 'overloaded', status: 503 }) });
    await meter.api.gemini({ tools: [{ google_search: {} }] });
    const metrics = meter.reading();
    expect(metrics.gemini).toMatchObject({ calls: 1, groundedPrompts: 0, inputTokens: 0 });
    expect(metrics.cost.totalUsd).toBe(0);
  });
});

describe('the cost estimate', () => {
  it('prices tokens by model, each grounded prompt, and each SerpAPI search', () => {
    expect(geminiCost({ model: 'gemini-2.5-flash', input: 1e6, output: 1e6 })).toBeCloseTo(2.80);
    expect(geminiCost({ model: 'gemini-2.5-pro', input: 1e6, output: 1e6 })).toBeCloseTo(11.25);
    expect(geminiCost({ model: 'gemini-2.5-flash', grounded: true, ok: true, input: 0, output: 0 })).toBeCloseTo(PRICES.groundedPrompt);
    // An unknown model is priced as the proxy's default.
    expect(geminiCost({ model: 'gemini-next', input: 1e6, output: 0 })).toBeCloseTo(0.30);

    const metrics = reading({
      durationMs: 60_000,
      calls: { serp: 4 },
      gemini: [
        { model: 'gemini-2.5-flash', grounded: true, ok: true, input: 5000, output: 4000 },
        { model: 'gemini-2.5-pro', grounded: false, ok: true, input: 1300, output: 3000 }
      ]
    });
    expect(metrics.cost.grounding).toBeCloseTo(0.035);
    expect(metrics.cost.serp).toBeCloseTo(0.06);
    expect(metrics.cost.gemini).toBeCloseTo((5000 * 0.30 + 4000 * 2.50 + 1300 * 1.25 + 3000 * 10) / 1e6, 5);
    expect(metrics.cost.totalUsd).toBeCloseTo(metrics.cost.gemini + 0.035 + 0.06, 5);
  });
});
