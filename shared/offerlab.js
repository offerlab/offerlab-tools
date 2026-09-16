/**
 * Talking to OfferLab: OAuth and the MCP endpoint. Shared by the Express dev server and the
 * Cloudflare Pages functions. Runtime-neutral: only uses global fetch.
 *
 * Everything here is a proxy. /api/mcp answers a CORS preflight with no allow-origin header, so
 * the browser cannot call it from the finder's origin at all; the token round trip goes the same
 * way to keep one shape. The finder's backend holds nothing — the caller supplies the bearer
 * token on every request and the token lives in the browser's session storage.
 */

export const DEFAULT_OFFERLAB_HOST = 'https://shoptalk.offerlab.com';
const REQUEST_TIMEOUT_MS = 30000;

/**
 * The host's own /.well-known/oauth-authorization-server names app.offerlab.com — production —
 * for authorize, token and register, on every environment. Following it would send an operator to
 * sign in to the wrong OfferLab and return a token this host rejects. The endpoints exist on the
 * host itself and work, so they are addressed directly until that metadata is fixed (OL-3986).
 */
export function endpoints(host = DEFAULT_OFFERLAB_HOST) {
  const base = String(host).replace(/\/+$/, '');
  return {
    host: base,
    authorize: `${base}/oauth/authorize`,
    token: `${base}/oauth/token`,
    register: `${base}/oauth/register`,
    mcp: `${base}/api/mcp`,
    brand: (domain) => `${base}/demo/brands/${encodeURIComponent(domain)}`
  };
}

async function post(url, { body, headers = {}, fetchImpl = fetch, form = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json',
        'Accept': 'application/json',
        ...headers
      },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body)
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: 'invalid_response', error_description: text.slice(0, 300) };
    }
    return { status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dynamic client registration. Registers as a PUBLIC client: the finder is a static site with no
 * server-side session, so it has nowhere to keep a secret, and the acceptance criteria say none
 * may exist in its deployed code. The host advertises "none" as a token endpoint auth method.
 */
export function registerClient({ redirectUri, clientName, host, fetchImpl = fetch }) {
  return post(endpoints(host).register, {
    fetchImpl,
    body: {
      client_name: clientName || 'OfferLab collab finder',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp:read mcp:write'
    }
  });
}

/** Authorization code exchange and refresh both land here; the caller supplies the grant. */
export function exchangeToken({ params, host, fetchImpl = fetch }) {
  return post(endpoints(host).token, { fetchImpl, form: true, body: params });
}

/** One JSON-RPC call. The endpoint is stateless — no initialize handshake, no session header. */
export function callMcp({ token, payload, host, fetchImpl = fetch }) {
  return post(endpoints(host).mcp, {
    fetchImpl,
    body: payload,
    headers: { Authorization: `Bearer ${token}` }
  });
}
