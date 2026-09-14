/**
 * Social account discovery for a storefront domain, ported from the main app's
 * Teams::BrandDnas::SocialUrl / SocialSources (Brand DNA extraction during onboarding).
 * Runtime-neutral: shared by the Express dev server, the Cloudflare function, and the
 * browser (for canonical URLs and handle normalization).
 */
import { normalizeDomain, hostCandidates } from './catalog.js';

const FETCH_TIMEOUT_MS = 10000;

// First non-blocklisted handle per platform wins. Order is the app's registry order.
export const SOCIAL_PATTERNS = {
  instagram: {
    domains: ['instagram.com'],
    handle: /instagram\.com\/([a-zA-Z0-9_.]{2,30})/i,
    blocklist: ['p', 'reel', 'reels', 'explore', 'stories', 'tv', 'accounts', 'about', 'developer', 'directory', 'privacy', 'terms', 'help', 'oauth', 'web']
  },
  tiktok: {
    domains: ['tiktok.com'],
    handle: /tiktok\.com\/@([a-zA-Z0-9_.]{2,30})/i,
    blocklist: ['discover', 'foryou', 'trending', 'tag', 'music', 'live', 'following']
  },
  twitter: {
    domains: ['twitter.com', 'x.com'],
    handle: /(?<![a-z0-9-])(?:twitter|x)\.com\/([a-zA-Z0-9_]{1,15})/i,
    blocklist: ['home', 'explore', 'notifications', 'messages', 'compose', 'i', 'intent', 'search', 'settings', 'about', 'tos', 'privacy', 'login', 'signup', 'share', 'status']
  },
  youtube: {
    domains: ['youtube.com', 'youtu.be'],
    handle: /youtube\.com\/(?:@([a-zA-Z0-9_.\-]{2,50})|c\/([a-zA-Z0-9_.\-]{2,50})|channel\/([a-zA-Z0-9_\-]{10,50})|user\/([a-zA-Z0-9_.\-]{2,50}))/i,
    blocklist: ['watch', 'results', 'playlist', 'redirect', 'feed', 'gaming', 'embed', 'shorts', 'about', 'contact']
  },
  pinterest: {
    domains: ['pinterest.com'],
    handle: /pinterest\.com\/([a-zA-Z0-9_]{2,30})/i,
    blocklist: ['pin', 'search', 'categories', 'ideas', 'business', 'about', 'today', 'press', 'help', 'privacy', 'terms', 'login', 'signup']
  },
  facebook: {
    domains: ['facebook.com', 'fb.com'],
    handle: /(?:facebook|fb)\.com\/([a-zA-Z0-9.]{2,50})/i,
    blocklist: ['profile', 'pages', 'groups', 'events', 'watch', 'marketplace', 'gaming', 'pg', 'sharer', 'login', 'signup', 'help', 'privacy', 'terms', 'about', 'business', 'policies', 'people', 'public']
  },
  amazon: {
    domains: ['amazon.com'],
    handle: /amazon\.com\/shop\/([a-zA-Z0-9._-]{2,50})/i,
    blocklist: ['list', 'gp', 'dp', 's', 'b', 'browse', 'influencer', 'stores', 'ideas']
  },
  ltk: {
    domains: ['shopltk.com', 'liketk.it'],
    handle: /shopltk\.com\/explore\/([a-zA-Z0-9._-]{2,50})/i,
    blocklist: ['explore', 'home', 'trending', 'brands', 'app', 'about', 'privacy', 'terms', 'login', 'signup']
  },
  shopmy: {
    domains: ['shopmy.us'],
    handle: /shopmy\.us\/([a-zA-Z0-9._-]{2,50})/i,
    blocklist: ['collections', 'collection', 'shop', 'discover', 'brands', 'app', 'about', 'privacy', 'terms', 'login', 'signup', 'api', 'dashboard']
  },
  snapchat: {
    domains: ['snapchat.com'],
    handle: /snapchat\.com\/(?:add|u)\/([a-zA-Z0-9._-]{3,15})/i,
    blocklist: ['add', 'u', 'discover', 'explore', 'lens', 'spotlight', 'download', 'support', 'privacy', 'terms', 'login', 'signup']
  }
};

export const SOCIAL_PLATFORM_KEYS = Object.keys(SOCIAL_PATTERNS);

const CHANNEL_ID = /^UC[a-zA-Z0-9_-]{22}$/;

export function synthesizeSocialUrl(platform, handle) {
  switch (platform) {
    case 'instagram': return `https://www.instagram.com/${handle}`;
    case 'tiktok': return `https://www.tiktok.com/@${handle}`;
    case 'twitter': return `https://twitter.com/${handle}`;
    case 'youtube': return CHANNEL_ID.test(handle) ? `https://www.youtube.com/channel/${handle}` : `https://www.youtube.com/@${handle}`;
    case 'pinterest': return `https://www.pinterest.com/${handle}`;
    case 'facebook': return `https://www.facebook.com/${handle}`;
    case 'snapchat': return `https://www.snapchat.com/add/${handle}`;
    case 'amazon': return `https://www.amazon.com/shop/${handle}`;
    case 'ltk': return `https://www.shopltk.com/explore/${handle}`;
    case 'shopmy': return `https://shopmy.us/${handle}`;
    default: return null;
  }
}

// A domain has to start at a host boundary: m.tiktok.com hits, netflix.com is not x.com.
function hostMatches(raw, domain) {
  return new RegExp(`(?<![a-z0-9-])${domain.replace(/\./g, '\\.')}`, 'i').test(raw);
}

// Mutates `found` ({platform: {handle, url}}). A YouTube channel ID is a placeholder a
// later /@handle in the same stream can replace; a real handle is never traded back.
export function matchSocial(found, raw) {
  for (const [platform, pattern] of Object.entries(SOCIAL_PATTERNS)) {
    const placeholder = platform === 'youtube' && CHANNEL_ID.test(found.youtube?.handle || '');
    if (found[platform] && !placeholder) continue;
    if (!pattern.domains.some(d => hostMatches(raw, d))) continue;
    const match = raw.match(pattern.handle);
    if (!match) continue;
    const handle = match.slice(1).find(Boolean);
    if (!handle || handle.length < 2 || pattern.blocklist.includes(handle.toLowerCase())) continue;
    if (found[platform] && CHANNEL_ID.test(handle)) continue;
    found[platform] = { handle, url: synthesizeSocialUrl(platform, handle) };
  }
}

// OG/Twitter meta is server-rendered and often carries the canonical handle.
export function applySocialMetadata(found, metadata) {
  if (!found.twitter) {
    const handle = String(metadata['twitter:site'] || '').trim().replace(/^@/, '');
    if (/^[a-zA-Z0-9_]{1,15}$/.test(handle) && !SOCIAL_PATTERNS.twitter.blocklist.includes(handle.toLowerCase())) {
      found.twitter = { handle, url: synthesizeSocialUrl('twitter', handle) };
    }
  }
  for (const value of Object.values(metadata)) {
    if (typeof value === 'string') matchSocial(found, value);
  }
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// Candidate URLs from a page: every href, JSON-LD sameAs entries, then meta content values.
export function socialCandidatesFromHtml(html) {
  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map(m => decodeEntities(m[1].trim()));
  const sameAs = [...html.matchAll(/"sameAs"\s*:\s*(\[[^\]]*\]|"[^"]*")/gi)].flatMap(m => m[1].match(/https?:\/\/[^"\s]+/g) || []);
  const metadata = {};
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = tag[0];
    const key = attrs.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i)?.[1];
    const content = attrs.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1];
    if (key && content) metadata[key.toLowerCase()] = decodeEntities(content);
  }
  return { candidates: [...hrefs, ...sameAs].filter(Boolean), metadata };
}

async function fetchHtml(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; OfferLabCollabFinder/1.0)' }
    });
    if (!response.ok) return null;
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Social accounts linked from a domain's homepage.
 * status: "found" | "none" (page reached, nothing linked) | "error" (page unreachable)
 */
export async function fetchSocials(input, { fetchImpl = fetch } = {}) {
  const domain = normalizeDomain(input);
  if (!domain) return { status: 'none', domain: '', socials: {} };

  let sawError = false;
  for (const host of hostCandidates(domain)) {
    let html;
    try {
      html = await fetchHtml(`https://${host}/`, fetchImpl);
    } catch {
      sawError = true;
      continue;
    }
    if (!html) continue;

    const { candidates, metadata } = socialCandidatesFromHtml(html);
    const found = {};
    for (const raw of candidates) {
      matchSocial(found, raw);
      if (Object.keys(found).length === SOCIAL_PLATFORM_KEYS.length) break;
    }
    applySocialMetadata(found, metadata);
    return { status: Object.keys(found).length ? 'found' : 'none', domain: host, socials: found };
  }

  return { status: sawError ? 'error' : 'none', domain, socials: {} };
}
