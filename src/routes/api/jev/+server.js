/**
 * Jev proxy (TypeSafe's System One model): the key stays on the server. The body is the
 * evaluation request as TypeSafe takes it, `{ state, questions }` (src/lib/shared/jev.js), always
 * on JEV_MODEL. Same-origin only, like every route: the search calls it from the browser to grade
 * the brands it was handed, and the crawl calls TypeSafe directly.
 */
import { json, readJson, env, forwardUpstream } from '$lib/server/api.js';
import { JEV_ENDPOINT, JEV_MODEL } from '$lib/shared/jev.js';

// Jev reads 32k tokens of state; a candidate is a few hundred. Anything past this is not a
// candidate, and every question past this is not one of ours.
const MAX_STATE_CHARS = 20_000;
const MAX_QUESTIONS = 20;
const UPSTREAM_TIMEOUT_MS = 30_000;

export async function POST(event) {
  const forwarded = await forwardUpstream(event, 'TYPESAFE_API_KEY');
  if (forwarded) return forwarded;

  const apiKey = env(event.platform).TYPESAFE_API_KEY;
  if (!apiKey) return json({ error: 'Server misconfiguration' }, { status: 500 });

  const body = await readJson(event.request);
  const questions = body?.questions;
  if (body?.state == null || !questions || typeof questions !== 'object') return json({ error: 'state and questions are required' }, { status: 400 });
  if (JSON.stringify(body.state).length > MAX_STATE_CHARS) return json({ error: 'state too large' }, { status: 413 });
  if (Object.keys(questions).length > MAX_QUESTIONS) return json({ error: 'too many questions' }, { status: 400 });

  try {
    const response = await fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: body.state, questions, model: JEV_MODEL }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
    const answer = await response.json().catch(() => ({ error: 'Jev answered no JSON' }));
    return json(answer, { status: response.ok ? 200 : response.status, cache: 'no-store' });
  } catch (err) {
    console.error('[Jev Proxy] Error:', err);
    return json({ error: err?.name === 'TimeoutError' ? 'Jev did not answer in time' : 'Failed to reach Jev' }, { status: 504 });
  }
}
