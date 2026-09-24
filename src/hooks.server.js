/**
 * Headers on the Worker's own responses, matching what Cloudflare Pages put on the old site's
 * pages: the HTML always revalidates (a deploy never leaves a browser holding new HTML against old
 * JS or CSS; the hashed assets under /_app/immutable are cached for a year by _headers), and the
 * two safety headers Pages added by default. The API routes set their own cache headers.
 */
export async function handle({ event, resolve }) {
  const response = await resolve(event);
  const type = response.headers.get('content-type') || '';
  if (type.startsWith('text/html')) {
    response.headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  }
  if (!response.headers.has('X-Content-Type-Options')) response.headers.set('X-Content-Type-Options', 'nosniff');
  if (!response.headers.has('Referrer-Policy')) response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return response;
}
