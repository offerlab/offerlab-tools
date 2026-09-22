/**
 * Photo search: a picture of a product becomes the brand's search (OL-4034). Gemini reads the
 * pack, SerpAPI finds the site when the pack does not carry one, and the finder runs the search it
 * would have run from the typed URL. The photo goes to the model and nowhere else.
 */
import { suggestBrands, findSite, hostOf } from './resolve.js';

const MODEL = 'gemini-2.5-flash';
const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.82;

const PROMPT = `This is a photo of a consumer product, taken in a store or at a trade show. Identify the brand
that makes it: the company name as printed on the packaging, not the product name, the flavor, or a
retailer. For the website, return the domain printed on the pack if there is one; otherwise the
brand's official website if you know it with confidence; otherwise null. Never guess a domain.
Answer as JSON shaped {"brand": string | null, "product": string | null, "website": string | null}.
If no brand is readable, brand is null.`;

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
  ui.working('Reading the photo…', file);
  try {
    const image = await shrink(file);
    const read = await readPack(image);
    if (!read?.brand) return ui.fail("Couldn't read a brand on that. Type the URL instead");
    // The omnibar's resolver for exactly that name first: the model's read of a printed domain is
    // not reliable (it reported MADEGOOD.COM, a film studio, off a MadeGood pack). Then the site the
    // model read or knows, then a search.
    ui.working(`Finding ${read.brand}'s site…`);
    const domain = await exactSuggestion(read.brand) || hostOf(read.website) || await findSite(read.brand, read.product || '');
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
 * Showcase eyebrow; the field itself is never written to. Typing dismisses it. While the photo
 * is being read, a thumbnail of it stands beside the message, which shimmers until it is done.
 */
function pillUi(wrapper, button, field) {
  const container = wrapper.closest('.omni-ai-box-container') || wrapper.parentElement;
  const strap = document.createElement('div');
  strap.className = 'omni-chinstrap';
  strap.setAttribute('role', 'status');
  const thumb = document.createElement('img');
  thumb.className = 'omni-chinstrap-thumb';
  thumb.alt = '';
  thumb.hidden = true;
  const text = document.createElement('span');
  text.className = 'omni-chinstrap-text';
  strap.append(thumb, text);
  container.appendChild(strap);
  let hideTimer = 0;
  let thumbUrl = null;

  const show = (message, { error = false, shimmer = false } = {}) => {
    clearTimeout(hideTimer);
    text.textContent = message;
    text.classList.toggle('text-shimmer-ink', shimmer);
    strap.classList.toggle('omni-chinstrap--error', error);
    strap.classList.add('is-open');
  };
  const dropThumb = () => {
    thumb.hidden = true;
    thumb.removeAttribute('src');
    if (thumbUrl) URL.revokeObjectURL(thumbUrl);
    thumbUrl = null;
  };
  const hide = () => { clearTimeout(hideTimer); strap.classList.remove('is-open'); dropThumb(); };
  const settle = () => {
    button.classList.remove('is-working');
    button.disabled = false;
  };
  field.addEventListener('input', hide);

  return {
    working(message, file) {
      button.classList.add('is-working');
      button.disabled = true;
      // The browser can show a HEIC it cannot decode as nothing; the strap reads fine without it.
      if (file) {
        dropThumb();
        thumbUrl = URL.createObjectURL(file);
        thumb.src = thumbUrl;
        thumb.hidden = false;
        thumb.onerror = dropThumb;
      }
      show(message, { shimmer: true });
    },
    fail(message) {
      settle();
      dropThumb();
      show(message, { error: true });
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

const plainName = name => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The suggestion whose name is the brand's, spelled loosely ("MADE GOOD" is "Made Good"). Not the
 * first suggestion: a name read off a pack is exact, and the first hit for it can be a namesake.
 */
async function exactSuggestion(brand) {
  const key = plainName(brand);
  const hit = (await suggestBrands(brand)).find(row => plainName(row.name) === key);
  return hit?.domain || null;
}
