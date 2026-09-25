/**
 * Brand name → website. The omnibar takes any text: a domain goes straight through, anything
 * else is resolved to one. Clearbit's keyless company autocomplete answers in about 250ms and
 * ranks the brand itself first ("kohls" → kohls.com), so it feeds the dropdown as you type and
 * answers Enter; a Google search through the SerpAPI proxy is the slow fallback, on Enter only,
 * for the names it does not know. Searches already in history that start with what was typed
 * rank first, since they cost nothing and are what the person came back for.
 */
const CLEARBIT = 'https://autocomplete.clearbit.com/v1/companies/suggest';
const SUGGEST_TIMEOUT_MS = 2500;
const SERP_TIMEOUT_MS = 8000;
const MIN_QUERY = 2;
const DEBOUNCE_MS = 120;

// One host label, dotted, ending in a TLD. Subdomains allowed: shop.glossier.com is a site.
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

// Sites a product search returns ahead of the brand's own.
const NOT_THE_BRAND = new Set([
  'amazon', 'walmart', 'target', 'costco', 'kroger', 'instacart', 'thrivemarket', 'wholefoodsmarket', 'sprouts',
  'etsy', 'ebay', 'shopify', 'instagram', 'facebook', 'tiktok', 'youtube', 'x', 'twitter', 'linkedin', 'pinterest',
  'reddit', 'wikipedia', 'google', 'apple', 'yelp', 'crunchbase', 'bloomberg', 'forbes', 'grocery', 'iherb', 'vitacost'
]);

const suggestions = new Map(); // lowercased query → Promise<[{name, domain}]>
const resolved = new Map();    // lowercased query → domain found by the slow path

/** True when the text is a web address (with or without scheme, www. or a path), not a name. */
export function looksLikeDomain(text) {
  const host = String(text || '').trim()
    .replace(/^https?:\/\//i, '')
    .split(/[/?#]/)[0]
    .split('@').pop()
    .split(':')[0]
    .replace(/^www\./i, '');
  return DOMAIN_RE.test(host);
}

/** Fast tier: companies whose name starts with the query, brand first. Cached per query. */
export function suggestBrands(query) {
  const key = String(query || '').trim().toLowerCase();
  if (key.length < MIN_QUERY) return Promise.resolve([]);
  if (suggestions.has(key)) return suggestions.get(key);
  const promise = (async () => {
    const response = await fetch(`${CLEARBIT}?query=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(SUGGEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Clearbit ${response.status}`);
    const rows = await response.json();
    return (Array.isArray(rows) ? rows : [])
      .map(row => ({ name: String(row.name || '').trim(), domain: hostOf(row.domain) }))
      .filter(row => row.domain);
  })().catch(err => {
    console.warn('[resolve] suggest failed:', err);
    suggestions.delete(key); // a transient failure should not stick for the session
    return [];
  });
  suggestions.set(key, promise);
  return promise;
}

/**
 * The domain for any text, or null. A domain passes through; a name takes the first history
 * match, then the first suggestion, then the first non-retailer Google offers.
 */
export async function resolveBrand(text, { history = () => [] } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (looksLikeDomain(raw)) return hostOf(raw);
  const key = raw.toLowerCase();
  if (resolved.has(key)) return resolved.get(key);
  const fromHistory = historyMatches(raw, history());
  if (fromHistory.length) return fromHistory[0].domain;
  const suggested = await suggestBrands(raw);
  if (suggested.length) return suggested[0].domain;
  const found = await findSite(raw).catch(err => { console.warn('[resolve] search failed:', err); return null; });
  if (found) resolved.set(key, found);
  return found;
}

/**
 * Wires one omnibar: as-you-type suggestions in its dropdown (the same list history uses),
 * arrow keys and Enter over them, and `resolve()` for the form's submit.
 */
export function attachBrandSuggestions({ input, dropdown, list, history, showHistory, favicon }) {
  // History has a header; suggestions have none, and with none to show the dropdown is not there.
  const header = dropdown.querySelector('.history-header');
  let timer = null;
  let shownFor = '';   // the query the list currently shows suggestions for

  function clearActive() {
    list.querySelectorAll('.history-item.is-active').forEach(el => el.classList.remove('is-active'));
  }

  function activeDomain() {
    return list.querySelector('.history-item.is-active')?.dataset.url || null;
  }

  function setActive(index) {
    const items = [...list.querySelectorAll('.history-item')];
    if (!items.length) return;
    clearActive();
    const next = ((index % items.length) + items.length) % items.length;
    items[next].classList.add('is-active');
    items[next].scrollIntoView({ block: 'nearest' });
  }

  function showHistoryAgain() {
    if (!list.classList.contains('is-suggesting')) return;
    shownFor = '';
    if (header) header.hidden = false;
    list.classList.remove('is-suggesting');
    showHistory?.();
  }

  function openDropdown(open) {
    dropdown.classList.toggle('visible', open);
    dropdown.closest('.search-form')?.classList.toggle('dropdown-open', open);
  }

  // `pending` is the instant pass before the network answers: history matches show at once,
  // and with none the previous keystroke's rows stay put rather than flashing empty.
  function render(query, found, { pending = false } = {}) {
    shownFor = query;
    const rows = merge(historyMatches(query, history()), found);
    if (header) header.hidden = true;
    const wasSuggesting = list.classList.contains('is-suggesting');
    list.classList.add('is-suggesting');
    if (pending && !rows.length) {
      if (!wasSuggesting) { list.innerHTML = ''; openDropdown(false); }
      return;
    }
    list.innerHTML = '';
    if (!rows.length) {
      openDropdown(false);
      return;
    }
    openDropdown(true);
    for (const row of rows) {
      const item = document.createElement('li');
      item.className = 'history-item suggestion-item';
      item.dataset.url = row.domain;
      const img = document.createElement('img');
      img.className = 'history-item-favicon';
      img.alt = '';
      img.src = favicon(row.domain);
      img.onerror = () => { img.src = 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22%23ccc%22><rect width=%2224%22 height=%2224%22 rx=%224%22/></svg>'; img.onerror = null; };
      const text = document.createElement('span');
      text.className = 'history-item-url';
      text.textContent = row.name && row.name.toLowerCase() !== row.domain ? row.name : row.domain;
      if (row.name && row.name.toLowerCase() !== row.domain) {
        const domain = document.createElement('span');
        domain.className = 'suggestion-domain';
        domain.textContent = row.domain;
        text.append(' ', domain);
      }
      item.append(img, text);
      list.append(item);
    }
  }

  function showMiss(query) {
    if (header) header.hidden = true;
    list.classList.add('is-suggesting');
    list.innerHTML = '';
    const miss = document.createElement('li');
    miss.className = 'history-empty';
    miss.textContent = `No site found for “${query}”. Try its web address.`;
    list.append(miss);
    openDropdown(true);
  }

  async function refresh() {
    const query = input.value.trim();
    if (query.length < MIN_QUERY) return;
    // History matches are instant; the network ones fill in when they land, if still wanted.
    render(query, [], { pending: true });
    const found = await suggestBrands(query);
    if (input.value.trim() === query) render(query, found);
  }

  input.addEventListener('input', event => {
    // The app dispatches its own input events when it writes the searched domain into the
    // field; only keystrokes ask for suggestions.
    if (!event.isTrusted) return;
    if (timer) clearTimeout(timer);
    const query = input.value.trim();
    if (query.length < MIN_QUERY) {
      if (shownFor) showHistoryAgain();
      return;
    }
    timer = setTimeout(refresh, DEBOUNCE_MS);
  });

  input.addEventListener('keydown', event => {
    if (!list.classList.contains('is-suggesting') && !dropdown.classList.contains('visible')) return;
    const items = list.querySelectorAll('.history-item');
    if (!items.length) return;
    const current = [...items].findIndex(el => el.classList.contains('is-active'));
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(current + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(current <= 0 ? items.length - 1 : current - 1); }
    else if (event.key === 'Escape') { clearActive(); }
  });

  return {
    /** The suggestion the arrow keys are on, or null. */
    picked() {
      return activeDomain();
    },
    /** The domain the form should search, or null when the text resolves to nothing. */
    async resolve() {
      const picked = activeDomain();
      if (picked) return picked;
      return resolveBrand(input.value, { history });
    },
    showMiss,
    /**
     * After the dropdown reopens on focus with history in it: a name still in the field gets
     * its suggestions back, anything else (empty, or the searched domain) keeps history.
     */
    sync() {
      const query = input.value.trim();
      if (query.length >= MIN_QUERY && !looksLikeDomain(query)) refresh();
      else showHistoryAgain();
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Matching                                                                    */
/* -------------------------------------------------------------------------- */

function historyMatches(query, domains) {
  const q = query.trim().toLowerCase();
  const slug = q.replace(/[^a-z0-9]/g, '');
  if (slug.length < MIN_QUERY) return [];
  return (domains || [])
    .map(d => hostOf(d))
    .filter(d => d && (d.startsWith(q) || secondLevel(d).replace(/[^a-z0-9]/g, '').startsWith(slug)))
    .map(domain => ({ name: '', domain }));
}

function merge(first, second) {
  const seen = new Set();
  const out = [];
  for (const row of [...first, ...second]) {
    if (seen.has(row.domain)) continue;
    seen.add(row.domain);
    out.push(row);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Slow tier: Google, through the finder's own proxy                           */
/* -------------------------------------------------------------------------- */

/** Google's best guess at a brand's own site, or null. Photo search can share it for a pack with no URL. */
export async function findSite(name, product = '') {
  const params = new URLSearchParams({ q: `${name} ${product} official site`.replace(/\s+/g, ' ').trim(), engine: 'google' });
  const response = await fetch(`/api/serpapi?${params}`, { signal: AbortSignal.timeout(SERP_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`SerpAPI ${response.status}`);
  const data = await response.json();
  const hosts = (data.organic_results || []).map(r => hostOf(r.link)).filter(h => h && !NOT_THE_BRAND.has(secondLevel(h)));
  // The brand's own domain usually carries its name; failing that, the first site that is not a
  // retailer is the best guess Google offers.
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return hosts.find(h => key && secondLevel(h).replace(/[^a-z0-9]/g, '').includes(key.slice(0, Math.max(4, key.length)))) || hosts[0] || null;
}

/** The bare host of a URL or domain, or null when it is not one. */
export function hostOf(url) {
  if (!url) return null;
  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
    return host.includes('.') ? host.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

const secondLevel = host => host.split('.').slice(-2, -1)[0] || host;
