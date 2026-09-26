/**
 * What one search took and what it cost: how long each step ran, every outside call it made,
 * Gemini's token usage as each answer reports it (`usageMetadata`), and an estimate in dollars.
 * The search wraps its `api` in a meter; the record it stores carries the meter's reading.
 *
 * Runtime-neutral, like the search itself.
 */

/**
 * List prices, USD, as published on 2026-09-26 (ai.google.dev/gemini-api/docs/pricing, paid tier,
 * prompts under 200k tokens). Output includes thinking. Grounding with Google Search on the 2.5
 * models is billed per grounded prompt, $35 per 1,000 past 1,500 free a day shared across Flash
 * and Flash-Lite; the estimate counts every grounded prompt as paid, which is what a day of crawl
 * comes to. SerpAPI is billed per search by plan; this is the Developer plan's ($75 for 5,000).
 * Jev and OpenGraph are counted, not priced.
 */
export const PRICES = {
  gemini: {
    'gemini-2.5-flash': { input: 0.30, output: 2.50 },
    'gemini-2.5-pro': { input: 1.25, output: 10.00 },
    'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 }
  },
  groundedPrompt: 0.035,
  serpSearch: 0.015
};

/** The model the Gemini proxy asks when the search names none (src/routes/api/gemini/+server.js). */
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

const COUNTED = ['serp', 'jev', 'catalog', 'socials', 'opengraph', 'page'];

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** A meter for one search: `api` is the search's api, metered; `reading()` what it has seen. */
export function createMeter(api, { clock = now } = {}) {
  const started = clock();
  const elapsed = () => Math.round(clock() - started);
  const steps = {};
  const marks = {};
  const calls = Object.fromEntries(COUNTED.map(name => [name, 0]));
  const gemini = [];

  const metered = { ...api };
  for (const name of COUNTED) {
    if (typeof api[name] !== 'function') continue;
    metered[name] = (...args) => { calls[name]++; return api[name](...args); };
  }
  if (typeof api.gemini === 'function') {
    // The answer is read here for its usage and handed on unchanged; the search reads it again.
    metered.gemini = async (body, model, options) => {
      const call = { label: options?.label || null, model: model || DEFAULT_GEMINI_MODEL, grounded: isGrounded(body), at: elapsed(), ms: null, ok: false };
      gemini.push(call);
      try {
        const response = await api.gemini(body, model, options);
        const text = await response.text();
        const data = readJson(text);
        Object.assign(call, usageOf(data), { ok: response.ok && !data?.error && Array.isArray(data?.candidates) });
        return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
      } finally {
        call.ms = elapsed() - call.at;
      }
    };
  }

  return {
    api: metered,
    /** Times `work` (a promise or a function returning one) as the named step. */
    async step(name, work) {
      const at = elapsed();
      try {
        return await (typeof work === 'function' ? work() : work);
      } finally {
        steps[name] = { at, ms: elapsed() - at };
      }
    },
    /** Notes the moment something happened, e.g. the brands reaching the screen. */
    mark(name) { marks[name] = elapsed(); },
    reading() { return reading({ durationMs: elapsed(), marks, steps, calls, gemini }); }
  };
}

function isGrounded(body) {
  return (body?.tools || []).some(tool => tool && ('google_search' in tool || 'googleSearch' in tool));
}

// The proxy's kept-alive answer starts with the spaces it pulsed while Gemini worked.
function readJson(text) {
  try { return JSON.parse(String(text).trim() || 'null'); } catch { return null; }
}

function usageOf(data) {
  const usage = data?.usageMetadata || {};
  return {
    input: (usage.promptTokenCount || 0) + (usage.toolUsePromptTokenCount || 0),
    output: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
    thoughts: usage.thoughtsTokenCount || 0,
    queries: data?.candidates?.[0]?.groundingMetadata?.webSearchQueries?.length || 0
  };
}

/** What a Gemini call cost at list prices: tokens in and out, and the grounded prompt if it was one. */
export function geminiCost(call, prices = PRICES) {
  const rate = prices.gemini[call.model] || prices.gemini[DEFAULT_GEMINI_MODEL];
  const tokens = ((call.input || 0) * rate.input + (call.output || 0) * rate.output) / 1e6;
  return tokens + (call.grounded && call.ok ? prices.groundedPrompt : 0);
}

const round = (value, places = 5) => Number(value.toFixed(places));

/** The meter's reading as the store keeps it. */
export function reading({ durationMs, marks = {}, steps = {}, calls = {}, gemini = [] }, prices = PRICES) {
  const sum = (key) => gemini.reduce((total, call) => total + (call[key] || 0), 0);
  const tokenCost = gemini.reduce((total, call) => total + geminiCost({ ...call, grounded: false }, prices), 0);
  const grounded = gemini.filter(call => call.grounded && call.ok).length;
  const cost = {
    gemini: round(tokenCost),
    grounding: round(grounded * prices.groundedPrompt),
    serp: round((calls.serp || 0) * prices.serpSearch)
  };
  return {
    durationMs,
    brandsReadyMs: marks.brandsReady ?? null,
    steps,
    gemini: {
      calls: gemini.length,
      groundedPrompts: grounded,
      groundedQueries: sum('queries'),
      inputTokens: sum('input'),
      outputTokens: sum('output'),
      thoughtTokens: sum('thoughts'),
      log: gemini.map(({ label, model, grounded: g, at, ms, ok, input, output, queries }) => ({ label, model, grounded: g, at, ms, ok, input: input || 0, output: output || 0, queries: queries || 0 }))
    },
    calls: { ...calls },
    cost: { ...cost, totalUsd: round(cost.gemini + cost.grounding + cost.serp) }
  };
}
