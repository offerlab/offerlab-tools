/**
 * What every part of the finder's UI shares: the proxy configuration, domain and favicon helpers,
 * and the catalog fetch. Pure functions; nothing here touches the DOM at import time.
 */
import * as search from '$lib/shared/search.js';
import { httpApi } from '$lib/shared/search.js';
import { looksLikeDomain } from './resolve.js';

export const CONFIG = {
  // Every key is server-side: Gemini, SerpAPI and OpenGraph are proxied through /api/*.
  GEMINI_PROXY: '/api/gemini',
  SERPAPI_PROXY: '/api/serpapi',
  OPENGRAPH_PROXY: '/api/opengraph',
  CATALOG_PROXY: '/api/catalog',
  SOCIALS_PROXY: '/api/socials',
  CATALOG_CONCURRENCY: 6,
  SERP_FALLBACK_BRANDS: 5,
  CACHED_PRODUCTS_PER_BRAND: 24, // per brand in a stored search; the picker fetches the rest
  MAX_SEARCH_HISTORY: 10,
  BATCH_SIZE: 5,
  REQUEST_DELAY_MS: 200,
  FETCH_TIMEOUT_MS: 5000,
  FAVICON_PRIMARY: (domain) => `https://www.google.com/s2/favicons?domain=${domain}&sz=64`,
  FAVICON_FALLBACK: (domain) => `https://icons.duckduckgo.com/ip3/${domain}.ico`
};

// The finder's own /api/* proxies, as the shared search calls them.
export const searchApi = httpApi();

// A grey rounded square, for an <img> whose favicon never arrived.
export const FAVICON_PLACEHOLDER = 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22%23ccc%22><rect width=%2224%22 height=%2224%22 rx=%224%22/></svg>';

/** onerror handler for a favicon <img>: swaps in the placeholder once. */
export function faviconFallback(event) {
  const img = event.currentTarget || event.target;
  if (!img || img.src === FAVICON_PLACEHOLDER) return;
  img.onerror = null;
  img.src = FAVICON_PLACEHOLDER;
}

export function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function normalizeUrl(input) {
  if (input == null || typeof input !== 'string') return '';
  let url = input.trim().toLowerCase();
  url = url.replace(/^(https?:\/\/)?(www\.)?/, '');
  return url.split('/')[0];
}

export function extractDomain(url) {
  if (url == null || typeof url !== 'string' || !url.trim()) return '';
  try {
    const urlStr = url.trim();
    const fullUrl = urlStr.startsWith('http') ? urlStr : 'https://' + urlStr;
    return new URL(fullUrl).hostname.replace(/^www\./, '');
  } catch {
    return normalizeUrl(url);
  }
}

/** The brand's site with a scheme, for a link; '#' when there is none. */
export function fullUrlOf(url) {
  if (!url) return '#';
  return url.startsWith('http') ? url : `https://${url}`;
}

// A web address, with or without scheme, www. or a path. Anything else typed into the omnibar
// is a brand name and goes through resolve.js first.
export function isValidUrl(input) {
  return looksLikeDomain(input);
}

export function getFaviconUrl(domain) {
  return CONFIG.FAVICON_PRIMARY(domain);
}

export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

export function catalogThumbUrl(src, width = 160) {
  try {
    const url = new URL(src);
    if (url.hostname.endsWith('cdn.shopify.com')) {
      url.searchParams.set('width', String(width));
      return url.toString();
    }
  } catch {}
  return src;
}

export function fetchCatalog(domain, options) {
  return search.fetchCatalog(searchApi, domain, options);
}

// Other modules parse Gemini output through the search's parser.
export const parseJsonResponse = search.parseJsonResponse;
export const extractText = search.extractText;
