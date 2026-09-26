#!/usr/bin/env node
/**
 * Times one search end to end against a deployment's /api/* proxies, without storing it: every
 * outside call with when it started and how long it took, and each Gemini call's model, whether
 * it was grounded and its token usage.
 *
 *   node scripts/time-search.mjs swell.com [--base https://collabfinder.offerlab.com] [--json out.json] [--verbose]
 *
 * The search runs as the browser runs it (src/lib/shared/search.js), with the feedback, known
 * partners and well-trodden brands the deployment's store holds for it. It is a real search: it
 * costs what one search costs.
 */
import { writeFileSync } from 'node:fs';
import { discoverComplementaryBrands, httpApi } from '../src/lib/shared/search.js';

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const domain = args.find((arg, i) => !arg.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!domain) { console.error('usage: node scripts/time-search.mjs <domain> [--base URL] [--json FILE] [--verbose]'); process.exit(1); }
const base = option('base', 'https://collabfinder.offerlab.com');
const verbose = args.includes('--verbose');

const log = console.log;
if (!verbose) { console.log = () => {}; console.warn = () => {}; }

const t0 = performance.now();
const at = () => Math.round(performance.now() - t0);
const calls = [];

function geminiLabel(body) {
  const system = body?.systemInstruction?.parts?.[0]?.text || '';
  const prompt = body?.contents?.[0]?.parts?.[0]?.text || '';
  if (/comprehensive analysis/i.test(prompt)) return 'analysis';
  if (/EMERGING brands/.test(prompt)) return 'top-up';
  if (/creative director/i.test(system)) return 'unexpected';
  if (/asked for more/i.test(prompt)) return 'follow-up';
  if (/world-class brand collaboration curator/i.test(prompt)) return 'recommendations';
  return system.slice(0, 30) || prompt.slice(0, 30);
}

async function traced(url, init = {}) {
  const u = new URL(url);
  const call = { path: u.pathname.replace('/api/', ''), start: at() };
  calls.push(call);
  if (call.path === 'gemini') {
    const body = JSON.parse(init.body);
    call.label = geminiLabel(body);
    call.model = u.searchParams.get('model') || 'gemini-2.5-flash';
    call.grounded = JSON.stringify(body.tools || []).includes('google_search');
  }
  try {
    const response = await fetch(url, init);
    call.status = response.status;
    call.ms = at() - call.start;
    // The kept-alive answer is read beside the search, as the browser reads it: the search's own
    // per-attempt timer stops at the headers, so waiting for the body here would change it.
    if (call.path === 'gemini') {
      response.clone().text().then(text => {
        const data = JSON.parse(text.trim() || '{}');
        call.usage = data.usageMetadata || null;
        call.queries = data.candidates?.[0]?.groundingMetadata?.webSearchQueries?.length ?? null;
        if (data.error) call.error = `${data.status || ''} ${data.error}`.trim();
      }).catch(err => { call.error = err.name === 'AbortError' ? 'aborted' : err.message; })
        .finally(() => { call.ms = at() - call.start; });
    }
    return response;
  } catch (err) {
    call.ms = at() - call.start;
    call.error = err.name === 'TimeoutError' ? 'timeout' : err.message;
    throw err;
  }
}

const data = async (path) => (await fetch(`${base}/api/data/${path}`)).json().catch(() => []);
const [feedback, knownPartners, frequentBrands] = await Promise.all([data('feedback'), data(`partners/${domain}`), data('frequent')]);

let brandsReadyMs = null;
let outcome;
try {
  const results = await discoverComplementaryBrands(domain, {
    api: httpApi(base, traced),
    feedback: Array.isArray(feedback) ? feedback : [],
    knownPartners: Array.isArray(knownPartners) ? knownPartners : [],
    frequentBrands: Array.isArray(frequentBrands) ? frequentBrands : [],
    onBrandsReady: () => { brandsReadyMs = at(); }
  });
  outcome = { brands: results.brands.length, withProducts: results.brands.filter(b => b.catalog?.products?.length).length, metrics: results.metrics || null, names: results.brands.map(b => `${b.name} [${b.lane}/${b.brandStage}]`) };
} catch (err) {
  outcome = { error: err.message };
}
const totalMs = at();

const gemini = calls.filter(c => c.path === 'gemini');
const count = (path) => calls.filter(c => c.path === path).length;
const summary = {
  domain, totalMs, brandsReadyMs,
  gemini: gemini.map(c => ({ label: c.label, model: c.model, grounded: c.grounded, start: c.start, ms: c.ms, status: c.status, error: c.error, queries: c.queries, in: c.usage?.promptTokenCount, tool: c.usage?.toolUsePromptTokenCount, out: c.usage?.candidatesTokenCount, thoughts: c.usage?.thoughtsTokenCount })),
  counts: Object.fromEntries(['serpapi', 'jev', 'catalog', 'socials', 'opengraph', 'page'].map(p => [p, count(p)])),
  ...outcome
};

log(`\n${domain}: ${(totalMs / 1000).toFixed(1)}s total, brands on screen at ${brandsReadyMs == null ? '-' : (brandsReadyMs / 1000).toFixed(1) + 's'}${outcome.error ? `, FAILED: ${outcome.error}` : `, ${outcome.brands} brands (${outcome.withProducts} with products)`}`);
for (const c of summary.gemini) {
  log(`  gemini ${String(c.label).padEnd(16)} ${c.model.padEnd(18)} ${c.grounded ? 'grounded' : '        '} start ${(c.start / 1000).toFixed(1).padStart(5)}s  took ${(c.ms / 1000).toFixed(1).padStart(5)}s  in ${c.in ?? '-'} tool ${c.tool ?? '-'} out ${c.out ?? '-'} thoughts ${c.thoughts ?? '-'} queries ${c.queries ?? '-'}${c.error ? `  ERROR ${c.error}` : ''}`);
}
log(`  calls: ${JSON.stringify(summary.counts)}`);
if (outcome.metrics) log(`  recorded: ${JSON.stringify(outcome.metrics)}`);
const out = option('json');
if (out) writeFileSync(out, JSON.stringify({ ...summary, calls }, null, 2));
