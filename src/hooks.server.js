/**
 * Headers on the Worker's own responses, matching what Cloudflare Pages put on the old site's
 * pages: the HTML always revalidates (a deploy never leaves a browser holding new HTML against old
 * JS or CSS; the hashed assets under /_app/immutable are cached for a year by _headers), and the
 * two safety headers Pages added by default. The API routes set their own cache headers.
 *
 * Every /api/* request passes the gate first (src/lib/server/gate.js), and the page hands out the
 * session cookie the gate asks the browser for.
 */
import { dev } from '$app/environment';
import { guardApi, needsSession, issueSession, sessionSecret, SESSION_COOKIE, SESSION_MAX_AGE_S } from '$lib/server/gate.js';

function address(event) {
  try {
    return event.getClientAddress();
  } catch {
    return '';
  }
}

async function setSession(event, vars) {
  event.cookies.set(SESSION_COOKIE, await issueSession(sessionSecret(vars)), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_S
  });
}

export async function handle({ event, resolve }) {
  const vars = event.platform?.env || {};
  const cookie = event.cookies.get(SESSION_COOKIE);
  let issued = false;

  if (event.url.pathname.startsWith('/api/')) {
    const { refusal, renew } = await guardApi({
      pathname: event.url.pathname,
      authorization: event.request.headers.get('authorization'),
      cookie,
      address: address(event),
      vars,
      dev
    });
    if (refusal) return refusal;
    if (renew) await setSession(event, vars);
  } else if (event.request.method === 'GET' && (await needsSession(cookie, vars))) {
    await setSession(event, vars);
    issued = true;
  }

  const response = await resolve(event);
  const type = response.headers.get('content-type') || '';
  if (type.startsWith('text/html')) {
    // A page that hands out a session is that visitor's alone; no shared cache may keep it.
    response.headers.set('Cache-Control', `${issued ? 'private' : 'public'}, max-age=0, must-revalidate`);
  }
  if (!response.headers.has('X-Content-Type-Options')) response.headers.set('X-Content-Type-Options', 'nosniff');
  if (!response.headers.has('Referrer-Policy')) response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return response;
}
