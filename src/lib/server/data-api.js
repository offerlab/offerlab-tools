/**
 * The /api/data/* routes, as one runtime-neutral handler shared by the Cloudflare Pages
 * function (functions/api/data/[[path]].js) and the Express dev server (server.js). Both parse
 * the request and hand over `{ method, segments, query, body, db }`; this answers with
 * `{ status, body }`, which they serialize.
 *
 *   GET    searches/:domain?products=N   the stored search, brands' catalogs trimmed to N
 *   PUT    searches/:domain              store a finished search (results, empty or error)
 *   GET    partners/:domain?limit=N      brands whose search recommended this domain
 *   GET    frequent?limit=N              the brands recommended most across recent searches
 *   GET    history?limit=N               recent searches, newest first
 *   POST   history        { domain }     a search just ran for this domain
 *   DELETE history/:domain               drop one; DELETE history drops them all
 *   GET    feedback?limit=N              the recent feedback corpus, oldest first
 *   POST   feedback       { searchId, inputUrl, rating, results }
 *   GET    drafts/:domain                OfferLab drafts built for a searched brand
 *   PUT    drafts/:domain { ...draft }   remember a draft (same stackId replaces)
 *   PATCH  drafts/:domain/:stackId { publishedUrl }
 *   DELETE drafts/:domain                forget a brand's drafts; DELETE drafts forgets all
 */
import * as store from './db.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function intParam(value, fallback, { min = 1, max = 500 } = {}) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function needDomain(segment) {
  const domain = store.canonicalDomain(decodeURIComponent(segment || ''));
  if (!domain) throw new HttpError(400, 'Missing or invalid domain');
  return domain;
}

function needBody(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Expected a JSON body');
  return body;
}

async function route({ method, segments, query, body, db }) {
  const [resource, first, second] = segments;

  switch (resource) {
    case 'searches': {
      const domain = needDomain(first);
      if (method === 'GET') {
        const search = await store.getSearch(db, domain, { products: intParam(query.products, store.DEFAULT_PRODUCTS_PER_BRAND, { min: 0 }) });
        return search ? { status: 200, body: search } : { status: 404, body: { error: 'No search stored for this domain' } };
      }
      if (method === 'PUT') return { status: 200, body: await store.putSearch(db, domain, needBody(body)) };
      break;
    }

    case 'partners': {
      if (method === 'GET' && first && !second) {
        return { status: 200, body: await store.listKnownPartners(db, needDomain(first), intParam(query.limit, store.DEFAULT_KNOWN_PARTNERS, { max: 50 })) };
      }
      break;
    }

    case 'frequent': {
      if (method === 'GET' && !first) return { status: 200, body: await store.listFrequentBrands(db, { limit: intParam(query.limit, store.DEFAULT_FREQUENT_LIMIT, { max: 100 }) }) };
      break;
    }

    case 'history': {
      if (method === 'GET' && !first) return { status: 200, body: await store.listHistory(db, intParam(query.limit, store.DEFAULT_HISTORY_LIMIT, { max: 100 })) };
      if (method === 'POST' && !first) {
        await store.touchHistory(db, needDomain(needBody(body).domain));
        return { status: 204 };
      }
      if (method === 'DELETE') {
        if (first) await store.removeHistory(db, needDomain(first));
        else await store.clearHistory(db);
        return { status: 204 };
      }
      break;
    }

    case 'feedback': {
      if (method === 'GET' && !first) return { status: 200, body: await store.listFeedback(db, intParam(query.limit, store.DEFAULT_FEEDBACK_LIMIT, { max: 1000 })) };
      if (method === 'POST' && !first) {
        const entry = needBody(body);
        if (!['positive', 'negative'].includes(entry.rating)) throw new HttpError(400, 'rating must be positive or negative');
        await store.addFeedback(db, entry);
        return { status: 204 };
      }
      break;
    }

    case 'drafts': {
      if (method === 'GET' && first && !second) return { status: 200, body: await store.listDrafts(db, needDomain(first)) };
      if (method === 'PUT' && first && !second) {
        const draft = needBody(body);
        if (!draft.stackId) throw new HttpError(400, 'A draft needs a stackId');
        return { status: 200, body: await store.putDraft(db, needDomain(first), draft) };
      }
      if (method === 'PATCH' && first && second) {
        needDomain(first);
        await store.setDraftPublishedUrl(db, decodeURIComponent(second), needBody(body).publishedUrl || null);
        return { status: 204 };
      }
      if (method === 'DELETE' && !second) {
        await store.deleteDrafts(db, first ? needDomain(first) : '');
        return { status: 204 };
      }
      break;
    }

    default:
      break;
  }
  throw new HttpError(404, 'No such data route');
}

const WRITES = ['POST', 'PUT', 'PATCH'];

/**
 * @param {object} req
 * @param {string} req.method
 * @param {string[]} req.segments  path after /api/data/, split on "/"
 * @param {Record<string,string>} req.query
 * @param {string} [req.contentType] the request's Content-Type header
 * @param {unknown} req.body       parsed JSON, or null
 * @param {object|null} req.db     the D1 binding; null when none is bound
 * @returns {Promise<{status:number, body?:unknown}>}
 */
export async function handleDataRequest(req) {
  if (!req.db) return { status: 503, body: { error: 'No database bound: the finder is running without persistence' } };
  // A write is JSON from the finder's own page. Without an allow-origin header the browser only lets
  // another site send a request that needs no preflight, and a JSON body is not one of those.
  if (WRITES.includes(req.method) && !/^application\/json\b/i.test(req.contentType || '')) {
    return { status: 415, body: { error: 'Writes take application/json' } };
  }
  try {
    return await route(req);
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
    console.error('[Data] Error:', err);
    return { status: 500, body: { error: 'Data store request failed' } };
  }
}
