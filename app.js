/* ==========================================================================
   Brand Collab Finder - Main Application
   ========================================================================== */

import { jsonrepair } from 'https://esm.sh/jsonrepair';
// Configuration
import { initPicker, openPicker, closePicker, isPickerOpen, canBuildWith, restorePickerFromUrl, syncPickerWithUrl } from './picker.js';
import { icon, hydrateIcons } from './icons.js';
import * as offerlab from './offerlab.js';
import { initLibrary, showLibrary, hideLibrary, libraryFilterParams } from './library.js';
import { initPhotoSearch } from './photo.js';
import { looksLikeDomain, attachBrandSuggestions } from './resolve.js';
import { normalizeSocial } from './shared/socials.js';
import * as search from './shared/search.js';
import { httpApi, catalogForStore, extractText } from './shared/search.js';
import * as store from './store.js';

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
  CACHED_PRODUCTS_PER_BRAND: 24, // per brand in a stored search; the picker fetches the rest
  MAX_SEARCH_HISTORY: 10,
  BATCH_SIZE: 5,
  REQUEST_DELAY_MS: 200,
  FETCH_TIMEOUT_MS: 5000,
  FAVICON_PRIMARY: (domain) => `https://www.google.com/s2/favicons?domain=${domain}&sz=64`,
  FAVICON_FALLBACK: (domain) => `https://icons.duckduckgo.com/ip3/${domain}.ico`
};

// The finder's own /api/* proxies, as the shared search calls them.
const searchApi = httpApi();

// State
let currentSearchId = null;
let currentResults = null;
// The search in flight, from the moment its brands are on screen: results are only stored once
// every catalog is in, and a card's button pressed before then must still find its brand.
let liveResults = null;
function getResults() { return currentResults || liveResults; }
let searchAbortController = null;
let isSearchCancelled = false;

// DOM Elements
const elements = {
  // Header
  siteHeader: document.getElementById('siteHeader'),
  siteHeaderLogo: document.getElementById('siteHeaderLogo'),
  viewHeader: document.getElementById('viewHeader'),
  omniFooter: document.getElementById('omniFooter'),
  librarySection: document.getElementById('librarySection'),
  modeSwitch: document.getElementById('modeSwitch'),
  modeSwitchIndicator: document.getElementById('modeSwitchIndicator'),
  headerBackBtn: document.getElementById('headerBackBtn'),
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
  pitchBundlesBuilt: document.getElementById('pitchBundlesBuilt'),
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
   Stored results (Cloudflare D1, through store.js). A search with results is kept for good, so
   a domain crawled ahead of an event opens instantly; ?refresh=1 runs it again. A search that
   found nothing is retried after 72 hours.
   -------------------------------------------------------------------------- */

const EMPTY_SEARCH_EXPIRATION_MS = 72 * 60 * 60 * 1000;
const REFRESH_PARAM = 'refresh';

// Read once: dropped from the URL so the next search in the session uses the store again.
function takeRefreshRequest() {
  const url = new URL(window.location.href);
  if (url.searchParams.get(REFRESH_PARAM) !== '1') return false;
  url.searchParams.delete(REFRESH_PARAM);
  history.replaceState(history.state, '', url.toString());
  return true;
}

async function getCachedResults(domain) {
  if (takeRefreshRequest()) {
    console.log(`[Store] Refresh requested for ${domain}; searching again`);
    return null;
  }

  const cached = await store.loadSearch(domain, { products: CONFIG.CACHED_PRODUCTS_PER_BRAND });
  if (!cached) return null;

  if (cached.timestamp) {
    const age = Date.now() - cached.timestamp;
    if (cached.type === 'empty' && age > EMPTY_SEARCH_EXPIRATION_MS) {
      console.log(`[Store] Stale for ${domain} (age: ${Math.round(age / 1000 / 60 / 60)}h); searching again`);
      return null;
    }
    console.log(`[Store] Found ${domain} (age: ${Math.round(age / 1000 / 60)}min)`);
  }

  return cached;
}

function setCachedResults(domain, data) {
  return store.saveSearch(domain, data);
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
    return urlObj.hostname.replace(/^www\./, '');
  } catch {
    return normalizeUrl(url);
  }
}

// A web address, with or without scheme, www. or a path. Anything else typed into the omnibar
// is a brand name and goes through resolve.js first.
function isValidUrl(input) {
  return looksLikeDomain(input);
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


/* --------------------------------------------------------------------------
   Search History & Feedback (Cloudflare D1, through store.js)
   -------------------------------------------------------------------------- */

// The dropdown and the omnibar's suggestions read history synchronously, so the store's copy is
// mirrored here: refreshed at start, whenever it changes, and each time the dropdown opens.
let searchHistory = [];

function getSearchHistory() {
  return searchHistory;
}

// Refreshes can overlap (the dropdown opening while an add settles); only the latest one lands.
let historyRefresh = 0;

async function refreshSearchHistory() {
  const request = ++historyRefresh;
  const fresh = await store.loadHistory(CONFIG.MAX_SEARCH_HISTORY);
  // No answer from the store keeps what is on screen; a refresh that was overtaken is dropped.
  if (!fresh || request !== historyRefresh) return searchHistory;
  const same = fresh.length === searchHistory.length && fresh.every((item, i) => item.domain === searchHistory[i].domain);
  if (same) return searchHistory;
  searchHistory = fresh;
  renderSearchHistory();
  return searchHistory;
}

function addToSearchHistory(url) {
  const domain = extractDomain(url);
  // Shown at once; the store's answer settles the order behind it.
  searchHistory = [{ domain, url: domain, timestamp: Date.now() }, ...searchHistory.filter(item => item.domain !== domain)]
    .slice(0, CONFIG.MAX_SEARCH_HISTORY);
  store.addHistory(domain).then(() => refreshSearchHistory());
  return searchHistory;
}

function clearSearchHistory() {
  searchHistory = [];
  store.clearHistory().then(() => refreshSearchHistory());
}

function removeFromSearchHistory(domain) {
  searchHistory = searchHistory.filter(item => item.domain !== domain);
  store.removeHistory(domain).then(() => refreshSearchHistory());
}

function getFeedbackHistory() {
  return store.loadFeedback();
}

function saveFeedback(searchId, inputUrl, results, rating) {
  return store.addFeedback({
    searchId,
    inputUrl,
    rating,
    results: results.map(r => ({ name: r.name, url: r.url }))
  });
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

  // The dark bar is global and holds nothing that varies by view. The context bar inside the
  // sheet is what each view turns on.
  if (elements.viewHeader) {
    elements.viewHeader.classList.add('hidden');
    elements.viewHeader.classList.remove('view-header--loading');
  }

  // The two modes are exclusive: any finder view puts the library away, and the library view
  // leaves every finder section hidden above. The switch reflects whichever is showing.
  if (sectionName !== 'library') hideLibrary();
  setMode(sectionName === 'library' ? 'library' : 'finder');

  // Show requested section
  switch (sectionName) {
    case 'library':
      document.querySelector('.app-container').classList.add('showing-results');
      document.body.classList.add('showing-results');
      resetTileTilt();
      showLibrary();
      break;
    case 'landing':
      elements.landingSection.classList.remove('hidden');
      document.querySelector('.app-container').classList.remove('showing-results');
      document.body.classList.remove('showing-results');
      elements.floatingTiles.classList.remove('whip-out', 'whip-out--fast');
      break;
    case 'loading':
      elements.loadingSection.classList.remove('hidden');
      document.querySelector('.app-container').classList.add('showing-results');
      document.body.classList.add('showing-results');
      resetTileTilt();
      // Back button hidden and the submit swapped for a stop button while a search runs.
      if (elements.viewHeader) {
        elements.viewHeader.classList.remove('hidden');
        elements.viewHeader.classList.add('view-header--loading');
      }
      break;
    case 'results':
      elements.resultsSection.classList.remove('hidden');
      document.querySelector('.app-container').classList.add('showing-results');
      document.body.classList.add('showing-results');
      resetTileTilt();
      if (elements.viewHeader) elements.viewHeader.classList.remove('hidden');
      break;
    case 'picker':
      elements.pickerSection.classList.remove('hidden');
      document.querySelector('.app-container').classList.add('showing-results');
      document.body.classList.add('showing-results');
      resetTileTilt();
      if (elements.viewHeader) elements.viewHeader.classList.remove('hidden');
      break;
    case 'empty':
      elements.emptySection.classList.remove('hidden');
      document.querySelector('.app-container').classList.add('showing-results');
      document.body.classList.add('showing-results');
      resetTileTilt();
      if (elements.viewHeader) elements.viewHeader.classList.remove('hidden');
      break;
    case 'error':
      elements.errorSection.classList.remove('hidden');
      document.querySelector('.app-container').classList.add('showing-results');
      document.body.classList.add('showing-results');
      resetTileTilt();
      if (elements.viewHeader) elements.viewHeader.classList.remove('hidden');
      break;
  }
}

/* --------------------------------------------------------------------------
   Mode switch: Create | Showcase
   -------------------------------------------------------------------------- */
const MODE_PARAM = 'view';
const MODES = ['finder', 'library'];

/* The app's segmented control: equal tracks, and the selected pill is its own layer slid by
   index, so a percentage translate is exactly one track. The first placement snaps rather
   than slides in from the left. */
function setMode(mode) {
  elements.modeSwitch?.querySelectorAll('.mode-switch-btn').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  });
  const indicator = elements.modeSwitchIndicator;
  if (!indicator) return;
  if (!indicator.dataset.placed) {
    indicator.style.transition = 'none';
    indicator.dataset.placed = 'true';
    requestAnimationFrame(() => requestAnimationFrame(() => { indicator.style.transition = ''; }));
  }
  indicator.style.transform = `translateX(${MODES.indexOf(mode) * 100}%)`;
}

function modeFromUrl() {
  return new URLSearchParams(window.location.search).get(MODE_PARAM) === 'library' ? 'library' : 'finder';
}

/**
 * Switching modes is a navigation, so it pushes. Leaving the library drops its filters from the
 * URL; leaving the finder keeps ?q= so the search is still there on the way back.
 */
function switchMode(mode) {
  if (mode === modeFromUrl()) return;
  const url = new URL(window.location.href);
  if (mode === 'library') {
    url.searchParams.set(MODE_PARAM, 'library');
  } else {
    url.searchParams.delete(MODE_PARAM);
    Object.values(libraryFilterParams()).forEach(param => url.searchParams.delete(param));
  }
  history.pushState({ mode }, '', url.toString());
  routeFromUrl();
}

/**
 * What the URL says to show. Used by the switch; back/forward goes through the finder's own
 * popstate handler in init(), which asks modeFromUrl() first so the two never both act.
 */
function routeFromUrl() {
  if (modeFromUrl() === 'library') {
    showSection('library');
    return;
  }
  const domain = getSearchFromUrl();
  if (!domain || !isValidUrl(domain)) {
    showSection('landing');
  } else if (currentResults?.brands) {
    showSection('results');
  } else {
    performSearch(domain, { fromUrlRestore: true });
  }
}

function initModeSwitch() {
  elements.modeSwitch?.addEventListener('click', event => {
    const button = event.target.closest('.mode-switch-btn');
    if (button) switchMode(button.dataset.mode);
  });
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
  refreshSearchHistory();
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


// An OfferLab developer, signed in: the finder's staff, who may correct its results.
function isStaff() {
  return offerlab.state.account?.developer === true;
}

function hasAnySocialLink(social) {
  return Object.keys(normalizeSocial(social)).length > 0;
}

function socialEntries(social) {
  const normalized = normalizeSocial(social);
  return SOCIAL_PLATFORMS.filter(p => normalized[p.key]).map(p => ({ ...p, ...normalized[p.key] }));
}

function updateCardSocial(domain, social) {
  document.querySelectorAll(`.result-card[data-domain="${domain}"]`).forEach(card => {
    card.dataset.social = JSON.stringify(social || {});
    card.querySelector('.card-menu-btn')?.classList.toggle('hidden', !hasAnySocialLink(social) && !isStaff());
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
  const products = catalog.products || [];
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

/** The searched card's chinstrap when it has no public catalog: the picker leads with a partner. */
function renderNoCatalogChinstrap(radius = 36) {
  return `<div class="tuck-banner tuck-banner--chinstrap card-chinstrap card-chinstrap--none" style="--tuck-radius: ${radius}px">
    <span class="card-chinstrap-source">${icon('cross-large', { size: 12 })} No public catalog</span>
    <span class="card-chinstrap-count">Bundles start from the partner you pick</span>
    <div class="tuck-banner__notch tuck-banner__notch--left"></div>
    <div class="tuck-banner__notch tuck-banner__notch--right"></div>
  </div>`;
}

function setCardBuildable(card, buildable) {
  card.dataset.buildable = buildable ? 'true' : 'false';
  card.querySelector('.build-bundle-btn')?.classList.toggle('hidden', !buildable);
}

function updateCardCatalog(domain, catalog) {
  const hasProducts = (catalog?.products?.length || 0) > 0;
  document.querySelectorAll(`[data-catalog-domain="${domain}"]`).forEach(group => {
    const slot = group.querySelector('.card-catalog-slot');
    if (slot) slot.innerHTML = renderCatalogThumbs(catalog);
    const linkSlot = group.querySelector('.searched-brand-card-link-slot');
    if (linkSlot) {
      linkSlot.innerHTML = renderSearchedBrandLink(catalog);
      coverFromCatalog(group, catalog);
      group.querySelector('.card-chinstrap')?.remove();
      if (catalog && !hasProducts) group.insertAdjacentHTML('beforeend', renderNoCatalogChinstrap());
      return;
    }
    group.querySelector('.card-chinstrap')?.remove();
    const chinstrap = renderCatalogChinstrap(catalog);
    if (chinstrap) group.insertAdjacentHTML('beforeend', chinstrap);
    const card = group.querySelector('.result-card');
    if (card) setCardBuildable(card, canBuildWith({ catalog }));
  });
}

/** A site with no og:image gets its first product as the cover, once the catalog is in. */
function coverFromCatalog(group, catalog) {
  const cover = group.querySelector('.searched-brand-card-image.no-image');
  const src = catalog?.products?.find(p => p.image)?.image;
  if (!cover || !src) return;
  cover.querySelector('img').src = catalogThumbUrl(src, 900);
  cover.classList.remove('no-image');
}

function brandForCard(card) {
  return getResults()?.brands?.find(b => extractDomain(b.url || '') === card.dataset.domain) || null;
}

function fetchCatalog(domain) {
  return search.fetchCatalog(searchApi, domain);
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
  // No cover yet: the column waits, hidden, for the catalog's first product image.
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
    <div class="searched-brand-card-image${imageUrl ? '' : ' no-image'}">
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

  const showMenu = hasAnySocialLink(brand.social) || isStaff();
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
        <button type="button" class="btn btn--md btn--primary build-bundle-btn${canBuildWith(brand) ? '' : ' hidden'}">Create bundle</button>
        <div class="generate-pitch-wrapper" data-brand="${encodeURIComponent(JSON.stringify(brand))}">
          <button type="button" class="btn btn--md btn--secondary generate-pitch-btn">Pitch them</button>
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
  markBrandsNotSetUp();
}

/**
 * A brand can have a public catalog to pick from and still have no team in the demo environment,
 * in which case creating a bundle has to stand one up first. That is a minute or two with someone
 * watching, so the card says so before the click rather than after (OL-3831).
 *
 * Only for an operator: a guest has no handoff to be warned about, and the demo environment is
 * none of their business.
 */
async function markBrandsNotSetUp() {
  if (!offerlab.isEnabled()) return;

  for (const card of document.querySelectorAll('.result-card[data-domain]')) {
    try {
      const brand = await offerlab.demoBrand(card.dataset.domain);
      if (brand?.ready) continue;
      card.dataset.setUp = 'false';
      const url = card.querySelector('.card-url');
      if (url && !url.querySelector('.card-not-set-up')) {
        url.insertAdjacentHTML('beforeend',
          '<span class="card-not-set-up" title="No team in the demo environment yet. Creating a bundle will set one up first, which takes a moment.">Not set up</span>');
      }
    } catch {
      // The demo environment being unreachable is not worth marking every card over.
      return;
    }
  }
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

  const socials = socialEntries(socialData);
  popover.innerHTML = socials.map(entry => `
    <a href="${escapeHtml(entry.url)}" class="social-link" data-platform="${entry.key}" target="_blank" rel="noopener" title="@${escapeHtml(entry.handle)}">
      ${icon(entry.icon, { class: 'social-icon' })}
      <span>${entry.label}</span>
      ${icon('arrow-up-right', { class: 'social-link-external' })}
    </a>`).join('') + (isStaff() ? renderModerationActions(socials.length > 0) : '');

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

// Staff only. "Wrong products" hides the brand's products everywhere; "Remove from results" drops
// the brand from this search only.
function renderModerationActions(afterSocials) {
  return `${afterSocials ? '<div class="popover-divider" role="separator"></div>' : ''}
    <button type="button" class="social-link moderation-action" data-action="hide-products">
      ${icon('eye-slash', { class: 'social-icon' })}<span>Wrong products</span>
    </button>
    <button type="button" class="social-link moderation-action" data-action="remove-recommendation">
      ${icon('close-x-rounded-remove', { class: 'social-icon' })}<span>Remove from results</span>
    </button>
    <p class="moderation-error" hidden></p>`;
}

async function moderateCard(card, action, popover) {
  const domain = card.dataset.domain;
  const searchDomain = extractDomain(getSearchFromUrl() || '');
  const errorLine = popover.querySelector('.moderation-error');
  popover.querySelectorAll('.moderation-action').forEach(button => { button.disabled = true; });
  try {
    const bearer = await offerlab.freshToken();
    if (!bearer) throw new Error('Sign in to OfferLab to moderate results.');
    await store.moderate({ action, domain, searchDomain }, bearer);
  } catch (err) {
    errorLine.textContent = err.message.endsWith('.') ? err.message : `${err.message}.`;
    errorLine.hidden = false;
    popover.querySelectorAll('.moderation-action').forEach(button => { button.disabled = false; });
    return;
  }
  hideSocialPopover();
  if (action === 'remove-recommendation') {
    if (currentResults) currentResults.brands = currentResults.brands.filter(b => extractDomain(b.url || '') !== domain);
    // The card's catalog footer sits beside it in the group, so the whole group goes.
    (card.closest('.result-card-group') || card).remove();
    return;
  }
  const hidden = { status: 'none', domain, count: 0, products: [], hidden: true };
  const brand = currentResults?.brands?.find(b => extractDomain(b.url || '') === domain);
  if (brand) brand.catalog = hidden;
  updateCardCatalog(domain, hidden);
}

// The account loads after the first cards may be on screen; once it says staff, every card gets
// the menu that carries the moderation actions.
function revealStaffMenus() {
  if (!offerlab.isEnabled() || !offerlab.isConnected()) return;
  offerlab.loadAccount()
    .then(() => {
      if (isStaff()) document.querySelectorAll('.card-menu-btn').forEach(button => button.classList.remove('hidden'));
    })
    .catch(err => console.warn('[Moderation] could not read the OfferLab account:', err.message));
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

    if (context.bundlesBuilt?.length) {
      contextBlock += `\nBundles already built for this pair in OfferLab. Reference these by name in the outreach rather than inventing a new concept:\n`;
      context.bundlesBuilt.forEach(draft => {
        const items = (draft.products || []).map(p => `${p.title} by ${p.brand}`).join(', ');
        contextBlock += `- "${draft.name}"${items ? `: ${items}` : ''}${draft.publishedUrl ? ` (live at ${draft.publishedUrl})` : ''}\n`;
      });
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

// The drafts on screen for the pair currently open, so the prompt and the render agree.
let currentPitchDrafts = [];
// The drafts come from the store; a render that lands after the modal moved on is dropped.
let bundlesBuiltRequest = 0;

/**
 * "Bundles built": what has already been made for this pair, so the outreach can point at
 * something real rather than describing it. Renders nothing for a pair with no drafts.
 *
 * The published page is looked up rather than stored at creation time, because publishing happens
 * later and in the builder, not here. It needs a connection, so a disconnected operator still gets
 * the list and the builder links, just without the PDP.
 */
async function renderBundlesBuilt(searchedDomain, partnerDomain) {
  const container = elements.pitchBundlesBuilt;
  if (!container) return;

  const request = ++bundlesBuiltRequest;
  container.innerHTML = '';
  const drafts = await offerlab.draftsForPair(searchedDomain, partnerDomain);
  if (request !== bundlesBuiltRequest) return;
  currentPitchDrafts = drafts;
  if (!currentPitchDrafts.length) {
    container.innerHTML = '';
    return;
  }

  const row = (draft) => {
    const items = (draft.products || []).map(product =>
      `<li class="pitch-bundle-item">${escapeHtml(product.title)} <span class="pitch-bundle-item-brand">by ${escapeHtml(product.brand)}</span></li>`
    ).join('');
    return `
      <div class="pitch-bundle" data-stack-id="${escapeHtml(String(draft.stackId))}">
        <div class="pitch-bundle-name">${escapeHtml(draft.name)}</div>
        ${items ? `<ul class="pitch-bundle-items">${items}</ul>` : ''}
        <div class="pitch-bundle-links">
          <a href="${escapeHtml(draft.url)}" target="_blank" rel="noopener noreferrer" class="pitch-bundle-link">Open in builder</a>
          <a href="${escapeHtml(draft.publishedUrl || '#')}" target="_blank" rel="noopener noreferrer"
             class="pitch-bundle-link pitch-bundle-link--pdp"${draft.publishedUrl ? '' : ' hidden'}>View the live page</a>
        </div>
      </div>`;
  };

  container.innerHTML = `
    <div class="pitch-bundles-card">
      <div class="pitch-bundles-header">Bundles built</div>
      ${currentPitchDrafts.map(row).join('')}
    </div>`;

  fillPublishedLinks(searchedDomain);
}

// Oldest first would bury today's work; newest is what the operator just made. A stack deleted in
// OfferLab keeps its row and its link fails visibly, which is the ticket's stated behavior.
async function fillPublishedLinks(searchedDomain) {
  if (!offerlab.isEnabled() || !offerlab.isConnected()) return;

  for (const draft of currentPitchDrafts.filter(entry => !entry.publishedUrl)) {
    try {
      const url = await offerlab.publishedUrlFor(draft.stackId);
      if (!url) continue;
      offerlab.rememberPublishedUrl(searchedDomain, draft.stackId, url);
      draft.publishedUrl = url;
      const link = elements.pitchBundlesBuilt?.querySelector(`[data-stack-id="${CSS.escape(String(draft.stackId))}"] .pitch-bundle-link--pdp`);
      if (link) {
        link.href = url;
        link.hidden = false;
      }
    } catch (err) {
      console.warn(`[Pitch] Could not check whether stack ${draft.stackId} is published:`, err.message);
    }
  }
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

async function openPitchModal(brand, { skipUrlUpdate = false } = {}) {
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
      <h2 class="modal-title">Pitch them</h2>
      <p class="modal-subtitle-text">${escapeHtml(currentPitchBrand1)} &times; ${escapeHtml(currentPitchBrand2)}</p>
    </div>
  `;

  // Render quick links card for both brands
  renderQuickLinksCard(searchedBrand, brand);
  const bundlesBuilt = renderBundlesBuilt(searchedDomain, partnerDomain);

  // Show modal
  elements.pitchModalOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // Update URL with pitch param
  if (!skipUrlUpdate) {
    const url = new URL(window.location.href);
    url.searchParams.set('pitch', brand.name);
    history.pushState(null, '', url.toString());
  }

  // The pitch prompt names the bundles already built for this pair, so they are in before it runs.
  await bundlesBuilt;

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
    recommendedBrand: currentPitchBrand || null,
    bundlesBuilt: currentPitchDrafts
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
   Search (shared/search.js runs it; the server runs the same one)
   -------------------------------------------------------------------------- */

const LOADING_MESSAGES = [
  "Researching your brand...",
  "Analyzing products, audience & market position...",
  "Finding complementary brands...",
  "Verifying product recommendations...",
  "Fetching product images...",
  "Finalizing results..."
];


async function discoverComplementaryBrands(url, { onProgress, onBrandsReady, onCatalog } = {}) {
  const [feedback, knownPartners] = await Promise.all([getFeedbackHistory(), store.loadKnownPartners(extractDomain(url))]);
  return search.discoverComplementaryBrands(url, {
    api: searchApi,
    feedback,
    knownPartners,
    repairJson: jsonrepair,
    onProgress: (step) => { if (onProgress) onProgress(LOADING_MESSAGES[step] ?? LOADING_MESSAGES[0]); },
    onBrandsReady,
    onCatalog,
    config: { catalogConcurrency: CONFIG.CATALOG_CONCURRENCY, serpFallbackBrands: CONFIG.SERP_FALLBACK_BRANDS }
  });
}

// Other modules parse Gemini output with the browser's jsonrepair fallback.
function parseJsonResponse(text) {
  return search.parseJsonResponse(text, jsonrepair);
}

/* --------------------------------------------------------------------------
   Typing Placeholder Animation
   -------------------------------------------------------------------------- */

const TYPING_MESSAGES = ["Find your next collab", "Type a brand name or URL", "Get instant recommendations"];
// Brands seeded into the demo environment. The "Try {domain}" placeholder rotates through these,
// one per cycle, with the brand's favicon inline after "Try".
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
  const cached = await getCachedResults(domain);
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
  
  // Only when there are tiles on screen to clear. A URL restore starts on the results view, and
  // playing the exit there held them over it for the length of the animation.
  if (!fromUrlRestore && !elements.landingSection.classList.contains('hidden')) whipOutTiles();
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
  liveResults = null;
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
        liveResults = brandsData;
        
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
      brands: brands.map(catalogForStore),
      searchedBrand: catalogForStore(searchedBrand),
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

// Each omnibar's suggestions: the dropdown fills with brands as a name is typed, and Enter on a
// name resolves it to a site before the search runs.
const suggestions = {};

// A domain searches at once. A name resolves first, the submit disc spinning meanwhile; a name
// that resolves to nothing says so in the dropdown and leaves the text for the person to fix.
async function submitSearch(input, suggest) {
  const typed = input.value.trim();
  if (!typed) return;
  if (isValidUrl(typed)) {
    hideAllSearchHistoryDropdowns();
    performSearch(typed);
    return;
  }
  const wrapper = input.closest('.search-input-wrapper');
  if (wrapper?.classList.contains('is-resolving')) return;
  wrapper?.classList.add('is-resolving');
  try {
    const domain = await suggest.resolve();
    // Typed on while it looked: that Enter no longer applies.
    if (input.value.trim() !== typed) return;
    if (domain) {
      input.value = domain;
      hideAllSearchHistoryDropdowns();
      performSearch(domain);
    } else {
      suggest.showMiss(typed);
    }
  } finally {
    wrapper?.classList.remove('is-resolving');
  }
}

function initEventListeners() {
  suggestions.landing = attachBrandSuggestions({
    input: elements.searchInput,
    dropdown: elements.searchHistoryDropdown,
    list: elements.historyList,
    history: () => getSearchHistory().map(item => item.domain),
    showHistory: () => { renderSearchHistory(elements.historyList); refreshSearchHistory(); },
    favicon: getFaviconUrl
  });
  suggestions.results = attachBrandSuggestions({
    input: elements.resultsSearchInput,
    dropdown: elements.resultsSearchHistoryDropdown,
    list: elements.resultsHistoryList,
    history: () => getSearchHistory().map(item => item.domain),
    showHistory: () => { renderSearchHistory(elements.resultsHistoryList); refreshSearchHistory(); },
    favicon: getFaviconUrl
  });

  // Main search form
  elements.searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitSearch(elements.searchInput, suggestions.landing);
  });

  // Results search form
  elements.resultsSearchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitSearch(elements.resultsSearchInput, suggestions.results);
  });

  // Search input focus/blur for history dropdown (Landing Page)
  elements.searchInput.addEventListener('focus', () => {
    elements.searchInput.classList.add('focused');
    showSearchHistory(elements.searchHistoryDropdown);
    suggestions.landing.sync();
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
    suggestions.results.sync();
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

  // A tap inside the dropdown must not blur the input: on a phone the blur dismisses the
  // keyboard, the viewport reflows under the finger, and the tap's click lands on whatever moved
  // there. Refusing the mousedown keeps the focus where it was.
  for (const dropdown of [elements.searchHistoryDropdown, elements.resultsSearchHistoryDropdown]) {
    dropdown?.addEventListener('mousedown', (e) => e.preventDefault());
  }

  // A row is chosen on the tap itself for touch (pointerup, so a scroll that starts on a row is
  // not a choice) and on the click for a mouse. Safari spends a touch's first click on hover
  // states and the keyboard's reflow, so waiting for it took two taps.
  const TAP_SLOP = 8;
  const bindHistoryList = (list, input, dropdown) => {
    if (!list) return;
    let down = null;
    let chosenAt = 0;
    const choose = (item) => {
      const url = item.dataset.url;
      chosenAt = performance.now();
      input.value = url;
      hideSearchHistory(dropdown);
      performSearch(url);
    };
    list.addEventListener('pointerdown', (e) => {
      down = e.pointerType === 'touch' ? { x: e.clientX, y: e.clientY, item: e.target.closest('.history-item') } : null;
    });
    list.addEventListener('pointerup', (e) => {
      if (!down || e.pointerType !== 'touch') return;
      const item = e.target.closest('.history-item');
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > TAP_SLOP;
      down = null;
      if (!item || item !== e.target.closest('.history-item') || moved || e.target.closest('.history-item-remove-btn')) return;
      choose(item);
    });
    list.addEventListener('click', (e) => {
      if (e.target.closest('.history-item-remove-btn')) return;
      // The click that follows a touch we already acted on.
      if (performance.now() - chosenAt < 700) return;
      const item = e.target.closest('.history-item');
      if (item) choose(item);
    });
  };
  bindHistoryList(elements.historyList, elements.searchInput, elements.searchHistoryDropdown);
  bindHistoryList(elements.resultsHistoryList, elements.resultsSearchInput, elements.resultsSearchHistoryDropdown);

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

  // On touch, a card's action buttons act on the tap itself (pointerup, with a slop so a scroll
  // that starts on one is not a press); the click Safari may or may not send afterwards is
  // ignored. Safari spends a touch's first click on the card's hover states, so waiting for it
  // took two taps.
  const ACTION_BUTTONS = '.build-bundle-btn, .generate-pitch-btn, .visit-btn, .card-menu-btn';
  let actionDown = null;
  let actionTappedAt = 0;
  document.addEventListener('pointerdown', (e) => {
    const button = e.pointerType === 'touch' ? e.target.closest(ACTION_BUTTONS) : null;
    actionDown = button ? { button, x: e.clientX, y: e.clientY } : null;
  });
  document.addEventListener('pointerup', (e) => {
    if (!actionDown || e.pointerType !== 'touch') return;
    const { button, x, y } = actionDown;
    actionDown = null;
    if (e.target.closest(ACTION_BUTTONS) !== button || Math.hypot(e.clientX - x, e.clientY - y) > 8) return;
    actionTappedAt = performance.now();
    button.click();
  });
  document.addEventListener('click', (e) => {
    if (!e.isTrusted || performance.now() - actionTappedAt > 700 || !e.target.closest(ACTION_BUTTONS)) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);

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

    const moderationAction = e.target.closest('.moderation-action');
    if (moderationAction) {
      e.stopPropagation();
      if (!moderationAction.disabled) moderateCard(moderationAction.closest('.result-card'), moderationAction.dataset.action, moderationAction.closest('.social-popover'));
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

// The dark bar is fixed, so anything sizing itself to the viewport (the picker) has to subtract
// it. A fixed 60px today, but published rather than hardcoded so type or zoom changes carry.
function trackHeaderHeight() {
  const header = elements.siteHeader;
  if (!header) return;
  const publish = () => document.documentElement.style.setProperty('--header-h', `${header.offsetHeight}px`);
  publish();
  if (window.ResizeObserver) new ResizeObserver(publish).observe(header);
  else window.addEventListener('resize', publish);
}

/* --------------------------------------------------------------------------
   The results omnibar: in the bar on a desktop, a footer in flow on a phone
   -------------------------------------------------------------------------- */
const PHONE_FOOTER = window.matchMedia('(max-width: 900px)');

// On a phone the back control and the pill both live in the footer, back first, so the sheet has
// one sticky bar rather than two; a desktop keeps them at the top of the sheet.
function placeOmnibar() {
  const search = document.querySelector('#viewHeader .header-nav-search, #omniFooter .header-nav-search');
  const back = document.querySelector('#viewHeader .header-nav-back-wrapper, #omniFooter .header-nav-back-wrapper');
  const { viewHeader, omniFooter } = elements;
  if (!search || !viewHeader || !omniFooter) return;
  const home = PHONE_FOOTER.matches ? omniFooter : viewHeader;
  for (const part of [back, search]) {
    if (part && part.parentElement !== home) home.appendChild(part);
  }
  syncOmniFooter();
}

// The footer shows and loads with the bar; the bar's classes are its only source of truth.
function syncOmniFooter() {
  const { viewHeader, omniFooter } = elements;
  if (!viewHeader || !omniFooter) return;
  omniFooter.classList.toggle('hidden', !PHONE_FOOTER.matches || viewHeader.classList.contains('hidden'));
  omniFooter.classList.toggle('view-header--loading', viewHeader.classList.contains('view-header--loading'));
}

function initOmniFooter() {
  placeOmnibar();
  PHONE_FOOTER.addEventListener('change', placeOmnibar);
  if (elements.viewHeader) new MutationObserver(syncOmniFooter).observe(elements.viewHeader, { attributes: true, attributeFilter: ['class'] });
}

function init() {
  hydrateIcons();
  trackHeaderHeight();
  initOmniFooter();
  initPicker();
  console.log('[init] Starting...');
  console.log('[init] elements.searchInput:', elements.searchInput);
  console.log('[init] elements.typingPlaceholder:', elements.typingPlaceholder);
  console.log('[init] elements.searchHistoryDropdown:', elements.searchHistoryDropdown);
  
  initEventListeners();
  console.log('[init] Event listeners initialized');
  revealStaffMenus();
  
  initTypingPlaceholders();
  console.log('[init] Typing placeholders initialized');
  
  initTileTilt();
  renderSearchHistory();
  refreshSearchHistory();
  console.log('[init] Render complete');

  initLibrary();
  initPhotoSearch({ search: url => { hideAllSearchHistoryDropdowns(); performSearch(url); } });
  initModeSwitch();

  // Restore from URL (refresh, direct link, or browser back/forward). The library mode wins
  // over a search, so ?view=library&q=... opens the library with the search kept for the way back.
  const initialSearch = getSearchFromUrl();
  if (modeFromUrl() === 'library') {
    showSection('library');
  } else if (initialSearch && isValidUrl(initialSearch)) {
    performSearch(initialSearch, { fromUrlRestore: true });
  }

  // Sync UI when user uses browser back/forward
  window.addEventListener('popstate', () => {
    if (modeFromUrl() === 'library') {
      showSection('library');
      return;
    }
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
