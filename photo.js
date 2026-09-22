/**
 * Photo search: a picture of a product becomes the brand's search (OL-4034). Gemini reads the
 * pack, SerpAPI finds the site when the pack does not carry one, and the finder runs the search it
 * would have run from the typed URL. The photo goes to the model and nowhere else.
 */
const MODEL = 'gemini-2.5-flash';
const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.82;

// Sites a product search returns ahead of the brand's own.
const NOT_THE_BRAND = new Set([
  'amazon', 'walmart', 'target', 'costco', 'kroger', 'instacart', 'thrivemarket', 'wholefoodsmarket', 'sprouts',
  'etsy', 'ebay', 'shopify', 'instagram', 'facebook', 'tiktok', 'youtube', 'x', 'twitter', 'linkedin', 'pinterest',
  'reddit', 'wikipedia', 'google', 'apple', 'yelp', 'crunchbase', 'bloomberg', 'forbes', 'grocery', 'iherb', 'vitacost'
]);

const PROMPT = `This is a photo of a consumer product, taken in a store or at a trade show. Identify the brand
that makes it: the company name as printed on the packaging, not the product name, the flavor, or a
retailer. If a website or domain is printed on the pack, return it. Answer as JSON shaped
{"brand": string | null, "product": string | null, "website": string | null}. If no brand is readable,
brand is null.`;

/**
 * Wires every photo button on the page. `search(domain)` is the finder's own search; `settle` is
 * what to do with the pill once the photo has been dealt with, whichever way.
 */
export function initPhotoSearch({ search }) {
  for (const button of document.querySelectorAll('.photo-button')) {
    const wrapper = button.closest('.search-input-wrapper');
    const input = wrapper.querySelector('.photo-input');
    const field = wrapper.querySelector('.search-input');
    const ui = pillUi(wrapper, button, field);
    // No capture attribute: a phone's own picker offers the camera and the library.
    button.addEventListener('click', () => { input.value = ''; input.click(); });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) fromPhoto(file, ui, search);
    });
  }
}

async function fromPhoto(file, ui, search) {
  ui.working('Reading the photo…');
  try {
    const image = await shrink(file);
    const read = await readPack(image);
    if (!read?.brand) return ui.fail("Couldn't read a brand on that. Type the URL instead");
    let domain = hostOf(read.website);
    if (!domain) {
      ui.working(`Finding ${read.brand}'s site…`);
      domain = await findSite(read.brand, read.product);
    }
    if (!domain) return ui.fail(`Couldn't find ${read.brand}'s site. Type the URL instead`);
    ui.done();
    search(domain);
  } catch (err) {
    console.warn('[photo] search failed:', err);
    ui.fail(/Gemini|SerpAPI/.test(err.message) ? "Couldn't reach the search right now. Try again" : "Couldn't read that photo. Type the URL instead");
  }
}

/* -------------------------------------------------------------------------- */
/* The pill while it works                                                     */
/* -------------------------------------------------------------------------- */

const ERROR_MS = 6000;

/**
 * Progress and errors ride a chinstrap tucked under the pill's bottom edge, the mirror of the
 * Showcase eyebrow; the field itself is never written to. Typing dismisses it.
 */
function pillUi(wrapper, button, field) {
  const container = wrapper.closest('.omni-ai-box-container') || wrapper.parentElement;
  const strap = document.createElement('div');
  strap.className = 'omni-chinstrap';
  strap.setAttribute('role', 'status');
  container.appendChild(strap);
  let hideTimer = 0;

  const show = (message, error = false) => {
    clearTimeout(hideTimer);
    strap.textContent = message;
    strap.classList.toggle('omni-chinstrap--error', error);
    strap.classList.add('is-open');
  };
  const hide = () => { clearTimeout(hideTimer); strap.classList.remove('is-open'); };
  const settle = () => {
    button.classList.remove('is-working');
    button.disabled = false;
  };
  field.addEventListener('input', hide);

  return {
    working(message) {
      button.classList.add('is-working');
      button.disabled = true;
      show(message);
    },
    fail(message) {
      settle();
      show(message, true);
      hideTimer = setTimeout(hide, ERROR_MS);
    },
    done() {
      settle();
      hide();
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Reading the pack                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A phone photo is 3 to 12 MB; the model needs a fraction of that to read a logo. A browser that
 * cannot decode the file (Chromium with an iPhone's HEIC) sends it whole: the model reads HEIC.
 */
async function shrink(file) {
  let bitmap;
  try {
    bitmap = await decode(file);
  } catch {
    return { mimeType: file.type || 'image/heic', data: await base64Of(file) };
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  return { mimeType: 'image/jpeg', data: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}

async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Older Safari: no bitmap from a HEIC blob, but an <img> can still decode it.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function base64Of(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function readPack(image) {
  const response = await fetch(`/api/gemini?model=${encodeURIComponent(MODEL)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: image.mimeType, data: image.data } }, { text: PROMPT }] }],
      // 2.5 Flash thinks before it answers and the thinking counts against this budget.
      generationConfig: { temperature: 0.1, maxOutputTokens: 2048, responseMimeType: 'application/json' }
    })
  });
  if (!response.ok) throw new Error(`Gemini ${response.status}`);
  const data = await response.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('');
  const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  console.log('[photo] read:', parsed);
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* Finding the site                                                            */
/* -------------------------------------------------------------------------- */

async function findSite(brand, product) {
  const params = new URLSearchParams({ q: `${brand} ${product || ''} official site`.replace(/\s+/g, ' ').trim(), engine: 'google' });
  const response = await fetch(`/api/serpapi?${params}`);
  if (!response.ok) throw new Error(`SerpAPI ${response.status}`);
  const data = await response.json();
  const hosts = (data.organic_results || []).map(r => hostOf(r.link)).filter(h => h && !NOT_THE_BRAND.has(secondLevel(h)));
  // The brand's own domain usually carries its name; failing that, the first site that is not a
  // retailer is the best guess Google offers.
  const key = brand.toLowerCase().replace(/[^a-z0-9]/g, '');
  return hosts.find(h => key && secondLevel(h).replace(/[^a-z0-9]/g, '').includes(key.slice(0, Math.max(4, key.length)))) || hosts[0] || null;
}

function hostOf(url) {
  if (!url) return null;
  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
    return host.includes('.') ? host.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

const secondLevel = host => host.split('.').slice(-2, -1)[0] || host;
