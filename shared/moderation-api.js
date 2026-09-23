/**
 * POST /api/moderation, shared by the Pages function (functions/api/moderation.js) and the Express
 * dev server. Only an OfferLab developer may moderate: the caller sends their OfferLab token and
 * the server asks OfferLab which tools it grants, the same role check the finder's UI makes, so a
 * request that skips the UI gets no further.
 *
 *   { action: 'hide-products', domain }                     the brand's products are wrong
 *   { action: 'show-products', domain }                     undo that
 *   { action: 'remove-recommendation', searchDomain, domain } the brand does not belong in this search
 */
import { callMcp, isDeveloper, DEFAULT_OFFERLAB_HOST } from './offerlab.js';
import { hideProducts, showProducts, removeRecommendation } from './moderation.js';

async function isOfferLabDeveloper(token, host, fetchImpl) {
  const { status, data } = await callMcp({
    token, host, fetchImpl,
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
  });
  if (status !== 200) return false;
  return isDeveloper((data?.result?.tools || []).map(tool => tool.name));
}

/** @returns {Promise<{status:number, body:unknown}>} */
export async function handleModerationRequest({ method, authorization, body, db, host = DEFAULT_OFFERLAB_HOST, fetchImpl = (...args) => fetch(...args) }) {
  if (method !== 'POST') return { status: 405, body: { error: 'Method not allowed' } };
  if (!db) return { status: 503, body: { error: 'No database bound' } };

  const token = String(authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { status: 401, body: { error: 'Sign in to OfferLab to moderate results' } };
  if (!(await isOfferLabDeveloper(token, host, fetchImpl))) {
    return { status: 403, body: { error: 'Only OfferLab developers can moderate results' } };
  }

  try {
    switch (body?.action) {
      case 'hide-products': return { status: 200, body: await hideProducts(db, body.domain) };
      case 'show-products': return { status: 200, body: await showProducts(db, body.domain) };
      case 'remove-recommendation': return { status: 200, body: await removeRecommendation(db, body.searchDomain, body.domain) };
      default: return { status: 400, body: { error: 'Unknown action' } };
    }
  } catch (err) {
    return { status: 400, body: { error: err.message } };
  }
}
