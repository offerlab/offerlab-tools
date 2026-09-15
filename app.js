/* ==========================================================================
   Brand Collab Finder - Main Application
   ========================================================================== */

import { jsonrepair } from 'https://esm.sh/jsonrepair';
// Configuration
import { initPicker, openPicker, closePicker, isPickerOpen, canBuildWith, restorePickerFromUrl, syncPickerWithUrl } from './picker.js';
import { icon, hydrateIcons } from './icons.js';
import { synthesizeSocialUrl, matchSocial } from './shared/socials.js';

const CONFIG = {
  // All API keys are now server-side for security
  // Gemini, SerpAPI, and OpenGraph are all proxied through /api/* endpoints
  GEMINI_PROXY: '/api/gemini',
  SERPAPI_PROXY: '/api/serpapi',
  OPENGRAPH_PROXY: '/api/opengraph',
  CATALOG_PROXY: '/api/catalog',
  SOCIALS_PROXY: '/api/socials',
  CATALOG_CONCURRENCY: 6,
  SERP_FALLBACK_BRANDS: 5,
  CACHED_PRODUCTS_PER_BRAND: 24,
  MAX_SEARCH_HISTORY: 10,
  BATCH_SIZE: 5,
  REQUEST_DELAY_MS: 200,
  FETCH_TIMEOUT_MS: 5000,
  STORAGE_KEYS: {
    SEARCH_HISTORY: 'bcf_search_history',
    FEEDBACK: 'bcf_feedback_corpus',
    RESULTS_CACHE: 'bcf_results_cache_v2'
  },
  FAVICON_PRIMARY: (domain) => `https://www.google.com/s2/favicons?domain=${domain}&sz=64`,
  FAVICON_FALLBACK: (domain) => `https://icons.duckduckgo.com/ip3/${domain}.ico`
};

// State
let currentSearchId = null;
let currentResults = null;
function getResults() { return currentResults; }
let searchAbortController = null;
let isSearchCancelled = false;

// DOM Elements
const elements = {
  // Header
  siteHeader: document.getElementById('siteHeader'),
  siteHeaderLogo: document.getElementById('siteHeaderLogo'),
  siteHeaderResultsNav: document.getElementById('siteHeaderResultsNav'),
  headerBackBtn: document.getElementById('headerBackBtn'),
  headerStartOverBtn: document.getElementById('headerStartOverBtn'),
  stopSearchButton: document.getElementById('stopSearchButton'),
  resultsSearchButton: document.getElementById('resultsSearchButton'),

  // Sections
  appContainer: document.querySelector('.app-container'),
  landingSection: document.getElementById('landingSection'),
  loadingSection: document.getElementById('loadingSection'),
  resultsSection: document.getElementById('resultsSection'),
  emptySection: document.getElementById('emptySection'),
  errorSection: document.getElementById('errorSection'),
  floatingTiles: document.getElementById('floatingTiles'),

  // Forms & Inputs
  searchForm: document.getElementById('searchForm'),
  searchInput: document.getElementById('searchInput'),
  resultsSearchForm: document.getElementById('resultsSearchForm'),
  resultsSearchInput: document.getElementById('resultsSearchInput'),

  // History (Landing Page)
  searchHistoryDropdown: document.getElementById('searchHistoryDropdown'),
  historyList: document.getElementById('historyList'),

  // History (Results Page)
  resultsSearchHistoryDropdown: document.getElementById('resultsSearchHistoryDropdown'),
  resultsHistoryList: document.getElementById('resultsHistoryList'),

  // Results
  searchedBrandCardContainer: document.getElementById('searchedBrandCardContainer'),
  brandsGrid: document.getElementById('brandsGrid'),
  pickerSection: document.getElementById('pickerSection'),

  // Loading
  loadingText: document.getElementById('loadingText'),
  loadingUrl: document.getElementById('loadingUrl'),
  loadingFavicon: document.getElementById('loadingFavicon'),

  // Feedback
  feedbackSection: document.getElementById('feedbackSection'),
  feedbackPositive: document.getElementById('feedbackPositive'),
  feedbackNegative: document.getElementById('feedbackNegative'),
  feedbackThanks: document.getElementById('feedbackThanks'),

  // Empty/Error
  tryAgainBtn: document.getElementById('tryAgainBtn'),
  errorRetryBtn: document.getElementById('errorRetryBtn'),
  errorMessage: document.getElementById('errorMessage'),

  // Popover
  socialPopover: document.getElementById('socialPopover'),

  // Typing placeholders
  typingPlaceholder: document.getElementById('typingPlaceholder'),
  resultsTypingPlaceholder: document.getElementById('resultsTypingPlaceholder'),
  resultsSearchDisplay: document.getElementById('resultsSearchDisplay'),

  // Pitch Modal
  pitchModalOverlay: document.getElementById('pitchModalOverlay'),
  pitchModal: document.getElementById('pitchModal'),
  pitchModalClose: document.getElementById('pitchModalClose'),
  pitchModalBody: document.getElementById('pitchModalBody'),
  pitchModalContent: document.getElementById('pitchModalContent'),
  pitchQuickLinks: document.getElementById('pitchQuickLinks'),
  pitchModalSubtitle: document.getElementById('pitchModalSubtitle'),
  pitchToolbarBtn: document.getElementById('pitchToolbarBtn')
};

/* --------------------------------------------------------------------------
   URL State (persistent search results via ?q= param)
   -------------------------------------------------------------------------- */
const SEARCH_PARAM = 'q';

function getSearchFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const q = params.get(SEARCH_PARAM);
  return q ? q.trim() : null;
}

function updateUrlForSearch(domain) {
  const url = new URL(window.location.href);
  url.searchParams.set(SEARCH_PARAM, domain);
  history.pushState({ q: domain }, '', url.toString());
}

function clearSearchFromUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete(SEARCH_PARAM);
  url.searchParams.delete('pitch');
  url.searchParams.delete('pick');
  history.replaceState(null, '', url.toString());
}

function getPitchFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const p = params.get('pitch');
  return p ? p.trim() : null;
}

/**
 * Attempt to restore pitch modal from URL ?pitch=BrandName param.
 * Requires currentResults to be populated first (brands must be loaded).
 */
function restorePitchFromUrl() {
  const pitchBrandName = getPitchFromUrl();
  if (!pitchBrandName || !currentResults?.brands) return;

  // Find matching brand in current results (case-insensitive)
  const match = currentResults.brands.find(
    b => b.name && b.name.toLowerCase() === pitchBrandName.toLowerCase()
  );

  if (match) {
    console.log(`[PitchModal] Restoring from URL: ${pitchBrandName}`);
    openPitchModal(match, { skipUrlUpdate: true });
  } else {
    console.warn(`[PitchModal] Brand "${pitchBrandName}" not found in current results — ignoring pitch param`);
    // Clean up stale param
    const url = new URL(window.location.href);
    url.searchParams.delete('pitch');
    history.replaceState(null, '', url.toString());
  }
}

function goToLanding() {
  clearSearchFromUrl();
  showSection('landing');
  if (elements.searchInput) elements.searchInput.value = '';
  if (elements.searchInput) elements.searchInput.focus();
}

function cancelSearch() {
  console.log('[cancelSearch] User cancelled search');
  isSearchCancelled = true;
  if (searchAbortController) {
    searchAbortController.abort();
  }
  goToLanding();
}

/* --------------------------------------------------------------------------
   Results Cache (localStorage - persists across sessions, 72 hour expiration)
   -------------------------------------------------------------------------- */

const CACHE_EXPIRATION_MS = 72 * 60 * 60 * 1000; // 72 hours in milliseconds

function getCacheKey(domain) {
  return `${CONFIG.STORAGE_KEYS.RESULTS_CACHE}_${domain.toLowerCase()}`;
}

function getCachedResults(domain) {
  try {
    const key = getCacheKey(domain);
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    
    const cached = JSON.parse(raw);
    
    // Check if cache has expired
    if (cached.timestamp) {
      const age = Date.now() - cached.timestamp;
      if (age > CACHE_EXPIRATION_MS) {
        console.log(`[Cache] Expired for ${domain} (age: ${Math.round(age / 1000 / 60 / 60)}h)`);
        localStorage.removeItem(key);
        return null;
      }
      console.log(`[Cache] Valid for ${domain} (age: ${Math.round(age / 1000 / 60)}min)`);
    }
    
    return cached;
  } catch {
    return null;
  }
}

function setCachedResults(domain, data) {
  try {
    const key = getCacheKey(domain);
    const dataWithTimestamp = {
      ...data,
      timestamp: Date.now()
    };
    localStorage.setItem(key, JSON.stringify(dataWithTimestamp));
  } catch (e) {
    console.warn('Failed to cache results:', e);
  }
}

/* --------------------------------------------------------------------------
   Utility Functions
   -------------------------------------------------------------------------- */

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function normalizeUrl(input) {
  if (input == null || typeof input !== 'string') return '';
  let url = input.trim().toLowerCase();

  // Remove protocol if present
  url = url.replace(/^(https?:\/\/)?(www\.)?/, '');

  // Remove trailing slashes and paths for domain extraction
  const domain = url.split('/')[0];

  return domain;
}

function extractDomain(url) {
  if (url == null || typeof url !== 'string' || !url.trim()) return '';
  try {
    const urlStr = url.trim();
    const fullUrl = urlStr.startsWith('http') ? urlStr : 'https://' + urlStr;
    const urlObj = new URL(fullUrl);
    return urlObj.hostname.replace('www.', '');
  } catch {
    return normalizeUrl(url);
  }
}

function isValidUrl(input) {
  const domain = normalizeUrl(input);
  // Basic domain validation
  const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,}$/;
  return domainRegex.test(domain);
}

function getFaviconUrl(domain) {
  return CONFIG.FAVICON_PRIMARY(domain);
}

/**
 * Renders two brand favicons overlaid with offset & rotation.
 * Size is controlled via CSS --favicon-duo-size on the parent or the element itself.
 */
function renderFaviconDuo(domain1, domain2) {
  const src1 = getFaviconUrl(domain1);
  const src2 = getFaviconUrl(domain2);
  const fallback = "this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22%23ccc%22><rect width=%2224%22 height=%2224%22 rx=%224%22/></svg>';this.onerror=null;";
  return `
    <div class="favicon-duo">
      <img class="favicon-duo__back" src="${src1}" alt="" onerror="${fallback}" />
      <img class="favicon-duo__front" src="${src2}" alt="" onerror="${fallback}" />
    </div>
  `;
}

/**
 * Fetch Open Graph metadata (image, favicon, etc.) from OpenGraph.io API via proxy.
 * @param {string} url - Page URL to fetch
 * @returns {Promise<{imageUrl?: string, faviconUrl?: string}>}
 */
async function fetchOpenGraphData(url) {
  try {
    if (url == null || typeof url !== 'string' || !url.trim()) {
      console.warn('[OpenGraph] Invalid URL provided:', url);
      return { imageUrl: null, faviconUrl: null };
    }
    
    const fullUrl = url.trim().startsWith('http') ? url.trim() : `https://${url.trim()}`;
    const apiUrl = `${CONFIG.OPENGRAPH_PROXY}?url=${encodeURIComponent(fullUrl)}`;
    
    const res = await fetch(apiUrl);
    
    if (!res.ok) {
      const errorText = await res.text().catch(() => 'Unknown error');
      console.warn(`[OpenGraph] API error ${res.status} for ${fullUrl}: ${errorText}`);
      return { imageUrl: null, faviconUrl: null };
    }
    
    const data = await res.json();
    
    // Log raw response for debugging
    console.log(`[OpenGraph] Raw response for ${fullUrl}:`, JSON.stringify(data));
    
    const result = {
      imageUrl: data?.imageUrl && typeof data.imageUrl === 'string' ? data.imageUrl : null,
      faviconUrl: data?.faviconUrl && typeof data.faviconUrl === 'string' ? data.faviconUrl : null
    };
    
    if (result.imageUrl) {
      console.log(`[OpenGraph] ✓ Image found: ${result.imageUrl}`);
    } else {
      console.warn(`[OpenGraph] ✗ No image in response for: ${fullUrl}`);
    }
    
    return result;
  } catch (err) {
    console.error('[OpenGraph] Network error:', err.message || err);
    return { imageUrl: null, faviconUrl: null };
  }
}

/* --------------------------------------------------------------------------
   LocalStorage Helpers
   -------------------------------------------------------------------------- */

function getSearchHistory() {
  try {
    const history = localStorage.getItem(CONFIG.STORAGE_KEYS.SEARCH_HISTORY);
    return history ? JSON.parse(history) : [];
  } catch {
    return [];
  }
}

function saveSearchHistory(history) {
  try {
    localStorage.setItem(CONFIG.STORAGE_KEYS.SEARCH_HISTORY, JSON.stringify(history));
  } catch (e) {
    console.error('Failed to save search history:', e);
  }
}

function addToSearchHistory(url) {
  const history = getSearchHistory();
  const domain = extractDomain(url);

  // Remove if already exists
  const filtered = history.filter(item => item.domain !== domain);

  // Add to beginning
  filtered.unshift({
    domain,
    url: domain,
    timestamp: Date.now()
  });

  // Keep only last N items
  const trimmed = filtered.slice(0, CONFIG.MAX_SEARCH_HISTORY);

  saveSearchHistory(trimmed);
  return trimmed;
}

function clearSearchHistory() {
  saveSearchHistory([]);
}

function removeFromSearchHistory(domain) {
  const history = getSearchHistory().filter(item => item.domain !== domain);
  saveSearchHistory(history);
}

function getFeedbackHistory() {
  try {
    const feedback = localStorage.getItem(CONFIG.STORAGE_KEYS.FEEDBACK);
    return feedback ? JSON.parse(feedback) : [];
  } catch {
    return [];
  }
}

function saveFeedback(searchId, inputUrl, results, rating) {
  try {
    const feedback = getFeedbackHistory();
    feedback.push({
      searchId,
      inputUrl,
      results: results.map(r => ({ name: r.name, url: r.url })),
      rating,
      timestamp: Date.now()
    });

    // Keep last 100 feedback entries
    const trimmed = feedback.slice(-100);
    localStorage.setItem(CONFIG.STORAGE_KEYS.FEEDBACK, JSON.stringify(trimmed));
  } catch (e) {
    console.error('Failed to save feedback:', e);
  }
}

/* --------------------------------------------------------------------------
   UI State Management
   -------------------------------------------------------------------------- */

function showSection(sectionName) {
  // Hide all sections
  elements.landingSection.classList.add('hidden');
  elements.loadingSection.classList.add('hidden');
  elements.resultsSection.classList.add('hidden');
  if (elements.pickerSection) elements.pickerSection.classList.add('hidden');
  elements.emptySection.classList.add('hidden');
  elements.errorSection.classList.add('hidden');

  // Hide all header states by default
  if (elements.siteHeaderLogo) elements.siteHeaderLogo.classList.add('hidden');
  if (elements.siteHeaderResultsNav) elements.siteHeaderResultsNav.classList.add('hidden');
  if (elements.siteHeader) {
    elements.siteHeader.classList.remove('header-nav--results');
    elements.siteHeader.classList.remove('header-nav--loading');
  }

  // Show requested section
  switch (sectionName) {
    case 'landing':
      elements.landingSection.classList.remove('hidden');
      document.querySelector('.app-container').classList.remove('showing-results');
      document.body.classList.remove('showing-results');
      elements.floatingTiles.classList.remove('whip-out', 'whip-out--fast');
      if (elements.siteHeaderLogo) elements.siteHeaderLogo.classList.remove('hidden');
      break;
    case 'loading':
      elements.loadingSection.classList.remove('hidden');
      document.querySelector('.app-container').classList.add('showing-results');
      document.body.classList.add('showing-results');
      resetTileTilt();
      // Show results header in loading state (back/start over hidden, stop button visible)
      if (elements.siteHeader) {
        elements.siteHeader.classList.add('header-nav--results');
        elements.siteHeader.classList.add('header-nav--loading');
      }
      if (elements.siteHeaderResultsNav) elements.siteHeaderResultsNav.classList.remove('hidden');
      break;
    case 'results':
      elements.resultsSection.classList.remove('hidden');
      document.querySelector('.app-container').classList.add('showing-results');
      document.body.classList.add('showing-results');
      resetTileTilt();
      if (elements.siteHeader) {
        elements.siteHeader.classList.add('header-nav--results');
        // Remove loading state to fade in back/start over buttons
        elements.siteHeader.classList.remove('header-nav--loading');
      }
      if (elements.siteHeaderResultsNav) elements.siteHeaderResultsNav.classList.remove('hidden');
      break;
    case 'picker':
      elements.pickerSection.classList.remove('hidden');
      document.querySelector('.app-container').classList.add('showing-results');
      document.body.classList.add('showing-results');
      resetTileTilt();
      if (elements.siteHeader) {
        elements.siteHeader.classList.add('header-nav--results');
        elements.siteHeader.classList.remove('header-nav--loading');
      }
      if (elements.siteHeaderResultsNav) elements.siteHeaderResultsNav.classList.remove('hidden');
      break;
    case 'empty':
      elements.emptySection.classList.remove('hidden');
      document.querySelector('.app-container').classList.add('showing-results');
      document.body.classList.add('showing-results');
      resetTileTilt();
      if (elements.siteHeader) {
        elements.siteHeader.classList.add('header-nav--results');
      }
      if (elements.siteHeaderResultsNav) elements.siteHeaderResultsNav.classList.remove('hidden');
      break;
    case 'error':
      elements.errorSection.classList.remove('hidden');
      document.querySelector('.app-container').classList.add('showing-results');
      document.body.classList.add('showing-results');
      resetTileTilt();
      if (elements.siteHeader) {
        elements.siteHeader.classList.add('header-nav--results');
      }
      if (elements.siteHeaderResultsNav) elements.siteHeaderResultsNav.classList.remove('hidden');
      break;
  }
}

/* --------------------------------------------------------------------------
   Search History UI
   -------------------------------------------------------------------------- */

function renderSearchHistory(targetList = null) {
  const history = getSearchHistory();

  // If no target specified, render to both lists
  const lists = targetList ? [targetList] : [elements.historyList, elements.resultsHistoryList];

  lists.forEach(list => {
    if (!list) return;

    if (history.length === 0) {
      list.innerHTML = '<li class="history-empty">No recent searches</li>';
      return;
    }

    list.innerHTML = history.map(item => `
      <li class="history-item" data-url="${item.domain}">
        <img
          src="${getFaviconUrl(item.domain)}"
          alt=""
          class="history-item-favicon"
          onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22%23ccc%22><rect width=%2224%22 height=%2224%22 rx=%224%22/></svg>'"
        >
        <span class="history-item-url">${item.domain}</span>
        <button type="button" class="history-item-remove-btn" data-url="${item.domain}" aria-label="Remove ${item.domain} from history">
          ${icon('cross-large', { class: 'history-item-remove-icon' })}
        </button>
      </li>
    `).join('');
  });
}

function showSearchHistory(dropdown = elements.searchHistoryDropdown) {
  renderSearchHistory();
  dropdown.classList.add('visible');
  // Add class to parent form for connected styling
  const parentForm = dropdown.closest('.search-form');
  if (parentForm) {
    parentForm.classList.add('dropdown-open');
  }
}

function hideSearchHistory(dropdown = null) {
  if (dropdown) {
    dropdown.classList.remove('visible');
    // Remove class from parent form
    const parentForm = dropdown.closest('.search-form');
    if (parentForm) {
      parentForm.classList.remove('dropdown-open');
    }
  } else {
    // Hide all dropdowns
    elements.searchHistoryDropdown.classList.remove('visible');
    elements.searchForm.classList.remove('dropdown-open');
    if (elements.resultsSearchHistoryDropdown) {
      elements.resultsSearchHistoryDropdown.classList.remove('visible');
      elements.resultsSearchForm.classList.remove('dropdown-open');
    }
  }
}

function hideAllSearchHistoryDropdowns() {
  elements.searchHistoryDropdown.classList.remove('visible');
  elements.searchForm.classList.remove('dropdown-open');
  if (elements.resultsSearchHistoryDropdown) {
    elements.resultsSearchHistoryDropdown.classList.remove('visible');
    elements.resultsSearchForm.classList.remove('dropdown-open');
  }
}

/* --------------------------------------------------------------------------
   Results Rendering
   -------------------------------------------------------------------------- */

/* --------------------------------------------------------------------------
   Social accounts: scraped from the brand's site (same grammar as the app's Brand DNA
   extraction), with Gemini's guesses filling any platform the site did not link.
   Stored as {platform: {handle, url}} in the app's registry order.
   -------------------------------------------------------------------------- */

const SOCIAL_PLATFORMS = [
  { key: 'instagram', label: 'Instagram', icon: 'instagram' },
  { key: 'tiktok', label: 'TikTok', icon: 'tiktok' },
  { key: 'twitter', label: 'X', icon: 'twitter-x' },
  { key: 'youtube', label: 'YouTube', icon: 'youtube' },
  { key: 'pinterest', label: 'Pinterest', icon: 'pinterest' },
  { key: 'facebook', label: 'Facebook', icon: 'facebook' },
  { key: 'snapchat', label: 'Snapchat', icon: 'snapchat' },
  { key: 'shopmy', label: 'ShopMy', icon: 'shopmy' },
  { key: 'amazon', label: 'Amazon shop', icon: 'amazon' },
  { key: 'ltk', label: 'LTK', icon: 'ltk' }
];

const HANDLE_SHAPE = /^[a-zA-Z0-9_.-]{1,50}$/;

// Accepts the AI's loose shape ({instagram: "@handle" | url | name}) or the stored one.
function normalizeSocial(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const { key } of SOCIAL_PLATFORMS) {
    const value = raw[key];
    if (!value) continue;
    if (typeof value === 'object' && value.handle) {
      out[key] = { handle: value.handle, url: value.url || synthesizeSocialUrl(key, value.handle) };
      continue;
    }
    const text = String(value).trim();
    if (/^https?:\/\//i.test(text)) {
      const found = {};
      matchSocial(found, text);
      if (found[key]) out[key] = found[key];
      continue;
    }
    const handle = text.replace(/^@/, '');
    if (HANDLE_SHAPE.test(handle)) out[key] = { handle, url: synthesizeSocialUrl(key, handle) };
  }
  return out;
}

// The site's own links win; the AI only fills platforms the site did not link.
function mergeSocial(scraped, ai) {
  return { ...normalizeSocial(ai), ...normalizeSocial(scraped) };
}

function hasAnySocialLink(social) {
  return Object.keys(normalizeSocial(social)).length > 0;
}

function socialEntries(social) {
  const normalized = normalizeSocial(social);
  return SOCIAL_PLATFORMS.filter(p => normalized[p.key]).map(p => ({ ...p, ...normalized[p.key] }));
}

async function fetchSocials(domain) {
  try {
    const response = await fetch(`${CONFIG.SOCIALS_PROXY}?domain=${encodeURIComponent(domain)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data.socials || {};
  } catch (err) {
    console.warn(`[Socials] ${domain}: ${err.message}`);
    return {};
  }
}

function updateCardSocial(domain, social) {
  document.querySelectorAll(`.result-card[data-domain="${domain}"]`).forEach(card => {
    card.dataset.social = JSON.stringify(social || {});
    card.querySelector('.card-menu-btn')?.classList.toggle('hidden', !hasAnySocialLink(social));
  });
}

function buildFallbackSearchedBrand(domain) {
  const fullUrl = domain.startsWith('http') ? domain : `https://${domain}`;
  const displayName = domain.replace(/^(www\.)?/, '').split('.')[0];
  const friendlyName = displayName.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return {
    name: friendlyName,
    url: fullUrl,
    description: `${friendlyName} is a brand selling online. Visit their website to explore their product range and categories.`
  };
}

/* --------------------------------------------------------------------------
   Catalog strip: what a brand sells, from its public Shopify catalog
   -------------------------------------------------------------------------- */

const CATALOG_THUMBS = 5;

function catalogThumbUrl(src, width = 160) {
  try {
    const url = new URL(src);
    if (url.hostname.endsWith('cdn.shopify.com')) {
      url.searchParams.set('width', String(width));
      return url.toString();
    }
  } catch {}
  return src;
}

const CATALOG_SOURCES = {
  shopify: { label: 'Shopify', icon: 'shopify' },
  serp: { label: 'Google Shopping', icon: 'google' }
};

// Thumbnail row inside the card. Loading shows a shimmer; no products shows nothing.
function renderCatalogThumbs(catalog) {
  if (!catalog) {
    const skeleton = '<div class="card-catalog-thumb"></div>'.repeat(4);
    return `<div class="card-catalog card-catalog--loading"><div class="card-catalog-thumbs">${skeleton}</div></div>`;
  }
  const products = (catalog.products || []).filter(p => p.image);
  if (products.length === 0) return '';

  const count = catalog.count || products.length;
  const shown = products.slice(0, CATALOG_THUMBS);
  // Past the row, the last tile blurs over its image and carries the count it stands in for.
  const overflow = count > CATALOG_THUMBS ? count - (CATALOG_THUMBS - 1) : 0;
  const thumbs = shown.map((p, i) => {
    const img = `<img class="media-zoom" src="${catalogThumbUrl(p.image, 240)}" alt="" loading="lazy" onerror="this.parentElement.remove()">`;
    const more = overflow && i === shown.length - 1;
    return `<div class="card-catalog-thumb media-tile media-hairline${more ? ' card-catalog-thumb--more' : ''}" title="${escapeHtml(p.title)}">${img}${more ? `<span class="card-catalog-thumb-count">+${overflow}</span>` : ''}</div>`;
  }).join('');
  return `<div class="card-catalog card-catalog--${catalog.status}"><div class="card-catalog-thumbs">${thumbs}</div></div>`;
}

// The chinstrap tucked under the card: source on the left, product count on the right.
// Only while the catalog is loading or once it has products; a brand without one gets no strip.
function renderCatalogChinstrap(catalog, radius = 32) {
  let source;
  let count = '';
  if (!catalog) {
    source = `${icon('spinner', { class: 'icon-spin', size: 14 })} Checking catalog`;
  } else {
    const n = catalog.count || (catalog.products || []).length;
    if (n === 0) return '';
    const meta = CATALOG_SOURCES[catalog.status] || CATALOG_SOURCES.serp;
    source = `${icon(meta.icon, { size: 14 })} ${meta.label}`;
    count = `${n} ${n === 1 ? 'product' : 'products'}`;
  }
  return `<div class="tuck-banner tuck-banner--chinstrap card-chinstrap card-chinstrap--${catalog ? catalog.status : 'loading'}" style="--tuck-radius: ${radius}px">
    <span class="card-chinstrap-source">${source}</span>
    <span class="card-chinstrap-count">${count}</span>
    <div class="tuck-banner__notch tuck-banner__notch--left"></div>
    <div class="tuck-banner__notch tuck-banner__notch--right"></div>
  </div>`;
}

function updateCardCatalog(domain, catalog) {
  const buildable = (catalog?.products?.length || 0) > 0;
  document.querySelectorAll(`[data-catalog-domain="${domain}"]`).forEach(group => {
    const slot = group.querySelector('.card-catalog-slot');
    if (slot) slot.innerHTML = renderCatalogThumbs(catalog);
    const linkSlot = group.querySelector('.searched-brand-card-link-slot');
    if (linkSlot) {
      linkSlot.innerHTML = renderSearchedBrandLink(catalog);
      return;
    }
    group.querySelector('.card-chinstrap')?.remove();
    const chinstrap = renderCatalogChinstrap(catalog);
    if (chinstrap) group.insertAdjacentHTML('beforeend', chinstrap);
    const card = group.querySelector('.result-card');
    if (!card) return;
    card.dataset.buildable = buildable ? 'true' : 'false';
    card.querySelector('.build-bundle-btn')?.classList.toggle('hidden', !buildable);
  });
}

function brandForCard(card) {
  return currentResults?.brands?.find(b => extractDomain(b.url || '') === card.dataset.domain) || null;
}

async function fetchCatalog(domain) {
  try {
    const response = await fetch(`${CONFIG.CATALOG_PROXY}?domain=${encodeURIComponent(domain)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    console.warn(`[Catalog] ${domain}: ${err.message}`);
    return { status: 'error', domain, count: 0, products: [] };
  }
}

// Sets brand.catalog on each brand as its fetch resolves, a few at a time.
async function attachCatalogs(brands, onCatalog) {
  const queue = [...brands];
  const worker = async () => {
    while (queue.length) {
      const brand = queue.shift();
      const domain = extractDomain(brand.url || '');
      const [catalog, scrapedSocial] = domain
        ? await Promise.all([fetchCatalog(domain), fetchSocials(domain)])
        : [{ status: 'none', domain: '', count: 0, products: [] }, {}];
      brand.catalog = catalog;
      brand.social = mergeSocial(scrapedSocial, brand.social);
      if (onCatalog) onCatalog(brand);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONFIG.CATALOG_CONCURRENCY, brands.length) }, worker));
}

// localStorage is small; the cache keeps enough of each catalog to render the card.
function trimCatalogForCache(brand) {
  if (!brand?.catalog?.products) return brand;
  const { products, ...rest } = brand.catalog;
  return { ...brand, catalog: { ...rest, products: products.slice(0, CONFIG.CACHED_PRODUCTS_PER_BRAND), truncated: products.length > CONFIG.CACHED_PRODUCTS_PER_BRAND } };
}

// Searched brand's visit control: the platform mark (when known) beside the external-link icon,
// styled as an elevated button. The whole card is the link, so this is a span, not a button.
function renderSearchedBrandLink(catalog) {
  const platform = catalog?.status === 'shopify'
    ? `<span class="searched-brand-card-link-ghost">${icon(CATALOG_SOURCES.shopify.icon, { class: 'searched-brand-card-link-platform', size: 18 })}</span>`
    : '';
  return `<span class="btn btn--md btn--secondary searched-brand-card-link" aria-hidden="true">
    ${platform}<span class="searched-brand-card-link-ghost searched-brand-card-link-ghost--external">${icon('square-arrow-top-right-2')}</span>
  </span>`;
}

function createSearchedBrandCard(searchedBrand) {
  const url = searchedBrand?.url || '';
  const domain = extractDomain(url);
  const fullUrl = url && url.startsWith('http') ? url : (url ? `https://${url}` : '#');
  const imageUrl = searchedBrand.imageUrl || '';
  const faviconUrl = searchedBrand.faviconUrl || getFaviconUrl(domain);
  const imgSrc = imageUrl || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";

  const group = document.createElement('div');
  group.className = 'searched-brand-card-group';
  group.dataset.catalogDomain = domain;

  const card = document.createElement('a');
  card.className = 'searched-brand-card';
  card.href = fullUrl;
  card.target = '_blank';
  card.rel = 'noopener noreferrer';
  card.dataset.url = fullUrl;

  card.innerHTML = `
    <div class="searched-brand-card-image">
      <img
        src="${imgSrc}"
        alt="${searchedBrand.name}"
        loading="eager"
      >
    </div>
    <div class="searched-brand-card-content">
      <div class="searched-brand-card-main">
        <div class="searched-brand-card-header">
          <img
            src="${faviconUrl}"
            alt="${searchedBrand.name}"
            class="searched-brand-card-favicon"
            onerror="this.src='${getFaviconUrl(domain)}'; this.onerror=null;"
          >
          <div class="searched-brand-card-info">
            <div class="searched-brand-card-name">${searchedBrand.name}</div>
            <div class="searched-brand-card-url">${domain}</div>
          </div>
          <div class="searched-brand-card-link-slot">${renderSearchedBrandLink(searchedBrand.catalog)}</div>
        </div>
        <p class="searched-brand-card-description">${searchedBrand.description}</p>
        <div class="card-catalog-slot">${renderCatalogThumbs(searchedBrand.catalog)}</div>
      </div>
    </div>
  `;

  group.append(card);
  return group;
}

// Three bullets from the recommender; a cached result may still carry the old paragraph.
function renderCardReason(brand) {
  const bullets = Array.isArray(brand.reasons) ? brand.reasons.filter(Boolean) : [];
  if (bullets.length) {
    const items = bullets.map(text => `<li class="card-reason-item">${escapeHtml(text)}</li>`).join('');
    return `<div class="card-reason-bubble"><ul class="card-reason">${items}</ul></div>`;
  }
  if (brand.reason) {
    return `<div class="card-reason-bubble"><p class="card-reason card-reason--prose">${escapeHtml(brand.reason)}</p></div>`;
  }
  return '';
}

function createBrandCard(brand, index) {
  const url = brand?.url || '';
  const domain = extractDomain(url);
  const fullUrl = url && url.startsWith('http') ? url : (url ? `https://${url}` : '#');
  const group = document.createElement('div');
  group.className = 'result-card-group';
  group.style.animationDelay = `${index * 0.05}s`;
  group.dataset.catalogDomain = domain;

  const card = document.createElement('div');
  card.className = 'result-card';
  card.dataset.url = fullUrl;
  card.dataset.domain = domain;
  card.dataset.social = JSON.stringify(brand.social || {});
  if (canBuildWith(brand)) card.dataset.buildable = 'true';

  const showMenu = hasAnySocialLink(brand.social);
  card.innerHTML = `
    <div class="card-header-wrapper">
      <div class="card-header">
        <img
          src="${getFaviconUrl(domain)}"
          alt="${brand.name}"
          class="card-favicon"
          onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22%23ccc%22><rect width=%2224%22 height=%2224%22 rx=%224%22/></svg>'"
        >
        <div class="card-info">
          <div class="card-name">${brand.name}</div>
          <div class="card-url">${domain}</div>
        </div>
        <button class="card-menu-btn${showMenu ? '' : ' hidden'}" aria-label="More options">
          ${icon('dot-grid-1x3-horizontal', { class: 'card-menu-icon' })}
        </button>
      </div>
      <div class="card-catalog-slot">${renderCatalogThumbs(brand.catalog)}</div>
    </div>
    <div class="card-body">
      ${renderCardReason(brand)}
      <div class="card-actions">
        <button type="button" class="btn btn--md btn--primary build-bundle-btn${canBuildWith(brand) ? '' : ' hidden'}">Build bundle</button>
        <div class="generate-pitch-wrapper" data-brand="${encodeURIComponent(JSON.stringify(brand))}">
          <button type="button" class="btn btn--md btn--secondary generate-pitch-btn">Create pitch</button>
        </div>
        <button type="button" class="btn btn--md btn--secondary btn--icon visit-btn has-tooltip" data-url="${fullUrl}" aria-label="Visit ${escapeHtml(brand.name)}">
          ${icon('square-arrow-top-right-2')}
          <span class="tooltip" aria-hidden="true">Visit ${escapeHtml(brand.name)}</span>
        </button>
      </div>
    </div>
  `;

  group.append(card);
  group.insertAdjacentHTML('beforeend', renderCatalogChinstrap(brand.catalog));
  return group;
}


// Render brands only (called first when brands are ready)
function renderBrandsOnly(brands, searchedBrand = null) {
  console.log(`[Render] Rendering ${brands.length} brands`);
  
  // Clear existing brands
  elements.brandsGrid.innerHTML = '';
  if (elements.searchedBrandCardContainer) {
    elements.searchedBrandCardContainer.innerHTML = '';
  }

  // Render searched brand card at top
  if (searchedBrand && elements.searchedBrandCardContainer) {
    const card = createSearchedBrandCard(searchedBrand);
    elements.searchedBrandCardContainer.appendChild(card);
  }

  // Render brands
  brands.forEach((brand, index) => {
    const card = createBrandCard(brand, index);
    elements.brandsGrid.appendChild(card);
  });
}






// Cached results render in one pass, catalogs included.
function renderResults(brands, searchedBrand = null) {
  renderBrandsOnly(brands, searchedBrand);

  // Reset feedback state
  elements.feedbackPositive.classList.remove('selected');
  elements.feedbackNegative.classList.remove('selected');
  elements.feedbackThanks.classList.add('hidden');
  elements.feedbackSection.style.pointerEvents = 'auto';
}

/* --------------------------------------------------------------------------
   Social Media Popover
   -------------------------------------------------------------------------- */

let activePopoverCard = null;

function showSocialPopover(button, socialData) {
  const popover = elements.socialPopover;
  const rect = button.getBoundingClientRect();
  const parentCard = button.closest('.result-card');

  // Clear previous popover card state
  if (activePopoverCard) {
    activePopoverCard.classList.remove('popover-open');
  }
  activePopoverCard = parentCard;
  if (activePopoverCard) {
    activePopoverCard.classList.add('popover-open');
  }

  popover.innerHTML = socialEntries(socialData).map(entry => `
    <a href="${escapeHtml(entry.url)}" class="social-link" data-platform="${entry.key}" target="_blank" rel="noopener" title="@${escapeHtml(entry.handle)}">
      ${icon(entry.icon, { class: 'social-icon' })}
      <span>${entry.label}</span>
      ${icon('arrow-up-right', { class: 'social-link-external' })}
    </a>`).join('');

  // Append popover to card so it scrolls with the page (not fixed in viewport)
  parentCard.appendChild(popover);

  // Position 4px below the three-dot menu, relative to the card
  const cardRect = parentCard.getBoundingClientRect();
  const top = rect.bottom - cardRect.top + 4;
  const popoverWidth = 220; // matches .social-popover min-width
  // Center the popover under the menu button
  const left = Math.max(0, rect.left - cardRect.left - (popoverWidth / 2) + (rect.width / 2));
  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;

  // Show
  popover.classList.remove('hidden');
}

function hideSocialPopover() {
  const popover = elements.socialPopover;
  popover.classList.add('hidden');
  // Move popover back to body (original location) when hidden
  if (popover.parentNode && popover.parentNode !== document.body) {
    document.body.appendChild(popover);
  }
  if (activePopoverCard) {
    activePopoverCard.classList.remove('popover-open');
    activePopoverCard = null;
  }
}

/* --------------------------------------------------------------------------
   Pitch Modal
   -------------------------------------------------------------------------- */

let currentPitchBrand = null;
let currentPitchBrand1 = null; // Searched brand (pitched TO)
let currentPitchBrand2 = null; // Recommended brand (collab WITH)
let currentPitchModel = 'gemini-2.5-flash';
let pitchAbortController = null;
let isPitchGenerating = false;

// In-memory cache for generated pitches: Map<"brand1|brand2", resultJSON>
const pitchCache = new Map();

const PITCH_MODELS = [
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Fast)' },
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (Best)' }
];

const PITCH_SYSTEM_PROMPT = `You are OfferLab's AI Outreach Copilot. You generate hyper-personalized outreach strategies and messages for pitching brands on collaborative commerce.

## WHO YOU ARE WRITING FOR
Sean Gartland — Chief Product Officer at OfferLab. Sean is a builder and product leader, not a salesperson. His outreach has "builder/founder energy": he leads with credibility, references shared challenges, and pitches from mutual benefit. He genuinely appreciates great brands.

## WHAT OFFERLAB IS
OfferLab is a collaborative commerce platform that empowers brands and creators to sell together. The core product is collab bundles — curated product bundles combining items from multiple complementary brands, sold through a single checkout experience. Both brands promote the bundle, both brands' audiences discover each other.

Key value props (pick the 1–2 most relevant per brand):
- New customer acquisition: Every collab partner brings their own audience. The bundle is a customer acquisition channel for both brands.
- Higher AOV: Bundles naturally drive higher average order values because customers get more value in a single purchase.
- Turnkey infrastructure: OfferLab handles checkout, revenue splitting, fulfillment coordination — brands focus on creative and product.
- We come with partners: OfferLab has already identified complementary brands for them. This is the killer differentiator — don't just pitch the platform, come with the collab ideas.
- Single checkout: Customers can buy from both brands in one seamless transaction.

## SEAN'S VOICE RULES
- Builder/founder energy — "I'm building something" not "I'm selling something"
- Open with a SPECIFIC thing you admire about their brand — not generic flattery. Reference a real product, a real collab, a real decision they made.
- Frame as mutual benefit — never "I need you on our platform"
- Concise — LinkedIn DMs: 3–5 sentences max. Emails: under 150 words. IG DMs: 2–3 sentences.
- Always reference something concrete about their brand
- Sign off as: Sean Gartland, CPO at OfferLab

## CHANNEL SELECTION LOGIC
Evaluate brand signals and recommend the best primary outreach channel:

- Founder active on LinkedIn (posts, comments, shares content regularly) → LinkedIn DM
- Strong 2nd-degree connection available → Warm Intro via LinkedIn
- DTC-native brand, founder-led, strong Instagram presence (>50K followers) → Instagram DM
- More corporate, wholesale-heavy, has a PR/media team → Email
- Tech-forward brand, Shopify Plus, integrations-savvy → Email + Video (Loom)
- Brand has done collab drops or limited editions before → LinkedIn DM + attach deck
- Very small team (<10 people), founder does everything → Instagram DM or LinkedIn direct to founder
- No clear individual contact, larger company (50+ employees) → Email to partnerships@ or BD lead

Always recommend a backup channel for a Day 10–14 follow-up if the primary doesn't get a response.

## CONTACT IDENTIFICATION (TIER SYSTEM)
When suggesting who to reach out to, rank by these tiers:

Tier 1 (Primary targets):
- Head of Partnerships, Business Development, Revenue, Growth Marketing
- Sales Director or above
- E-commerce Director, DTC Lead, Head of Digital

Tier 2 (Strong secondary):
- Brand/Creative Director, Head of Marketing, Head of Content/Story
- COO, VP Operations, Product Operations lead

Tier 3 (Escalation or small teams):
- Founder / CEO — best when team is under 15 people, or as escalation after Tier 1/2 don't respond

Rule: If the brand has fewer than 15 employees, go straight to the founder.

## CONTACT DETAILS REQUIREMENTS
For each suggested contact, you MUST provide:
- **name**: Use the REAL full name of a person at the company if you know it (e.g. "Sarah Chen"). If you are not confident in a specific name, use the role title instead (e.g. "Head of Partnerships") but try your best to recall real names.
- **title**: Their actual role/title at the brand.
- **linkedin_url**: If you know the person's real name, provide a direct LinkedIn search URL in the format: "https://www.linkedin.com/search/results/people/?keywords={Full Name} {Company Name}". This helps the user quickly find and verify the contact. If you only have a role title, use: "https://www.linkedin.com/search/results/people/?keywords={Role Title} {Company Name}".
- **email**: If the brand's email pattern is known or inferable (e.g. first@company.com), provide a best-guess email. Otherwise set to null. Common DTC patterns: first@domain.com, firstname@domain.com, hello@domain.com for small teams.

## MESSAGE STRUCTURE GUIDELINES

LinkedIn DM structure:
1. One sentence: specific compliment about their brand (reference something real)
2. One sentence: who you are and what OfferLab does
3. One sentence: why there's a natural fit (reference their collab history or product range)
4. One sentence: the hook — "we've already identified brands that would be great collab partners"
5. CTA: "15 min, totally informal. Worth a look?"

Email structure:
1. Opening: specific compliment referencing a real product, launch, or decision
2. What OfferLab is: one sentence positioning
3. The collab bundle concept: paint a specific picture of what a Brand 1 × Brand 2 bundle could look like (name actual products)
4. The hook: "we've already identified brands that would be amazing collab partners"
5. CTA: "15 minutes — happy to share a deck in advance if helpful"
6. Sign-off with title and links

Instagram DM structure:
1. Casual greeting + one specific thing you love about their brand (reference a recent post or product)
2. What you built: one sentence
3. Paint the collab picture briefly
4. CTA: "quick call or I can send a short video walkthrough — whatever's easier"

Follow-up (Day 5) structure:
- 2–3 sentences max
- Don't re-pitch — just remind
- Lower the commitment: "10-min walkthrough" instead of "15-min call"

## CRITICAL RULES
- Every message MUST reference something specific about Brand 1 — not generic praise
- Every message MUST paint a concrete picture of what the Brand 1 × Brand 2 bundle could look like, ideally naming specific products from both brands
- Messages must be in Sean's builder/founder voice — NOT salesy, NOT corporate
- Conversation starters must be specific enough that Brand 1 thinks "this person actually follows us"
- If you don't have confident information about recent specific events for a brand, describe what you do know accurately and note what to verify — do NOT fabricate specific dates, revenue figures, or press mentions
- Return ONLY valid JSON matching the exact schema specified — no markdown fences, no explanation text before or after`;

function buildPitchUserPrompt(brand1Name, brand2Name, context) {
  // Build rich context block from existing app data
  let contextBlock = `Brand 1 (the brand Sean is pitching TO — the recipient): ${brand1Name}
Brand 2 (the brand Sean is suggesting Brand 1 should collaborate WITH via OfferLab): ${brand2Name}`;

  if (context) {
    contextBlock += '\n\n=== CONTEXT WE ALREADY KNOW ===\n';

    if (context.searchedBrand) {
      const sb = context.searchedBrand;
      contextBlock += `\nAbout ${brand1Name}:\n`;
      if (sb.description) contextBlock += `- Description: ${sb.description}\n`;
      if (sb.brandDNA) contextBlock += `- Brand DNA: ${sb.brandDNA}\n`;
      if (sb.targetCustomer) contextBlock += `- Target Customer: ${sb.targetCustomer}\n`;
      if (sb.url) contextBlock += `- Website: ${sb.url}\n`;
    }

    if (context.recommendedBrand) {
      const rb = context.recommendedBrand;
      contextBlock += `\nAbout ${brand2Name}:\n`;
      if (rb.url) contextBlock += `- Website: ${rb.url}\n`;
      if (rb.category) contextBlock += `- Collaboration angle: ${rb.category}\n`;
      if (rb.brandStage) contextBlock += `- Brand stage: ${rb.brandStage}\n`;
      if (rb.reason) contextBlock += `- Why this is a good collab match: ${rb.reason}\n`;
      if (rb.bundleIdea) contextBlock += `- Bundle concept: ${rb.bundleIdea}\n`;
    }
  }

  return `Generate a personalized outreach strategy and messages.

${contextBlock}

Use all the context above to write highly personalized, specific outreach. Return a JSON object matching this exact schema:

{
  "channel_recommendation": {
    "primary_channel": "linkedin_dm | instagram_dm | email | video_loom",
    "channel_display_name": "Human-readable channel name (e.g. 'LinkedIn DM')",
    "reasoning": "2-3 sentences explaining WHY this channel is best for this specific brand, referencing brand signals you observed",
    "suggested_contacts": [
      {
        "name": "Real full name if known, otherwise a role title like 'Head of Partnerships'",
        "title": "Their role/title at the brand",
        "tier": 1,
        "why": "One sentence on why this specific person is the right target",
        "linkedin_url": "LinkedIn search URL to find this person (https://www.linkedin.com/search/results/people/?keywords=Name+Company)",
        "email": "Best-guess email address or null if unknown"
      }
    ],
    "backup_channel": "linkedin_dm | instagram_dm | email",
    "backup_display_name": "Human-readable backup channel name"
  },
  "messages": {
    "primary": {
      "channel": "linkedin_dm | instagram_dm | email | video_loom",
      "channel_label": "LinkedIn DM",
      "recipient": "Name — Title at Brand",
      "subject": "Email subject line, or null for DMs",
      "body": "The full drafted message in Sean's voice"
    },
    "secondary": {
      "channel": "backup channel type",
      "channel_label": "Email",
      "recipient": "Name — Title at Brand",
      "subject": "Subject line or null",
      "body": "Alternative message for the backup channel"
    },
    "follow_up": {
      "channel_label": "Follow-Up (Day 5)",
      "body": "Short 2-3 sentence follow-up"
    }
  },
  "brand_intelligence": {
    "brand_1": {
      "name": "Brand 1's name",
      "summary": "2-3 sentence brand overview — what they sell, who they are, what makes them interesting",
      "noteworthy": [
        "A specific recent product launch, collab, press mention, or milestone",
        "Another noteworthy detail",
        "A third item if available"
      ],
      "conversation_starters": [
        "A specific, natural thing Sean could mention to show he genuinely follows their brand",
        "Another conversation starter"
      ]
    },
    "brand_2": {
      "name": "Brand 2's name",
      "summary": "2-3 sentence brand overview",
      "noteworthy": [
        "A specific detail about this brand",
        "Another item"
      ],
      "conversation_starters": [
        "Something that connects Brand 2 to Brand 1 and makes the collab feel like a natural fit",
        "Another angle"
      ]
    }
  }
}`;
}

/* --- Pitch Utilities --- */

function escapeHtml(str) {
  if (!str) return '';
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

async function copyPitchMessage(elementId, buttonEl) {
  const el = document.getElementById(elementId);
  if (!el) return;
  try {
    await navigator.clipboard.writeText(el.textContent);
    buttonEl.textContent = 'Copied!';
    buttonEl.classList.add('copied');
    setTimeout(() => {
      buttonEl.textContent = 'Copy';
      buttonEl.classList.remove('copied');
    }, 2000);
  } catch {
    // Fallback for older browsers
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('copy');
    sel.removeAllRanges();
    buttonEl.textContent = 'Copied!';
    buttonEl.classList.add('copied');
    setTimeout(() => {
      buttonEl.textContent = 'Copy';
      buttonEl.classList.remove('copied');
    }, 2000);
  }
}

/* --- Pitch API Call --- */

async function generatePitchContent(brand1, brand2, model, context, { signal } = {}) {
  console.log(`[Pitch] Generating pitch: ${brand1} ↔ ${brand2} (model: ${model})`);

  const requestBody = {
    system_instruction: {
      parts: [{ text: PITCH_SYSTEM_PROMPT }]
    },
    contents: [{
      parts: [{ text: buildPitchUserPrompt(brand1, brand2, context) }]
    }],
    generationConfig: {
      temperature: 0.8,
      topP: 0.95,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json'
    }
  };

  const response = await fetch(`/api/gemini?model=${encodeURIComponent(model)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(errData.error || `API request failed (${response.status})`);
  }

  const data = await response.json();
  console.log('[Pitch] Raw API response:', JSON.stringify(data).substring(0, 500));

  const parts = data.candidates?.[0]?.content?.parts || [];
  const textPart = parts.find(p => p.text);
  const text = textPart?.text;
  if (!text) {
    console.error('[Pitch] No text found in parts:', JSON.stringify(parts).substring(0, 300));
    throw new Error('No response from Gemini');
  }

  // Strip potential markdown fences (Gemini sometimes wraps even with responseMimeType)
  const cleaned = text.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();

  let result;
  try {
    result = JSON.parse(cleaned);
  } catch (parseErr) {
    // Try jsonrepair as fallback
    try {
      result = JSON.parse(jsonrepair(cleaned));
    } catch {
      console.error('[Pitch] Failed to parse JSON:', cleaned.substring(0, 300));
      throw new Error('Failed to parse Gemini response as JSON');
    }
  }

  console.log('[Pitch] Parsed response:', result);
  return result;
}

/* --- Pitch Modal State Rendering --- */

function renderPitchInitialState(brand1, brand2) {
  const modelOptions = PITCH_MODELS.map(m =>
    `<option value="${m.value}"${m.value === currentPitchModel ? ' selected' : ''}>${escapeHtml(m.label)}</option>`
  ).join('');

  elements.pitchModalContent.innerHTML = `
    <div class="pitch-initial">
      <div class="pitch-model-select-group">
        <label class="pitch-model-label" for="pitchModelSelect">Model</label>
        <select class="pitch-model-select" id="pitchModelSelect">${modelOptions}</select>
      </div>
      <p class="pitch-description">AI will research both brands, recommend the best outreach channel and contacts, draft personalized messages in your voice, and surface noteworthy details for conversation starters.</p>
      <button type="button" class="pitch-generate-btn" id="pitchGenerateBtn">
        ${icon('ai-sparkles-two-filled', { size: 18 })}
        Generate Pitch
      </button>
    </div>
  `;

  setPitchToolbarState('hidden');
}

function renderQuickLinksCard(searchedBrand, partnerBrand) {
  const container = elements.pitchQuickLinks;
  if (!container) return;

  const brands = [
    { name: searchedBrand?.name || 'Brand 1', url: searchedBrand?.url || '', social: searchedBrand?.social || {} },
    { name: partnerBrand?.name || 'Brand 2', url: partnerBrand?.url || '', social: partnerBrand?.social || {} }
  ];

  const websiteIcon = `${icon('globus', { size: 20 })}`;

  function buildBrandLinks(brand) {
    const links = [];
    const domain = extractDomain(brand.url || '');
    const faviconSrc = domain ? getFaviconUrl(domain) : '';

    // Website link (always show if URL exists)
    if (brand.url) {
      const displayUrl = domain || brand.url.replace(/^https?:\/\//, '');
      links.push(`
        <a href="${escapeHtml(brand.url)}" target="_blank" rel="noopener noreferrer" class="quick-link-row">
          <span class="quick-link-label">${escapeHtml(displayUrl)}</span>
          <span class="quick-link-icon">${websiteIcon}</span>
        </a>
      `);
    }

    socialEntries(brand.social).forEach(entry => {
      const label = entry.key === 'facebook' ? entry.label : `@${entry.handle}`;
      links.push(`
        <a href="${escapeHtml(entry.url)}" target="_blank" rel="noopener noreferrer" class="quick-link-row">
          <span class="quick-link-label">${escapeHtml(label)}</span>
          <span class="quick-link-icon">${icon(entry.icon, { size: 20 })}</span>
        </a>
      `);
    });

    return { links, faviconSrc };
  }

  const brand1Data = buildBrandLinks(brands[0]);
  const brand2Data = buildBrandLinks(brands[1]);

  // Only render if at least one brand has links
  if (brand1Data.links.length === 0 && brand2Data.links.length === 0) {
    container.innerHTML = '';
    return;
  }

  function renderBrandGroup(brandName, faviconSrc, links) {
    if (links.length === 0) return '';
    return `
      <div class="quick-links-group">
        <div class="quick-links-group-header">
          ${faviconSrc ? `<img class="quick-links-favicon" src="${faviconSrc}" alt="" onerror="this.style.display='none'" />` : ''}
          <span class="quick-links-brand-name">${escapeHtml(brandName)}</span>
        </div>
        <div class="quick-links-list">
          ${links.join('')}
        </div>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="pitch-quick-links-card">
    <div class="pitch-section-header">
      <h3 class="pitch-section-title">Connect</h3>
          </div>
      ${renderBrandGroup(brands[0].name, brand1Data.faviconSrc, brand1Data.links)}
      ${brand1Data.links.length > 0 && brand2Data.links.length > 0 ? '<div class="quick-links-divider"></div>' : ''}
      ${renderBrandGroup(brands[1].name, brand2Data.faviconSrc, brand2Data.links)}
    </div>
  `;
}

function renderPitchLoadingState() {
  elements.pitchModalContent.innerHTML = `
    <div class="pitch-results">
      <!-- Skeleton: Channel & Contacts -->
      <div class="pitch-section pitch-skeleton-section">
        <div class="pitch-section-header">
          <div class="pitch-skeleton-line" style="width: 55%; height: 14px;"></div>
        </div>
        <div class="pitch-section-content">
          <div class="pitch-skeleton-card-green">
            <div class="pitch-skeleton-line short"></div>
            <div class="pitch-skeleton-line wide"></div>
            <div class="pitch-skeleton-line full"></div>
            <div class="pitch-skeleton-line" style="width: 75%;"></div>
          </div>
          <div class="pitch-skeleton-line" style="width: 40%; height: 8px;"></div>
          <div class="pitch-contacts-list">
            <div class="pitch-skeleton-chip"></div>
            <div class="pitch-skeleton-chip"></div>
          </div>
          <div class="pitch-skeleton-line full"></div>
          <div class="pitch-skeleton-line" style="width: 60%;"></div>
        </div>
      </div>

      <!-- Skeleton: Messages -->
      <div class="pitch-section pitch-skeleton-section">
        <div class="pitch-section-header">
          <div class="pitch-skeleton-line" style="width: 35%; height: 14px;"></div>
        </div>
        <div class="pitch-section-content">
          <div class="pitch-messages">
            <div class="pitch-message-card pitch-skeleton-msg">
              <div class="pitch-skeleton-msg-header"></div>
              <div class="pitch-skeleton-msg-body">
                <div class="pitch-skeleton-line full"></div>
                <div class="pitch-skeleton-line full"></div>
                <div class="pitch-skeleton-line" style="width: 90%;"></div>
                <div class="pitch-skeleton-line" style="width: 65%;"></div>
              </div>
            </div>
            <div class="pitch-message-card pitch-skeleton-msg">
              <div class="pitch-skeleton-msg-header"></div>
              <div class="pitch-skeleton-msg-body">
                <div class="pitch-skeleton-line full"></div>
                <div class="pitch-skeleton-line full"></div>
                <div class="pitch-skeleton-line" style="width: 75%;"></div>
              </div>
            </div>
            <div class="pitch-message-card pitch-skeleton-msg">
              <div class="pitch-skeleton-msg-header"></div>
              <div class="pitch-skeleton-msg-body">
                <div class="pitch-skeleton-line full"></div>
                <div class="pitch-skeleton-line" style="width: 80%;"></div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Skeleton: Brand Intel -->
      <div class="pitch-section pitch-skeleton-section">
        <div class="pitch-section-header">
          <div class="pitch-skeleton-line" style="width: 30%; height: 14px;"></div>
        </div>
        <div class="pitch-section-content">
          <div class="pitch-brand-grid">
            <div class="pitch-skeleton-brand-card">
              <div class="pitch-skeleton-line wide"></div>
              <div class="pitch-skeleton-line full"></div>
              <div class="pitch-skeleton-line" style="width: 80%;"></div>
              <div class="pitch-skeleton-line" style="width: 55%;"></div>
            </div>
            <div class="pitch-skeleton-brand-card">
              <div class="pitch-skeleton-line wide"></div>
              <div class="pitch-skeleton-line full"></div>
              <div class="pitch-skeleton-line" style="width: 70%;"></div>
              <div class="pitch-skeleton-line" style="width: 50%;"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderPitchError(errorMessage) {
  elements.pitchModalContent.innerHTML = `
    <div class="pitch-error">
      ${icon('triangle-exclamation-filled', { class: 'pitch-error-icon' })}
      <p class="pitch-error-message">${escapeHtml(errorMessage)}</p>
      <button type="button" class="pitch-try-again-btn" id="pitchTryAgainBtn">Try Again</button>
    </div>
  `;
}

function renderPitchResults(data) {
  const channelHtml = renderChannelSection(data.channel_recommendation);
  const messagesHtml = renderMessagesSection(data.messages);
  const intelligenceHtml = renderBrandIntelligenceSection(data.brand_intelligence);

  elements.pitchModalContent.innerHTML = `
    <div class="pitch-results">
      ${channelHtml}
      ${messagesHtml}
      ${intelligenceHtml}
    </div>
  `;
}

/* --- Section Renderers --- */

function renderChannelSection(channel) {
  if (!channel) return '';

  // Contacts chips with LinkedIn & email links
  const contacts = channel.suggested_contacts || [];
  const chipsHtml = contacts.map(c => {
    const linkedinUrl = c.linkedin_url ? escapeHtml(c.linkedin_url) : null;
    const email = c.email ? escapeHtml(c.email) : null;

    // Build icon buttons
    const iconButtons = [];
    if (linkedinUrl) {
      iconButtons.push(`<a href="${linkedinUrl}" target="_blank" rel="noopener noreferrer" class="pitch-contact-icon-btn" title="LinkedIn">${icon('linkedin', { size: 18 })}</a>`);
    }
    if (email) {
      iconButtons.push(`<a href="mailto:${email}" class="pitch-contact-icon-btn" title="${email}">${icon('email-1', { size: 18 })}</a>`);
    }
    const actionsHtml = iconButtons.length > 0 ? `<div class="pitch-contact-actions">${iconButtons.join('')}</div>` : '';

    return `
      <div class="pitch-contact-chip">
        <div class="pitch-contact-avatar">${escapeHtml(getInitials(c.name))}</div>
        <div class="pitch-contact-info">
          <span class="pitch-contact-name">${escapeHtml(c.name)}</span>
          <span class="pitch-contact-title">${escapeHtml(c.title)}</span>
        </div>
        ${actionsHtml}
      </div>
    `;
  }).join('');

  // Contact why details
  const contactDetailsHtml = contacts.map(c => `
    <p class="pitch-contact-why"><strong>Tier ${c.tier} — ${escapeHtml(c.name)}:</strong> ${escapeHtml(c.why)}</p>
  `).join('');

  return `
    <div class="pitch-section" data-section="channel">
      <div class="pitch-section-header">
        <h3 class="pitch-section-title">Channel & Contacts</h3>
        ${icon('chevron-bottom', { class: 'pitch-section-chevron' })}
      </div>
      <div class="pitch-section-content">
        <div class="pitch-channel-card">
          <p class="pitch-channel-label">Recommended Channel</p>
          <p class="pitch-channel-name">${escapeHtml(channel.channel_display_name)}</p>
          <p class="pitch-channel-reasoning">${escapeHtml(channel.reasoning)}</p>
        </div>
        ${contacts.length > 0 ? `
          <p class="pitch-contacts-heading">Suggested Contacts</p>
          <div class="pitch-contacts-list">${chipsHtml}</div>
          <div class="pitch-contact-details">${contactDetailsHtml}</div>
        ` : ''}
        ${channel.backup_display_name ? `
          <p class="pitch-backup-channel"><strong>Backup channel (Day 10–14):</strong> ${escapeHtml(channel.backup_display_name)}</p>
        ` : ''}
      </div>
    </div>
  `;
}

function renderMessagesSection(messages) {
  if (!messages) return '';

  const messageCards = [];

  // Primary
  if (messages.primary) {
    messageCards.push(renderSingleMessage(messages.primary, 'msg-primary'));
  }

  // Secondary
  if (messages.secondary) {
    messageCards.push(renderSingleMessage(messages.secondary, 'msg-secondary'));
  }

  // Follow-up (fewer fields)
  if (messages.follow_up) {
    messageCards.push(renderSingleMessage(messages.follow_up, 'msg-followup'));
  }

  return `
    <div class="pitch-section" data-section="messages">
      <div class="pitch-section-header">
        <h3 class="pitch-section-title">Messages</h3>
        ${icon('chevron-bottom', { class: 'pitch-section-chevron' })}
      </div>
      <div class="pitch-section-content">
        <div class="pitch-messages">${messageCards.join('')}</div>
      </div>
    </div>
  `;
}

function renderSingleMessage(msg, id) {
  const channelLabel = escapeHtml(msg.channel_label || '');
  const hasSubject = msg.subject != null && msg.subject !== '';
  const body = escapeHtml(msg.body || '');

  return `
    <div class="pitch-message-card">
      <div class="pitch-message-header">
        <span class="pitch-message-channel">${channelLabel}</span>
        <button type="button" class="pitch-copy-btn" data-copy-target="${id}">${icon('copy-2-layers-pages')} Copy</button>
      </div>
      ${hasSubject ? `<p class="pitch-message-subject"><strong>Subject:</strong> ${escapeHtml(msg.subject)}</p>` : ''}
      <div class="pitch-message-body" id="${id}">${body}</div>
    </div>
  `;
}

function renderBrandIntelligenceSection(intelligence) {
  if (!intelligence) return '';

  // Get domains for favicons
  const searchedDomain = extractDomain(currentResults?.searchedBrand?.url || '');
  const partnerDomain = extractDomain(currentPitchBrand?.url || '');

  const renderBrandCard = (brand, domain) => {
    if (!brand) return '';

    const faviconSrc = domain ? getFaviconUrl(domain) : '';
    const noteworthy = (brand.noteworthy || []).map(n =>
      `<li>${escapeHtml(n)}</li>`
    ).join('');

    const starters = (brand.conversation_starters || []).map(s =>
      `<li>${escapeHtml(s)}</li>`
    ).join('');

    return `
      <div class="pitch-brand-card">
        <div class="pitch-brand-card-header">
          ${faviconSrc ? `<img class="pitch-brand-favicon" src="${faviconSrc}" alt="" onerror="this.style.display='none'" />` : ''}
          <h4 class="pitch-brand-name">${escapeHtml(brand.name)}</h4>
        </div>
        <p class="pitch-brand-summary">${escapeHtml(brand.summary)}</p>
        ${noteworthy ? `
          <div>
            <p class="pitch-noteworthy-label">Noteworthy</p>
            <ul class="pitch-noteworthy-list">${noteworthy}</ul>
          </div>
        ` : ''}
        ${starters ? `
          <div class="pitch-starters-box">
            <p class="pitch-starters-label">Conversation Starters</p>
            <ul class="pitch-starters-list">${starters}</ul>
          </div>
        ` : ''}
      </div>
    `;
  };

  return `
    <div class="pitch-section" data-section="intelligence">
      <div class="pitch-section-header">
        <h3 class="pitch-section-title">Brand Intel</h3>
        ${icon('chevron-bottom', { class: 'pitch-section-chevron' })}
      </div>
      <div class="pitch-section-content">
        <div class="pitch-brand-grid">
          ${renderBrandCard(intelligence.brand_1, searchedDomain)}
          ${renderBrandCard(intelligence.brand_2, partnerDomain)}
        </div>
      </div>
    </div>
  `;
}

/* --- Pitch Modal Open/Close --- */

function openPitchModal(brand, { skipUrlUpdate = false } = {}) {
  currentPitchBrand = brand;

  // brand1 = searched brand (pitched TO), brand2 = recommended brand (collab WITH)
  const searchedBrand = currentResults?.searchedBrand;
  currentPitchBrand1 = searchedBrand?.name || 'Unknown Brand';
  currentPitchBrand2 = brand.name || 'Unknown Brand';

  console.log(`[PitchModal] Opening — pitching ${currentPitchBrand1} to collab with ${currentPitchBrand2}`);

  // Compute domains for favicons
  const searchedDomain = extractDomain(searchedBrand?.url || '');
  const partnerDomain = extractDomain(brand.url || '');

  // Set header with favicon duo + title + subtitle in a row
  const duoHtml = (searchedDomain && partnerDomain) ? renderFaviconDuo(searchedDomain, partnerDomain) : '';
  elements.pitchModalSubtitle.innerHTML = `
    ${duoHtml}
    <div class="modal-header-labels">
      <h2 class="modal-title">Create pitch</h2>
      <p class="modal-subtitle-text">${escapeHtml(currentPitchBrand1)} &times; ${escapeHtml(currentPitchBrand2)}</p>
    </div>
  `;

  // Render quick links card for both brands
  renderQuickLinksCard(searchedBrand, brand);

  // Show modal
  elements.pitchModalOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // Update URL with pitch param
  if (!skipUrlUpdate) {
    const url = new URL(window.location.href);
    url.searchParams.set('pitch', brand.name);
    history.pushState(null, '', url.toString());
  }

  // Check pitch cache — if we already generated this pitch, render instantly
  const cacheKey = `${currentPitchBrand1}|${currentPitchBrand2}`;
  const cached = pitchCache.get(cacheKey);
  if (cached) {
    console.log(`[PitchModal] Cache hit for "${cacheKey}"`);
    renderPitchResults(cached);
    return;
  }

  // No cache — generate fresh
  triggerPitchGeneration();
}

function closePitchModal() {
  const overlay = elements.pitchModalOverlay;
  const modal = elements.pitchModal;

  // If already hidden or already closing, bail
  if (overlay.classList.contains('hidden') || overlay.classList.contains('closing')) return;

  // Abort any in-flight generation
  if (pitchAbortController) {
    pitchAbortController.abort();
    pitchAbortController = null;
  }
  isPitchGenerating = false;

  // Add closing classes to trigger reverse animations
  overlay.classList.add('closing');
  modal.classList.add('closing');

  // Remove pitch param from URL
  const url = new URL(window.location.href);
  if (url.searchParams.has('pitch')) {
    url.searchParams.delete('pitch');
    history.pushState(null, '', url.toString());
  }

  // Wait for animation to finish, then actually hide
  modal.addEventListener('animationend', function onEnd() {
    modal.removeEventListener('animationend', onEnd);
    overlay.classList.add('hidden');
    overlay.classList.remove('closing');
    modal.classList.remove('closing');
    document.body.style.overflow = '';
    currentPitchBrand = null;
    currentPitchBrand1 = null;
    currentPitchBrand2 = null;
  }, { once: true });
}

function setPitchToolbarState(state) {
  // state: 'generating' | 'regenerate' | 'hidden'
  const btn = elements.pitchToolbarBtn;
  if (!btn) return;

  btn.classList.remove('hidden', 'is-generating');

  if (state === 'generating') {
    btn.classList.add('is-generating');
  } else if (state === 'regenerate') {
    // Default pill button state — no extra class needed
  } else {
    btn.classList.add('hidden');
  }
}

function cancelPitchGeneration() {
  console.log('[PitchModal] User cancelled generation');
  isPitchGenerating = false;
  if (pitchAbortController) {
    pitchAbortController.abort();
    pitchAbortController = null;
  }
  setPitchToolbarState('regenerate');
  renderPitchError('Generation cancelled.');
}

async function triggerPitchGeneration() {
  if (!currentPitchBrand1 || !currentPitchBrand2) return;

  // Abort any in-flight generation
  if (pitchAbortController) {
    pitchAbortController.abort();
  }
  pitchAbortController = new AbortController();
  isPitchGenerating = true;

  // Show generating state on toolbar button
  setPitchToolbarState('generating');

  renderPitchLoadingState();

  // Build rich context from existing search results
  const context = {
    searchedBrand: currentResults?.searchedBrand || null,
    recommendedBrand: currentPitchBrand || null
  };

  try {
    const result = await generatePitchContent(
      currentPitchBrand1, currentPitchBrand2, currentPitchModel, context,
      { signal: pitchAbortController.signal }
    );

    // If aborted between await and here, bail
    if (!isPitchGenerating) return;

    isPitchGenerating = false;
    pitchAbortController = null;

    // Cache the result
    const cacheKey = `${currentPitchBrand1}|${currentPitchBrand2}`;
    pitchCache.set(cacheKey, result);
    console.log(`[PitchModal] Cached pitch for "${cacheKey}"`);

    setPitchToolbarState('regenerate');
    renderPitchResults(result);
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('[Pitch] Generation aborted by user');
      return; // cancelPitchGeneration already handled the UI
    }
    console.error('[Pitch] Generation failed:', err);
    isPitchGenerating = false;
    pitchAbortController = null;
    setPitchToolbarState('regenerate');
    renderPitchError(err.message || 'An unexpected error occurred. Please try again.');
  }
}

/* --------------------------------------------------------------------------
   AI Integration - Gemini API
   -------------------------------------------------------------------------- */

function buildFeedbackContext() {
  const feedback = getFeedbackHistory();
  if (feedback.length === 0) return '';

  const positive = feedback.filter(f => f.rating === 'positive');
  const negative = feedback.filter(f => f.rating === 'negative');

  let context = '\n\nHISTORICAL FEEDBACK (use to improve relevance):\n';

  if (positive.length > 0) {
    const positiveBrands = positive.flatMap(f => f.results.map(r => r.name)).slice(-20);
    context += `Users responded positively to brands like: ${positiveBrands.join(', ')}\n`;
  }

  if (negative.length > 0) {
    const negativeBrands = negative.flatMap(f => f.results.map(r => r.name)).slice(-10);
    context += `Users responded negatively to brands like: ${negativeBrands.join(', ')}\n`;
  }

  context += 'Optimize for brands similar to positive examples.\n';

  return context;
}

// ============================================
// LOADING MESSAGES
// ============================================
const LOADING_MESSAGES = [
  "Researching your brand...",
  "Analyzing products, audience & market position...",
  "Finding complementary brands...",
  "Verifying product recommendations...",
  "Fetching product images...",
  "Finalizing results..."
];

// ============================================
// MAIN FUNCTION (Decoupled: Brands first, Products in parallel)
// ============================================
async function discoverComplementaryBrands(url, { onProgress, onBrandsReady, onCatalog } = {}) {
  const domain = extractDomain(url);
  const brandName = extractBrandName(domain);
  const feedbackContext = buildFeedbackContext();

  const updateProgress = (index) => {
    if (onProgress && typeof onProgress === 'function') {
      onProgress(LOADING_MESSAGES[index] ?? LOADING_MESSAGES[0]);
    }
  };

  console.log(`[Discovery] Starting for: ${domain} (brand: ${brandName})`);

  try {
    // ========================================
    // PHASE 1: Deep Brand Analysis
    // ========================================
    updateProgress(0); // "Researching your brand..."

    const brandProfile = await analyzeBrand(domain);
    const resolvedBrandProfile = brandProfile.brandProfile || brandProfile;

    updateProgress(1); // "Analyzing products, audience & market position..."

    // ========================================
    // PHASE 2: Get Brand & Product Recommendations (Gemini)
    // ========================================
    updateProgress(2); // "Finding complementary brands..."

    const recommendations = await getRecommendations(resolvedBrandProfile, brandName, domain, feedbackContext);

    // Augment brands with grounding metadata
    const augmentedResults = augmentWithGroundingMetadata(recommendations, null);
    
    // Sanitize brand URLs
    const brands = (augmentedResults.brands || []).map(ensureHttps);

    // Build searchedBrand from analysis
    let searchedBrand = ensureHttps(resolvedBrandProfile);

    // Fetch OG image for searched brand if missing (do this quickly)
    if (!searchedBrand.imageUrl && searchedBrand.url) {
      searchedBrand.imageUrl = await fetchOgImageUrl(searchedBrand.url);
    }

    const searchedBrandData = {
      name: searchedBrand.name,
      url: searchedBrand.url,
      imageUrl: searchedBrand.imageUrl,
      description: searchedBrand.description,
      brandDNA: searchedBrand.brandDNA,
      targetCustomer: searchedBrand.targetCustomer
    };

    // ========================================
    // BRANDS ARE READY - Notify callback immediately
    // ========================================
    console.log(`[Discovery] Brands ready: ${brands.length} brands found`);
    
    if (onBrandsReady && typeof onBrandsReady === 'function') {
      onBrandsReady({ searchedBrand: searchedBrandData, brands });
    }

    // ========================================
    // PHASE 3: Public catalogs for the searched brand and every recommendation
    // ========================================
    console.log('[Discovery] PHASE 3: Fetching public catalogs...');
    await attachCatalogs([searchedBrandData, ...brands], onCatalog);

    // ========================================
    // PHASE 4: Google Shopping only for brands without a public catalog (paid, 1 search per brand)
    // ========================================
    const fallbackBrands = brands.filter(b => b.catalog?.status !== 'shopify').slice(0, CONFIG.SERP_FALLBACK_BRANDS);
    let serpApiOutOfCredits = false;
    if (fallbackBrands.length > 0) {
      console.log(`[Discovery] PHASE 4: SERP fallback for ${fallbackBrands.length} brands without a catalog`);
      const serpResult = await fetchProductsFromBrands(fallbackBrands, brandName);
      if (serpResult && serpResult.outOfCredits) {
        serpApiOutOfCredits = true;
      } else if (Array.isArray(serpResult)) {
        fallbackBrands.forEach(brand => {
          const products = serpResult
            .filter(p => p.brandName === brand.name)
            .map(p => ({ id: p.url, title: p.productName, url: p.url, image: p.imageUrl, price: typeof p.price === 'number' ? p.price : null }));
          if (products.length === 0) return;
          brand.catalog = { ...brand.catalog, status: 'serp', count: products.length, products };
          if (onCatalog) onCatalog(brand);
        });
      }
    }

    console.log(`[Discovery] Complete. ${brands.length} brands, ${brands.filter(b => b.catalog?.products?.length).length} with products`);

    return {
      searchedBrand: searchedBrandData,
      brands,
      serpApiOutOfCredits
    };

  } catch (error) {
    console.error('[Discovery] Error:', error);
    throw error;
  }
}

// ============================================
// PHASE 1: Brand Analysis
// ============================================
async function analyzeBrand(domain) {
  const prompt = `You are a brand strategist with deep expertise in DTC e-commerce, CPG, and lifestyle brands.

TASK: Perform a comprehensive analysis of this brand before we identify collaboration partners.

INPUT URL: ${domain}

Use web search to research this brand thoroughly. Visit their website, look up press coverage, social media presence, and any available information.

Return your analysis as JSON:

{
  "brandProfile": {
    "name": "Brand Name",
    "url": "https://full-url.com",
    "tagline": "Their tagline or positioning statement if available",
    
    "productAnalysis": {
      "primaryCategory": "e.g., Specialty Foods, Skincare, Home Goods",
      "subcategories": ["specific product types they sell"],
      "heroProducts": ["their 2-3 most popular/signature items"],
      "priceRange": {
        "tier": "budget|mid-market|premium|luxury",
        "typicalPrice": "$XX-$XX range"
      }
    },
    
    "brandDNA": {
      "aesthetic": "2-3 words describing visual style (e.g., 'minimalist California', 'rustic artisanal', 'bold maximalist')",
      "personality": "2-3 words describing brand voice (e.g., 'playful irreverent', 'sophisticated educational', 'warm approachable')",
      "coreValues": ["sustainability", "craftsmanship", "innovation", etc.],
      "originStory": "1 sentence on founding story or brand ethos if known"
    },
    
    "targetCustomer": {
      "persona": "Specific description (e.g., 'health-conscious millennials who cook at home', 'design-forward homeowners')",
      "lifestyle": "What broader lifestyle does this customer lead?",
      "occasions": ["when/why they buy these products"],
      "adjacentInterests": ["what else this customer likely cares about"]
    },
    
    "marketPosition": {
      "competitors": ["2-3 direct competitors"],
      "differentiator": "What makes them unique vs competitors",
      "brandStage": "emerging|growing|established|iconic"
    },
    
    "description": "Exactly 3 sentences: (1) What they sell and their unique approach, (2) Who their customer is, (3) What makes the brand special or noteworthy."
  }
}

Be specific and insightful. This analysis will drive high-quality collaboration recommendations.`;

  const response = await fetchWithRetry(CONFIG.GEMINI_PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      systemInstruction: {
        parts: [{ text: 'You are a brand analyst. Use web search to research thoroughly. Return only valid JSON.' }]
      },
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.3,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingBudget: 0 }
      }
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(`Brand analysis failed: ${response.status} - ${errorData.error || 'Unknown error'}`);
  }

  const data = await response.json();
  const text = extractText(data);
  return parseJsonResponse(text);
}

// ============================================
// PHASE 2: Get Recommendations (Gemini - Brands get URLs)
// ============================================
async function getRecommendations(brandProfile, brandName, domain, feedbackContext) {
  const prompt = `You are a world-class brand collaboration curator—part trend forecaster, part matchmaker, part cultural observer.

Your mission: Identify brands that would create EXCEPTIONAL, UNEXPECTED, and COMMERCIALLY VIABLE collaboration opportunities.

=== THE BRAND SEEKING COLLABORATORS ===
${JSON.stringify(brandProfile, null, 2)}

=== YOUR COLLABORATION PHILOSOPHY ===

Great brand collaborations share these traits:
1. **Complementary, not competitive** - Products that enhance each other's use
2. **Audience overlap with discovery** - Shared customer values, but introduces something new
3. **Story synergy** - The "why" of the partnership is immediately obvious and compelling
4. **Elevation** - Both brands benefit; neither feels like they're "trading down"
5. **Bundle logic** - You can envision the actual product bundle or campaign

=== RECOMMENDATION DIMENSIONS ===

For each brand, classify using ONE of these collaboration angles:
- **"same-moment"**: Products used in the same occasion/ritual
- **"same-aesthetic"**: Brands that share visual/design language across different categories
- **"same-values"**: Aligned on mission but different products
- **"gift-pairing"**: Products that make sense as a gift set together
- **"lifestyle-stack"**: Part of the same customer's broader lifestyle/identity
- **"unexpected-delight"**: Non-obvious pairing that tells a story

=== DIVERSITY REQUIREMENTS ===

Your 12-15 brand recommendations MUST include:
- At least 5 **emerging brands** (founded 2020+, under $10M revenue)
- At least 4 **established brands** (well-known, proven track record)
- At least 1 **non-obvious category** (digital product, subscription, experience)
- Mix of price points that make sense for the input brand's customer
- NO direct competitors to the input brand

=== ANTI-PATTERNS TO AVOID ===

DO NOT recommend:
- **ANY products from ${brandName} or ${domain}** - We are finding EXTERNAL collaboration partners
- Generic/obvious choices (e.g., any food brand gets "Whole Foods" or "Williams Sonoma")
- Amazon private label or mass-market brands unless there's a compelling story
- Brands with no distinct identity or commodity products
- The same brands you'd recommend for any brand in this category
- Made-up or fictional products - only recommend REAL products you can verify exist

=== RESEARCH INSTRUCTIONS ===

${feedbackContext}

For EACH brand you recommend:
1. Use web search to verify the brand exists and is active
2. Find their actual website URL from search results
3. Search for their social media handles
4. Find 2-4 specific products from that brand

CRITICAL - For brand URLs: Search for the brand and use their ACTUAL homepage URL from search results. Never guess URLs.

=== OUTPUT FORMAT ===

Return valid JSON only:

{
  "brands": [
    {
      "name": "Brand Name",
      "url": "https://actualbrandwebsite.com",
      "category": "same-moment|same-aesthetic|same-values|gift-pairing|lifestyle-stack|unexpected-delight",
      "brandStage": "emerging|growing|established",
      "reasons": ["3 short bullets on why this collab works with ${brandName}. Each is its own angle: the shared customer moment, the aesthetic or values overlap, and what the pairing unlocks commercially. Under 12 words each, playful and concrete, naming real products or details rather than generic praise. No em dashes, no restating the brand's tagline."],
      "bundleIdea": "One sentence describing a specific product bundle or campaign concept",
      "social": {
        "tiktok": "handle or null",
        "instagram": "handle or null",
        "facebook": "handle or null"
      }
    }
  ],
  "products": [
    {
      "productName": "EXACT Product Name as it appears on the brand's website",
      "brandName": "Brand Name (MUST be different from ${brandName})",
      "brandDomain": "brandname.com",
      "whyThisProduct": "1 sentence on why this specific product pairs well",
      "suggestedBundle": "What ${brandName} product would this pair with?",
      "estimatedPrice": "$XX",
      "social": {
        "tiktok": "handle or null",
        "instagram": "handle or null",
        "facebook": "handle or null"
      }
    }
  ]
}

Requirements:
- 12-15 brands with diversity requirements met
- 20-25 products total
- At least 2 products per recommended brand
- ZERO products from ${brandName} - this is critical
- Specific, REAL product names that can be found via search
- Brand URLs must be real homepage URLs from search results`;

  const systemInstruction = `You are an expert brand collaboration curator. Your recommendations should be specific, creative, and commercially viable.

CRITICAL INSTRUCTIONS:
1. Always use Google Search to research brands and verify information
2. Return ONLY valid JSON—no markdown, no explanations outside the JSON
3. Brand URLs MUST come from search results—never construct or guess URLs
4. Be specific in your reasoning—generic explanations indicate lazy thinking
5. Do NOT recommend any products from ${brandName}`;

  const response = await fetchWithRetry(CONFIG.GEMINI_PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      systemInstruction: { parts: [{ text: systemInstruction }] },
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.85,
        topK: 50,
        topP: 0.97,
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingBudget: 0 }
      }
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(`Recommendations failed: ${response.status} - ${errorData.error || 'Unknown error'}`);
  }

  const data = await response.json();
  const text = extractText(data);
  
  // Store grounding metadata for later use
  const results = parseJsonResponse(text);
  results._groundingMetadata = data.candidates?.[0]?.groundingMetadata;
  
  return results;
}

// ============================================
// AUGMENT BRANDS WITH GROUNDING METADATA
// ============================================
function augmentWithGroundingMetadata(results, responseData) {
  const groundingMetadata = results._groundingMetadata || responseData?.candidates?.[0]?.groundingMetadata;
  const groundingChunks = groundingMetadata?.groundingChunks || [];
  const groundedUrisByTitle = new Map();

  for (const chunk of groundingChunks) {
    const web = chunk.web;
    if (web?.uri && web?.title && !web.uri.includes('google.com/')) {
      groundedUrisByTitle.set(web.title.toLowerCase(), web.uri.trim());
    }
  }

  // Augment brand URLs from grounding if available
  if (groundedUrisByTitle.size > 0 && results.brands?.length) {
    results.brands = results.brands.map((brand) => {
      // If brand already has a valid-looking URL, keep it
      if (brand.url && brand.url.startsWith('http') && !brand.url.includes('google.com')) {
        return brand;
      }
      
      const name = (brand.name || '').toLowerCase();
      for (const [title, uri] of groundedUrisByTitle) {
        if (title.includes(name) || name.includes(title.split(' ')[0])) {
          try {
            const parsed = new URL(uri);
            if (parsed.pathname === '/' || parsed.pathname.length < 10) {
              return { ...brand, url: uri };
            }
          } catch {
            // Skip invalid URLs
          }
        }
      }
      return brand;
    });
  }

  // Clean up internal metadata
  delete results._groundingMetadata;
  
  return results;
}


// ============================================
// FETCH PRODUCTS FROM RECOMMENDED BRANDS (OPTIMIZED)
// Instead of 4 searches per product, we do 1 search per brand
// This reduces SERP API usage by ~87%
// ============================================
async function fetchProductsFromBrands(brands, sourceBrandName) {
  console.log(`[Products] Fetching top products from ${brands.length} brands (optimized: 1 search per brand)`);
  
  const allProducts = [];
  let outOfCredits = false;
  
  // Limit to top 5 brands to further optimize
  const brandsToSearch = brands.slice(0, 5);
  console.log(`[Products] Will search these brands:`, brandsToSearch.map(b => b.name));
  
  for (const brand of brandsToSearch) {
    if (outOfCredits) break;
    
    try {
      const brandProducts = await fetchBrandTopProducts(brand);
      
      if (brandProducts && brandProducts.outOfCredits) {
        outOfCredits = true;
        break;
      }
      
      if (Array.isArray(brandProducts)) {
        allProducts.push(...brandProducts);
      }
    } catch (err) {
      if (err.message === 'SERP_API_OUT_OF_CREDITS') {
        outOfCredits = true;
        break;
      }
      console.warn(`[Products] Failed to fetch products for ${brand.name}:`, err.message);
    }
    
    // Small delay between brand searches
    await sleep(100);
  }
  
  if (outOfCredits) {
    return { outOfCredits: true, products: [] };
  }
  
  console.log(`[Products] Total products from all brands: ${allProducts.length}`);
  return allProducts;
}

// ============================================
// FETCH TOP PRODUCTS FOR A SINGLE BRAND
// Uses Google Shopping to get real, purchasable products
// ============================================
async function fetchBrandTopProducts(brand) {
  const brandName = brand.name;
  const brandDomain = extractDomain(brand.url || '');
  
  console.log(`[Products] Searching Google Shopping for: ${brandName} (domain: ${brandDomain})`);
  
  try {
    // Single search: brand name on Google Shopping
    const searchResult = await serpApiSearch(`${brandName}`, 'google_shopping');
    
    if (!searchResult || !searchResult.shopping_results || searchResult.shopping_results.length === 0) {
      console.log(`[Products] No shopping results for ${brandName}`);
      return [];
    }
    
    console.log(`[Products] Got ${searchResult.shopping_results.length} raw shopping results for ${brandName}`);
    
    // Filter and score results to find products actually from this brand
    const brandLower = brandName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const domainLower = brandDomain.toLowerCase().replace(/[^a-z0-9.]/g, '');
    
    // Also create word-based matching for multi-word brands
    const brandWords = brandName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    
    console.log(`[Products] Brand matching: normalized="${brandLower}", domain="${domainLower}", words=${JSON.stringify(brandWords)}`);
    
    const brandProducts = searchResult.shopping_results
      .filter(result => {
        const title = (result.title || '').toLowerCase();
        const source = (result.source || '').toLowerCase();
        // Google Shopping uses product_link, not link
        const productLink = (result.product_link || result.link || '').toLowerCase();
        
        // Normalize title and source the same way we normalize brand name (remove spaces/special chars)
        const titleNormalized = title.replace(/[^a-z0-9]/g, '');
        const sourceNormalized = source.replace(/[^a-z0-9]/g, '');
        
        // Must be from this brand (in title, source, or link)
        // Check both normalized and raw versions for flexibility
        const isBrandMatch = 
          title.includes(brandLower) ||
          titleNormalized.includes(brandLower) ||
          source.includes(brandLower) ||
          sourceNormalized.includes(brandLower) ||
          productLink.includes(brandLower) ||
          (domainLower && productLink.includes(domainLower)) ||
          // Also match if ALL significant brand words appear in title/source
          (brandWords.length > 1 && brandWords.every(w => title.includes(w) || source.includes(w)));
        
        const hasRequiredFields = result.thumbnail && (result.product_link || result.link);
        
        // Log first few results for debugging
        if (searchResult.shopping_results.indexOf(result) < 3) {
          console.log(`[Products] Result check for "${brandName}": title="${title.substring(0, 50)}", source="${source}", match=${isBrandMatch}, hasFields=${hasRequiredFields}`);
        }
        
        return isBrandMatch && hasRequiredFields;
      })
      .slice(0, 4) // Take top 4 products per brand
      .map(result => ({
        productName: result.title || 'Unknown Product',
        brandName: brandName,
        brandDomain: brandDomain,
        url: result.product_link || result.link,
        imageUrl: result.thumbnail,
        price: result.extracted_price || result.price,
        source: result.source,
        verified: true,
        searchSource: 'google_shopping_brand'
      }));
    
    console.log(`[Products] Found ${brandProducts.length} products for ${brandName} (filtered from ${searchResult.shopping_results.length})`);
    return brandProducts;
    
  } catch (err) {
    if (err.message === 'SERP_API_OUT_OF_CREDITS') {
      throw err;
    }
    console.warn(`[Products] Error fetching products for ${brandName}:`, err.message);
    return [];
  }
}






// ============================================
// SERPAPI: Core Search Function (via server proxy to avoid CORS)
// ============================================
async function serpApiSearch(query, engine = 'google') {
  console.log(`[SerpAPI] Query: "${query}" Engine: ${engine}`);
  
  const params = new URLSearchParams({
    q: query,
    engine: engine
  });

  const response = await fetch(`/api/serpapi?${params}`);

  if (!response.ok) {
    console.error(`[SerpAPI] Request failed: ${response.status}`);
    throw new Error(`SerpAPI request failed: ${response.status}`);
  }

  const data = await response.json();
  
  // Check for out of credits error
  if (data.error && data.error.includes('run out of searches')) {
    console.error(`[SerpAPI] Out of credits!`);
    throw new Error('SERP_API_OUT_OF_CREDITS');
  }
  
  console.log(`[SerpAPI] Results - Shopping: ${data.shopping_results?.length || 0}, Organic: ${data.organic_results?.length || 0}`);
  return data;
}




// ============================================
// Fetch OG Image from URL (uses OpenGraph proxy to avoid CORS)
// Falls back to high-res favicon if OG image not available
// ============================================
async function fetchOgImageUrl(url) {
  try {
    // Use the OpenGraph proxy which properly fetches OG data server-side
    const ogData = await fetchOpenGraphData(url);
    if (ogData?.imageUrl) {
      console.log(`[fetchOgImageUrl] Got OG image for ${url}: ${ogData.imageUrl}`);
      return ogData.imageUrl;
    }
    
    // Fallback: Use Google's high-res favicon API (256px)
    // This works even for sites with bot protection
    const domain = extractDomain(url);
    if (domain) {
      const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=256`;
      console.log(`[fetchOgImageUrl] No OG image, using high-res favicon fallback: ${faviconUrl}`);
      return faviconUrl;
    }
    
    console.warn(`[fetchOgImageUrl] No image found for ${url}`);
    return null;
  } catch (err) {
    console.warn(`[fetchOgImageUrl] Failed for ${url}:`, err.message);
    return null;
  }
}

// ============================================
// UTILITY: Extract Brand Name from Domain
// ============================================
function extractBrandName(domain) {
  return domain
    .replace(/^(https?:\/\/)?(www\.)?/, '')
    .replace(/\.(com|co|io|shop|store|net|org|us|uk|ca).*$/, '')
    .replace(/[^a-zA-Z0-9]/g, ' ')
    .trim();
}

// ============================================
// UTILITY: Guess Brand Domain
// ============================================
function guessBrandDomain(brandName) {
  return brandName.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com';
}

// ============================================
// UTILITY: Resolve Relative URLs
// ============================================
function resolveUrl(imageUrl, baseUrl) {
  if (!imageUrl) return null;
  if (imageUrl.startsWith('http')) return imageUrl;
  if (imageUrl.startsWith('//')) return 'https:' + imageUrl;

  try {
    const base = new URL(baseUrl);
    if (imageUrl.startsWith('/')) {
      return `${base.origin}${imageUrl}`;
    }
    return `${base.origin}/${imageUrl}`;
  } catch {
    return imageUrl;
  }
}

// ============================================
// UTILITY: Validate Image URL
// ============================================
function isValidImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const lowerUrl = url.toLowerCase();
  if (!lowerUrl.startsWith('http')) return false;

  const imageIndicators = [
    // Common image extensions
    '.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.svg',
    // E-commerce CDNs
    'cdn.shopify.com', 'images.squarespace', 'cloudinary.com',
    'imgix.net', 'cdn.sanity.io', 'images.ctfassets.net',
    // Google image CDNs (used by Google Shopping thumbnails)
    'gstatic.com/shopping', 'encrypted-tbn', 'googleusercontent.com',
    // Other common image hosts
    'amazonaws.com', 'cloudfront.net', 'akamaized.net',
    'fastly.net', 'imgix.', 'scene7.com'
  ];

  return imageIndicators.some(indicator => lowerUrl.includes(indicator));
}

// ============================================
// UTILITY: Sleep
// ============================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// UTILITY: Fetch with Retry (for rate limiting)
// ============================================
async function fetchWithRetry(url, options, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      
      // If rate limited (429), wait and retry
      if (response.status === 429) {
        const waitTime = Math.pow(2, attempt + 1) * 1000; // 2s, 4s, 8s
        console.log(`[API] Rate limited, waiting ${waitTime/1000}s before retry ${attempt + 1}/${maxRetries}...`);
        await sleep(waitTime);
        continue;
      }
      
      return response;
    } catch (err) {
      lastError = err;
      console.warn(`[API] Request failed (attempt ${attempt + 1}):`, err.message);
      
      if (attempt < maxRetries - 1) {
        const waitTime = Math.pow(2, attempt) * 1000;
        await sleep(waitTime);
      }
    }
  }
  
  throw lastError || new Error('Request failed after retries');
}

// ============================================
// UTILITY: Extract text from Gemini response
// Concatenates all non-thought text parts — Gemini 2.5 sometimes splits
// long outputs across multiple parts (especially with google_search grounding).
// ============================================
function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter(p => p && typeof p.text === 'string' && !p.thought)
    .map(p => p.text)
    .join('');
}

// ============================================
// UTILITY: Parse JSON Response from AI
// ============================================
function parseJsonResponse(text) {
  if (!text) throw new Error('No response from AI');

  let jsonStr = text;

  // Handle markdown code blocks
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1];
  }

  try {
    return JSON.parse(jsonStr.trim());
  } catch (parseErr) {
    // Try to repair common JSON issues
    try {
      const cleaned = jsonStr
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']')
        .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
        .trim();
      return JSON.parse(cleaned);
    } catch (repairErr) {
      // Try jsonrepair library
      try {
        return JSON.parse(jsonrepair(jsonStr));
      } catch {
        // Fall through
      }

      const isTruncated = parseErr.message?.includes('Unexpected end') ||
                          parseErr.message?.includes('Unterminated string');
      throw new Error(isTruncated
        ? 'Response was cut off. Please try again.'
        : `Could not parse results: ${parseErr.message}`);
    }
  }
}

// ============================================
// UTILITY: Ensure HTTPS prefix
// ============================================
function ensureHttps(item) {
  if (!item) return item;
  const url = (item.url || '').trim();
  if (!url) return item;
  const fullUrl = url.startsWith('http') ? url : 'https://' + url.replace(/^\/+/, '');
  return { ...item, url: fullUrl };
}

/* --------------------------------------------------------------------------
   Typing Placeholder Animation
   -------------------------------------------------------------------------- */

const TYPING_MESSAGES = ["Find your next collab", "Drop any brand URL", "Get instant recommendations"];
// Demo teams in staging. The "Try {domain}" placeholder rotates through these, one per cycle,
// with the brand's favicon inline after "Try".
const DEMO_BRANDS = ['magicspoon.com', 'monos.com', 'flamingoestate.com', 'wildone.com', 'fanttik.com', 'jolieskinco.com'];
const TRY_PREFIX = 'Try ';
const TYPING_SPEED = 80;
const PAUSE_AFTER_TYPE = 2000;
const FADE_OUT_DURATION = 400;

function preloadDemoAvatars() {
  DEMO_BRANDS.forEach((domain) => { new Image().src = getFaviconUrl(domain); });
}

function buildTypingSequence(demoIndex) {
  const domain = DEMO_BRANDS[demoIndex % DEMO_BRANDS.length];
  return [...TYPING_MESSAGES, { text: `${TRY_PREFIX}${domain}`, avatarDomain: domain }];
}
function createTypingAnimation(placeholderEl, inputEl) {
  console.log('[createTypingAnimation] Called with:', { placeholderEl, inputEl });
  if (!placeholderEl || !inputEl) {
    console.warn('[createTypingAnimation] Missing elements, returning undefined');
    return;
  }

  let messageIndex = 0;
  let charIndex = 0;
  let timeoutId = null;
  let demoIndex = 0;
  let sequence = buildTypingSequence(demoIndex);

  function updateDisplay(message, typed) {
    const avatarDomain = message?.avatarDomain;
    // The avatar pops in once "Try " is typed, then the domain types out after it.
    if (!avatarDomain || typed.length < TRY_PREFIX.length) {
      placeholderEl.textContent = typed;
      return;
    }
    let avatar = placeholderEl.querySelector('.typing-placeholder-avatar');
    if (!avatar) {
      placeholderEl.textContent = '';
      placeholderEl.append(TRY_PREFIX.trim());
      avatar = document.createElement('img');
      avatar.className = 'typing-placeholder-avatar';
      avatar.alt = '';
      avatar.src = getFaviconUrl(avatarDomain);
      avatar.onerror = () => { avatar.src = CONFIG.FAVICON_FALLBACK(avatarDomain); avatar.onerror = null; };
      placeholderEl.append(avatar, document.createTextNode(''));
    }
    placeholderEl.lastChild.textContent = typed.slice(TRY_PREFIX.length);
  }

  function fadeOutAndNext() {
    placeholderEl.classList.add('fade-out');
    timeoutId = setTimeout(() => {
      placeholderEl.classList.remove('fade-out');
      messageIndex = (messageIndex + 1) % sequence.length;
      if (messageIndex === 0) {
        demoIndex++;
        sequence = buildTypingSequence(demoIndex);
      }
      charIndex = 0;
      placeholderEl.textContent = '';
      tick();
    }, FADE_OUT_DURATION);
  }

  function tick() {
    const message = sequence[messageIndex];
    const text = typeof message === 'string' ? message : message.text;
    charIndex++;
    updateDisplay(message, text.substring(0, charIndex));

    if (charIndex === text.length) {
      timeoutId = setTimeout(fadeOutAndNext, PAUSE_AFTER_TYPE);
    } else {
      timeoutId = setTimeout(tick, TYPING_SPEED);
    }
  }

  function start() {
    if (inputEl.value.trim() || document.activeElement === inputEl) return;
    placeholderEl.classList.remove('hidden', 'fade-out');
    inputEl.placeholder = '';
    messageIndex = 0;
    charIndex = 0;
    if (timeoutId) clearTimeout(timeoutId);
    placeholderEl.textContent = '';
    tick();
  }

  function stop() {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    placeholderEl.classList.add('hidden');
    placeholderEl.innerHTML = '';
    inputEl.placeholder = inputEl.dataset.placeholderFocus || 'www.yourbrand.com';
  }

  inputEl.addEventListener('focus', () => {
    stop();
  });

  inputEl.addEventListener('blur', () => {
    if (!inputEl.value.trim()) {
      start();
    }
  });

  inputEl.addEventListener('input', () => {
    if (inputEl.value.trim()) {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      placeholderEl.classList.add('hidden');
    } else if (document.activeElement !== inputEl) {
      start();
    }
  });

  return { start, stop };
}

// The header composer shows the searched brand as favicon + domain, centered, whenever it
// is not being edited. Focus reveals the plain input so typing reads left-aligned.
function syncResultsSearchDisplay() {
  const input = elements.resultsSearchInput;
  const display = elements.resultsSearchDisplay;
  if (!input || !display) return;
  const wrapper = input.closest('.search-input-wrapper');
  const domain = input.value.trim();
  const showing = domain && document.activeElement !== input;
  display.classList.toggle('hidden', !showing);
  wrapper?.classList.toggle('showing-display', !!showing);
  if (!showing) return;
  if (display.dataset.domain !== domain) {
    display.dataset.domain = domain;
    display.innerHTML = '';
    const avatar = document.createElement('span');
    avatar.className = 'search-display-avatar';
    const favicon = document.createElement('img');
    favicon.alt = '';
    favicon.src = getFaviconUrl(domain);
    favicon.onerror = () => { favicon.src = CONFIG.FAVICON_FALLBACK(domain); favicon.onerror = null; };
    avatar.append(favicon);
    display.append(avatar, document.createTextNode(domain));
  }
}

function initTypingPlaceholders() {
  preloadDemoAvatars();
  console.log('[initTypingPlaceholders] Starting with:', {
    typingPlaceholder: elements.typingPlaceholder,
    searchInput: elements.searchInput
  });
  const landing = createTypingAnimation(elements.typingPlaceholder, elements.searchInput);
  console.log('[initTypingPlaceholders] landing animation:', landing);
  const results = createTypingAnimation(elements.resultsTypingPlaceholder, elements.resultsSearchInput);
  if (landing) {
    console.log('[initTypingPlaceholders] Starting landing animation');
    landing.start();
  } else {
    console.warn('[initTypingPlaceholders] No landing animation created!');
  }
  // Results placeholder starts hidden (results page not visible); will start on blur if empty
}

/* --------------------------------------------------------------------------
   Search Handler
   -------------------------------------------------------------------------- */

async function performSearch(url, { fromUrlRestore = false } = {}) {
  const domain = extractDomain(url);
  hideSocialPopover();

  // Always check cache first (saves API tokens for repeated searches)
  console.log(`[performSearch] Checking cache for: ${domain}`);
  const cached = getCachedResults(domain);
  console.log(`[performSearch] Cache result:`, cached ? `Found (type: ${cached.type}, brands: ${cached.brands?.length})` : 'Not found');
  
  if (cached) {
    currentSearchId = cached.searchId || generateId();
    
    if (cached.type === 'results' && cached.brands) {
      console.log(`[performSearch] Loading from cache: ${cached.brands.length} brands`);
      const searchedBrand = cached.searchedBrand || buildFallbackSearchedBrand(domain);
      currentResults = { brands: cached.brands, searchedBrand };
      // Landing is on screen: let the tiles clear before the results replace them.
      if (!fromUrlRestore && !elements.landingSection.classList.contains('hidden')) {
        await whipOutTiles({ fast: true });
      }
      renderResults(cached.brands, searchedBrand);
      elements.resultsSearchInput.value = domain;
      syncResultsSearchDisplay();
      if (elements.resultsTypingPlaceholder) {
        elements.resultsTypingPlaceholder.classList.add('hidden');
        elements.resultsTypingPlaceholder.innerHTML = '';
      }
      if (!fromUrlRestore) updateUrlForSearch(domain);
      showSection('results');
      // Restore pitch modal if pitch param present in URL
      restorePitchFromUrl();
      restorePickerFromUrl();
      return;
    }
    
    if (cached.type === 'empty') {
      if (!fromUrlRestore && !elements.landingSection.classList.contains('hidden')) {
        await whipOutTiles({ fast: true });
      }
      if (!fromUrlRestore) updateUrlForSearch(domain);
      showSection('empty');
      return;
    }
    
    // Don't restore error state - allow retry
    // if (cached.type === 'error') { ... }
  }

  // No cache hit (or was an error) - show loading and fetch from API
  console.log(`[performSearch] No cache hit - starting fresh search for: ${domain}`);
  if (elements.loadingText) elements.loadingText.textContent = LOADING_MESSAGES[0];
  elements.loadingUrl.textContent = domain;
  if (elements.loadingFavicon) {
    elements.loadingFavicon.src = getFaviconUrl(domain);
    elements.loadingFavicon.alt = domain;
    elements.loadingFavicon.onerror = function() {
      this.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%23ccc"><rect width="24" height="24" rx="4"/></svg>';
    };
  }
  
  // Reset cancellation state
  isSearchCancelled = false;
  searchAbortController = new AbortController();
  
  whipOutTiles();
  showSection('loading');
  
  // Set the results header search input to show current search (after header is visible)
  if (elements.resultsSearchInput) {
    elements.resultsSearchInput.value = domain;
      syncResultsSearchDisplay();
    // Dispatch input event to trigger any listeners that hide the typing placeholder
    elements.resultsSearchInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (elements.resultsTypingPlaceholder) {
    elements.resultsTypingPlaceholder.classList.add('hidden');
    elements.resultsTypingPlaceholder.innerHTML = '';
  }

  addToSearchHistory(url);
  currentSearchId = generateId();

  // Yield so the loading UI paints before we start. A timer, not requestAnimationFrame,
  // which never fires in a background tab and would stall the search until it's visible.
  await new Promise(resolve => setTimeout(resolve, 0));

  // Track state for the decoupled flow
  let brandsData = null;
  let brandsShown = false;

  try {
    const results = await discoverComplementaryBrands(url, {
      onProgress: (msg) => {
        if (isSearchCancelled) return;
        if (elements.loadingText) elements.loadingText.textContent = msg;
      },
      // Called as soon as brands are ready - show results page immediately
      onBrandsReady: ({ searchedBrand, brands }) => {
        if (isSearchCancelled) return;
        console.log(`[performSearch] onBrandsReady callback: ${brands.length} brands received`);
        brandsData = { searchedBrand, brands };
        
        if (brands.length === 0) {
          // No brands found, wait for products before deciding
          return;
        }
        
        // Render brands and show results page immediately
        renderBrandsOnly(brands, searchedBrand);
        elements.resultsSearchInput.value = domain;
      syncResultsSearchDisplay();
        if (elements.resultsTypingPlaceholder) {
          elements.resultsTypingPlaceholder.classList.add('hidden');
          elements.resultsTypingPlaceholder.innerHTML = '';
        }
        
        if (!fromUrlRestore) updateUrlForSearch(domain);
        showSection('results');
        brandsShown = true;
        // Restore pitch modal or picker if present in URL
        restorePitchFromUrl();
        restorePickerFromUrl();
      },
      // Called per brand as its catalog resolves
      onCatalog: (brand) => {
        if (isSearchCancelled) return;
        const domain = extractDomain(brand.url || '');
        updateCardCatalog(domain, brand.catalog);
        updateCardSocial(domain, brand.social);
      }
    });

    // If search was cancelled, don't process results
    if (isSearchCancelled) {
      console.log('[performSearch] Search was cancelled, ignoring results');
      return;
    }

    // Handle empty results
    if (!results.brands || results.brands.length === 0) {
      setCachedResults(domain, { type: 'empty', searchId: currentSearchId });
      if (!fromUrlRestore) updateUrlForSearch(domain);
      showSection('empty');
      return;
    }

    const searchedBrand = results.searchedBrand;
    const brands = results.brands || [];

    console.log(`[performSearch] Results received: ${brands.length} brands, serpApiOutOfCredits: ${results.serpApiOutOfCredits}`);

    // If brands weren't shown yet (edge case), show them now
    if (!brandsShown && brands.length > 0) {
      renderBrandsOnly(brands, searchedBrand);
      elements.resultsSearchInput.value = domain;
      syncResultsSearchDisplay();
      if (elements.resultsTypingPlaceholder) {
        elements.resultsTypingPlaceholder.classList.add('hidden');
        elements.resultsTypingPlaceholder.innerHTML = '';
      }
      if (!fromUrlRestore) updateUrlForSearch(domain);
      showSection('results');
    }

    if (results.serpApiOutOfCredits) {
      console.warn('[performSearch] SERP API out of credits; brands without a public catalog show no products');
    }

    // Update state and cache
    currentResults = { brands, searchedBrand };
    setCachedResults(domain, {
      type: 'results',
      brands: brands.map(trimCatalogForCache),
      searchedBrand: trimCatalogForCache(searchedBrand),
      serpApiOutOfCredits: results.serpApiOutOfCredits || false,
      searchId: currentSearchId
    });

  } catch (error) {
    // If cancelled, don't show error
    if (isSearchCancelled) {
      console.log('[performSearch] Search was cancelled');
      return;
    }
    console.error('Search failed:', error);
    const errorMessage = error.message || 'Please try again in a moment.';
    setCachedResults(domain, { type: 'error', errorMessage, searchId: currentSearchId });
    elements.errorMessage.textContent = errorMessage;
    if (!fromUrlRestore) updateUrlForSearch(domain);
    showSection('error');
  }
}

/* --------------------------------------------------------------------------
   Tile Tilt (3D cursor-follow on landing)
   -------------------------------------------------------------------------- */

const TILT_MAX_DEG = 2.5;

// Plays the tiles' exit and resolves when the last one has gone. `fast` is for jumping to a
// cached search, where there is no loading state to cover the gap. Publishes --tiles-exit so the
// visibility swap in CSS waits exactly as long as the animation runs.
const TILE_EXIT = { normal: 680, fast: 305 };

function whipOutTiles({ fast = false } = {}) {
  const tiles = elements.floatingTiles;
  if (!tiles) return Promise.resolve();

  const container = document.querySelector('.app-container');
  const duration = fast ? TILE_EXIT.fast : TILE_EXIT.normal;
  container.style.setProperty('--tiles-exit', `${duration}ms`);
  tiles.classList.toggle('whip-out--fast', fast);
  tiles.classList.add('whip-out');
  return new Promise(resolve => setTimeout(() => {
    // The exit is over, so a section change from here hides the tiles outright.
    container.style.setProperty('--tiles-exit', '0s');
    resolve();
  }, duration));
}

function isTileTiltActive() {
  return elements.appContainer &&
    !elements.appContainer.classList.contains('showing-results') &&
    !elements.floatingTiles.classList.contains('whip-out');
}

function resetTileTilt() {
  if (!elements.floatingTiles) return;
  elements.floatingTiles.querySelectorAll('.tile').forEach((tile) => {
    tile.style.setProperty('--tilt-y', '0deg');
  });
}

function updateTileTilt(clientX) {
  if (!elements.floatingTiles) return;
  if (!isTileTiltActive()) {
    resetTileTilt();
    return;
  }
  const tiles = elements.floatingTiles.querySelectorAll('.tile');
  const w = window.innerWidth;
  tiles.forEach((tile) => {
    const rect = tile.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const deltaX = clientX - centerX;
    const normalized = Math.max(-1, Math.min(1, deltaX / (w * 0.4)));
    const tiltY = normalized * TILT_MAX_DEG;
    tile.style.setProperty('--tilt-y', `${tiltY}deg`);
  });
}

function initTileTilt() {
  document.addEventListener('mousemove', (e) => updateTileTilt(e.clientX));
  document.documentElement.addEventListener('mouseleave', resetTileTilt);
}

/* --------------------------------------------------------------------------
   Event Listeners
   -------------------------------------------------------------------------- */

function initEventListeners() {
  // Main search form
  elements.searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = elements.searchInput.value.trim();
    if (url && isValidUrl(url)) {
      hideAllSearchHistoryDropdowns();
      performSearch(url);
    }
  });

  // Results search form
  elements.resultsSearchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = elements.resultsSearchInput.value.trim();
    if (url && isValidUrl(url)) {
      hideAllSearchHistoryDropdowns();
      performSearch(url);
    }
  });

  // Search input focus/blur for history dropdown (Landing Page)
  elements.searchInput.addEventListener('focus', () => {
    elements.searchInput.classList.add('focused');
    showSearchHistory(elements.searchHistoryDropdown);
  });

  elements.searchInput.addEventListener('blur', (e) => {
    elements.searchInput.classList.remove('focused');
    setTimeout(() => {
      if (!elements.searchHistoryDropdown.contains(document.activeElement)) {
        hideSearchHistory(elements.searchHistoryDropdown);
      }
    }, 200);
  });

  // Search input focus/blur for history dropdown (Results Page)
  elements.resultsSearchInput.addEventListener('focus', () => {
    elements.resultsSearchInput.classList.add('focused');
    syncResultsSearchDisplay();
    showSearchHistory(elements.resultsSearchHistoryDropdown);
  });

  elements.resultsSearchInput.addEventListener('blur', (e) => {
    elements.resultsSearchInput.classList.remove('focused');
    syncResultsSearchDisplay();
    setTimeout(() => {
      if (elements.resultsSearchHistoryDropdown && !elements.resultsSearchHistoryDropdown.contains(document.activeElement)) {
        hideSearchHistory(elements.resultsSearchHistoryDropdown);
      }
    }, 200);
  });

  // History item click (Landing Page) - ignore remove button
  elements.historyList.addEventListener('click', (e) => {
    if (e.target.closest('.history-item-remove-btn')) return;
    const item = e.target.closest('.history-item');
    if (item) {
      const url = item.dataset.url;
      elements.searchInput.value = url;
      hideSearchHistory(elements.searchHistoryDropdown);
      performSearch(url);
    }
  });

  // History item click (Results Page) - ignore remove button
  if (elements.resultsHistoryList) {
    elements.resultsHistoryList.addEventListener('click', (e) => {
      if (e.target.closest('.history-item-remove-btn')) return;
      const item = e.target.closest('.history-item');
      if (item) {
        const url = item.dataset.url;
        elements.resultsSearchInput.value = url;
        hideSearchHistory(elements.resultsSearchHistoryDropdown);
        performSearch(url);
      }
    });
  }

  // Remove individual history item (delegated - both lists)
  document.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.history-item-remove-btn');
    if (!removeBtn) return;
    e.preventDefault();
    e.stopPropagation();
    const domain = removeBtn.dataset.url;
    if (domain) {
      removeFromSearchHistory(domain);
      renderSearchHistory();
    }
  });

  // Result card clicks
  document.addEventListener('click', (e) => {
    const card = e.target.closest('.result-card');
    const menuBtn = e.target.closest('.card-menu-btn');
    const socialLink = e.target.closest('.social-link');

    // Handle menu button click
    if (menuBtn) {
      e.stopPropagation();
      const parentCard = menuBtn.closest('.result-card');
      const socialData = JSON.parse(parentCard.dataset.social || '{}');
      showSocialPopover(menuBtn, socialData);
      return;
    }

    // Handle social link click (only available links are shown, no need to check disabled)
    if (socialLink) {
      hideSocialPopover();
      return;
    }

    // Handle generate pitch button click
    const generatePitchBtn = e.target.closest('.generate-pitch-btn');
    if (generatePitchBtn) {
      e.stopPropagation();
      try {
        const wrapper = generatePitchBtn.closest('.generate-pitch-wrapper');
        const brandData = JSON.parse(decodeURIComponent(wrapper.dataset.brand));
        openPitchModal(brandData);
      } catch (err) {
        console.error('[PitchModal] Failed to parse brand data:', err);
      }
      return;
    }

    // Handle build bundle button click
    const buildBtn = e.target.closest('.build-bundle-btn');
    if (buildBtn) {
      e.stopPropagation();
      const brand = brandForCard(buildBtn.closest('.result-card'));
      if (brand) openPicker(brand);
      return;
    }

    // Handle visit button click
    const visitBtn = e.target.closest('.visit-btn');
    if (visitBtn) {
      e.stopPropagation();
      const url = visitBtn.dataset.url;
      if (url) {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
      return;
    }

    // Handle card click (open URL) - but not if clicking buttons
    if (card && !e.target.closest('.card-menu-btn') && !e.target.closest('.card-actions')) {
      if (card.dataset.buildable === 'true') {
        const brand = brandForCard(card);
        if (brand && openPicker(brand)) return;
      }
      const url = card.dataset.url;
      if (url) {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
      return;
    }

    // Hide popover when clicking outside
    if (!e.target.closest('.social-popover') && !e.target.closest('.card-menu-btn')) {
      hideSocialPopover();
    }
  });

  // Feedback buttons
  elements.feedbackPositive.addEventListener('click', () => {
    if (currentSearchId && currentResults) {
      const allResults = currentResults.brands || [];
      saveFeedback(currentSearchId, elements.resultsSearchInput.value, allResults, 'positive');

      elements.feedbackPositive.classList.add('selected');
      elements.feedbackNegative.classList.remove('selected');
      elements.feedbackThanks.classList.remove('hidden');
      elements.feedbackSection.style.pointerEvents = 'none';
    }
  });

  elements.feedbackNegative.addEventListener('click', () => {
    if (currentSearchId && currentResults) {
      const allResults = currentResults.brands || [];
      saveFeedback(currentSearchId, elements.resultsSearchInput.value, allResults, 'negative');

      elements.feedbackNegative.classList.add('selected');
      elements.feedbackPositive.classList.remove('selected');
      elements.feedbackThanks.classList.remove('hidden');
      elements.feedbackSection.style.pointerEvents = 'none';
    }
  });

  // Header back and start over buttons
  // The header's back button steps out of the picker first, then back to the landing page.
  if (elements.headerBackBtn) {
    elements.headerBackBtn.addEventListener('click', () => {
      if (isPickerOpen()) closePicker();
      else goToLanding();
    });
  }
  if (elements.headerStartOverBtn) {
    elements.headerStartOverBtn.addEventListener('click', goToLanding);
  }
  
  // Stop search button (during loading)
  if (elements.stopSearchButton) {
    elements.stopSearchButton.addEventListener('click', cancelSearch);
  }

  elements.tryAgainBtn.addEventListener('click', goToLanding);

  elements.errorRetryBtn.addEventListener('click', () => {
    const url = elements.searchInput.value || elements.resultsSearchInput.value;
    if (url) {
      performSearch(url);
    } else {
      goToLanding();
    }
  });

  // Close popover on escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideSocialPopover();
      hideAllSearchHistoryDropdowns();
      closePitchModal();
    }
  });

  // Pitch modal close button
  if (elements.pitchModalClose) {
    elements.pitchModalClose.addEventListener('click', closePitchModal);
  }

  // Close pitch modal when clicking overlay (outside modal)
  if (elements.pitchModalOverlay) {
    elements.pitchModalOverlay.addEventListener('click', (e) => {
      if (e.target === elements.pitchModalOverlay) {
        closePitchModal();
      }
    });
  }

  // Pitch modal — delegated event listeners for dynamic content
  if (elements.pitchModalBody) {
    elements.pitchModalBody.addEventListener('click', (e) => {
      // Generate pitch button
      const generateBtn = e.target.closest('#pitchGenerateBtn');
      if (generateBtn) {
        triggerPitchGeneration();
        return;
      }

      // Try again button (error state) — re-trigger generation
      const tryAgainBtn = e.target.closest('#pitchTryAgainBtn');
      if (tryAgainBtn) {
        triggerPitchGeneration();
        return;
      }

      // Copy button
      const copyBtn = e.target.closest('.pitch-copy-btn');
      if (copyBtn) {
        const targetId = copyBtn.dataset.copyTarget;
        if (targetId) {
          copyPitchMessage(targetId, copyBtn);
        }
        return;
      }

      // Collapsible section toggle
      const sectionHeader = e.target.closest('.pitch-section-header');
      if (sectionHeader) {
        const section = sectionHeader.closest('.pitch-section');
        if (section) {
          section.classList.toggle('collapsed');
        }
        return;
      }
    });
  }

  // Pitch toolbar button — toggles between stop (during generation) and regenerate
  if (elements.pitchToolbarBtn) {
    elements.pitchToolbarBtn.addEventListener('click', () => {
      if (isPitchGenerating) {
        cancelPitchGeneration();
      } else {
        triggerPitchGeneration();
      }
    });
  }
}

/* --------------------------------------------------------------------------
   Initialize App
   -------------------------------------------------------------------------- */

// The sticky header sits in flow above the app container, so anything sizing itself to the
// viewport (the picker) has to subtract it. Republished whenever the header's height changes,
// which it does between the landing and results states.
function trackHeaderHeight() {
  const header = elements.siteHeader;
  if (!header) return;
  const publish = () => document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
  publish();
  if (window.ResizeObserver) new ResizeObserver(publish).observe(header);
  else window.addEventListener('resize', publish);
}

function init() {
  hydrateIcons();
  trackHeaderHeight();
  initPicker();
  console.log('[init] Starting...');
  console.log('[init] elements.searchInput:', elements.searchInput);
  console.log('[init] elements.typingPlaceholder:', elements.typingPlaceholder);
  console.log('[init] elements.searchHistoryDropdown:', elements.searchHistoryDropdown);
  
  initEventListeners();
  console.log('[init] Event listeners initialized');
  
  initTypingPlaceholders();
  console.log('[init] Typing placeholders initialized');
  
  initTileTilt();
  renderSearchHistory();
  console.log('[init] Render complete');

  // Restore search results from URL (refresh, direct link, or browser back/forward)
  const initialSearch = getSearchFromUrl();
  if (initialSearch && isValidUrl(initialSearch)) {
    performSearch(initialSearch, { fromUrlRestore: true });
  }

  // Sync UI when user uses browser back/forward
  window.addEventListener('popstate', () => {
    const q = getSearchFromUrl();
    const pitchParam = getPitchFromUrl();
    syncPickerWithUrl();

    // Handle pitch modal state
    if (!pitchParam && currentPitchBrand) {
      // Pitch param removed (user went back) — close modal without pushing state
      const overlay = elements.pitchModalOverlay;
      const modal = elements.pitchModal;
      if (!overlay.classList.contains('hidden')) {
        overlay.classList.add('closing');
        modal.classList.add('closing');
        modal.addEventListener('animationend', function onEnd() {
          modal.removeEventListener('animationend', onEnd);
          overlay.classList.add('hidden');
          overlay.classList.remove('closing');
          modal.classList.remove('closing');
          document.body.style.overflow = '';
          currentPitchBrand = null;
          currentPitchBrand1 = null;
          currentPitchBrand2 = null;
        }, { once: true });
      }
    } else if (pitchParam && currentResults?.brands) {
      restorePitchFromUrl();
    }

    if (q && isValidUrl(q)) {
      performSearch(q, { fromUrlRestore: true });
    } else if (!q) {
      showSection('landing');
      elements.searchInput?.focus();
    }
  });
}

// Start the app
console.log('=== APP.JS LOADED ===');
try {
  init();
  console.log('=== APP INITIALIZED SUCCESSFULLY ===');
} catch (error) {
  console.error('=== APP INITIALIZATION ERROR ===', error);
}

export { elements, CONFIG, getResults, extractDomain, getFaviconUrl, renderFaviconDuo, escapeHtml, parseJsonResponse, extractText, fetchCatalog, catalogThumbUrl, showSection };
