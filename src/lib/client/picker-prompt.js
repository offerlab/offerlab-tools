/**
 * The picker's Gemini prompts: the bundle concepts brief and the card's headline copy.
 */
import { picker, sellerEntry } from './picker-state.svelte.js';

export const CONCEPT_MODEL = 'gemini-2.5-flash';
export const CONCEPT_COUNT = 4;
export const MAX_PRODUCTS_IN_PROMPT = 60;
export const MAX_PICKS_PER_BRAND = 3;
// Naming the angles, and quoting a quota against them, is what stops every concept landing on
// the same safe pairing. Ported from the brand recommendation prompt, which works the same way.
export const CONCEPT_ANGLES = {
  'same-ritual': 'used together in one sitting or one routine',
  'starter-kit': 'everything someone needs to attempt a thing for the first time',
  'upgrade': 'a staple plus the thing that makes it noticeably better',
  'gift-ready': 'reads as a present with no explanation needed',
  'subculture': 'speaks to one specific identity, hobby, or community',
  'trend-jack': 'hooks a cultural moment or something running on social right now',
  'odd-couple': 'makes no sense on paper, then total sense once you picture it'
};
const OBVIOUS_ANGLES = ['same-ritual', 'starter-kit', 'upgrade'];
const UNEXPECTED_ANGLES = ['subculture', 'trend-jack', 'odd-couple'];

// Trade-only and non-physical listings make bad bundle members and crowd out the catalog the
// model actually gets to see, so they never reach the prompt.
const PROMPT_EXCLUDE_TITLE = /wholesale|case of \d|gift card|subscription|\bsample\b/i;

function promptProducts(brand) {
  return (brand.catalog?.products || [])
    .filter(p => p.available)
    .filter(p => !(p.tags || []).some(t => /^hidden$/i.test(t)))
    .filter(p => !PROMPT_EXCLUDE_TITLE.test(p.title))
    .slice(0, MAX_PRODUCTS_IN_PROMPT);
}

function promptCatalog(entry, prefix, handles) {
  return promptProducts(entry.brand).map((p, i) => {
    const handle = `${prefix}${i + 1}`;
    handles.set(handle, { domain: entry.domain, product: p });
    const price = p.price === null || p.price === undefined ? 'price n/a' : `$${p.price}`;
    const type = p.productType ? ` | ${p.productType}` : '';
    const about = p.description ? ` | ${p.description}` : '';
    return `${handle} | ${p.title} | ${price}${type}${about}`;
  }).join('\n');
}

function promptProfile(brand) {
  const lines = [`Name: ${brand.name}`, `Site: ${brand.url || ''}`];
  if (brand.description) lines.push(`About: ${brand.description}`);
  if (brand.reason) lines.push(`Why they pair: ${brand.reason}`);
  if (brand.brandDNA) lines.push(`Brand DNA: ${JSON.stringify(brand.brandDNA)}`);
  if (brand.targetCustomer) lines.push(`Customer: ${JSON.stringify(brand.targetCustomer)}`);
  return lines.join('\n');
}

export function buildCopyPrompt() {
  const brands = picker.brands.map(e => {
    const b = e.brand;
    return `${b.name} (${e.domain})${b.description ? `: ${b.description}` : ''}`;
  }).join('\n');

  return `Write the headline and subtitle for a card that offers to invent co-branded product bundles from these brands' catalogs. It sits on a screen at a trade show booth, where a merchant is looking at their own brand next to possible partners.

Brands, the first being the one the bundles would be sold by:
${brands}

Headline: 7 words or fewer. Start with a capital letter and use ordinary sentence capitalization, not Title Case. It has to make clear this is about BUNDLING these brands' products together, and must contain one of these exact words: bundle, bundled, bundles, pair, paired, pairing, box, kit, or set. Playful and specific to THESE brands: what they sell, who buys it, what the pairing would feel like on a shelf or a table. Never use a colon, and never the pattern "Brand and Brand: something". Do not reuse a slogan either brand already has.
Subtitle: 8 words or fewer, starting with a capital letter. An instruction for what pressing the button does, in the same voice.

When you name more than one brand together, join them with " x " (a lowercase x with a space each side), never "and", "+", or "&".

No em dashes, no exclamation marks, no ampersands, no colons. Return JSON only: {"headline": "...", "subtitle": "..."}`;
}

export function buildConceptPrompt() {
  const handles = new Map();
  const seller = sellerEntry();
  const partners = picker.brands.slice(1);
  const partnerNames = partners.map(e => e.brand.name).join(' x ');
  const sections = picker.brands.map((entry, i) => {
    const prefix = i === 0 ? 'S' : String.fromCharCode(64 + i);
    const role = i === 0 ? 'SELLER' : `PARTNER ${i}`;
    return `=== ${role}: ${entry.brand.name} (handles ${prefix}1, ${prefix}2, ...) ===\n${promptProfile(entry.brand)}\n\n--- catalog (handle | title | price | type | what it is) ---\n${promptCatalog(entry, prefix, handles)}`;
  }).join('\n\n');

  const angleList = Object.entries(CONCEPT_ANGLES)
    .map(([key, note]) => `- "${key}": ${note}`).join('\n');

  const text = `You are a world-class bundle merchandiser, part trend forecaster, part stylist, part cultural observer.

Your mission: design bundles for ${seller.brand.name} x ${partnerNames} that a shopper would screenshot and send to a friend.

A good bundle feels obvious in retrospect; a bad one feels forced. The genuinely obvious pairing is table stakes, since anyone can see the oil goes with the pan. The bundles that win are the ones nobody had thought to put in the same box, where the products together aim at a specific life, a specific week, a specific room, and the logic lands the moment you picture it.

${sections}

=== BUNDLE ANGLES ===

Classify every bundle with exactly one angle:
${angleList}

=== DIVERSITY REQUIREMENTS ===

Your ${CONCEPT_COUNT} bundles MUST include:
- Exactly ONE obvious bundle, from ${OBVIOUS_ANGLES.map(a => `"${a}"`).join(' or ')}. One. Not two.
- At least TWO from ${UNEXPECTED_ANGLES.map(a => `"${a}"`).join(' or ')}. These are the point of the exercise.
- No two bundles sharing an angle.
- No product in more than one bundle.
- A spread of price, from something bought on impulse to something considered.

What divergence actually looks like: given an olive oil brand and a cookware brand, the obvious
bundle is oil plus pan. An "odd-couple" bundle is the finishing oil plus the small dessert plates,
sold to the person whose entire personality is putting olive oil on ice cream because they saw it
on TikTok. Same catalogs, completely different thought. Aim there.

For the unexpected ones, reach for a real occasion or subculture: the first apartment, the hungover Sunday, the person who took up bread in January, the dinner party that is actually a performance, the gift for someone who already owns everything. Put that person or that moment in the hook, but vary how you get there. If more than one hook opens the same way, rewrite it.

=== ANTI-PATTERNS ===

DO NOT:
- Name a bundle after what is in it. Name the occasion, ritual, or feeling the products add up to. "Sunday Reset Bundle", never "Olive Oil and Candle Bundle".
- Lean on Kit, Set, Duo, or Essentials as the whole idea. Those words can close a name, but they cannot carry it.
- Use the words elevate, unlock, discover, transform, effortless, seamless, curated, or "everything you need", in any form. These are the words a model reaches for when it has nothing specific to say.
- Open more than one hook with the same two words. Four hooks that all start "For the ..." is one hook written four times, so at most one may use that shape.
- Describe a bundle by listing its categories, as in "olive oil and a pan". Say what it lets someone do.
- Pair the two most famous products from each brand. That bundle sells itself and teaches nobody anything.
- Use a handle that does not appear in the catalogs above.

=== VOICE ===

Real bundle names from this platform. Match this register:
  Brunch Club Box, Campfire Classics, Cold Brew Companion, Cozy Morning Ritual,
  Desk Setup Refresh, Late Night Snack Kit, Pantry Power Pack, Self-Care Sunday,
  Studio Warmup Pack, Sunday Reset Bundle, Trailhead Trio, The Coastal Pantry Pairing

- Bundle name: 4 words or fewer, Title Case, under 40 characters, no colons.
- Write "${seller.brand.name} x ${partners[0]?.brand.name || 'Partner'}", never "and".
- No exclamation marks, no em dashes.

=== COMPOSITION ===

- Every bundle needs at least one S handle and at least one partner handle.${partners.length > 1 ? `\n- Spread across partners so each of ${partnerNames} appears in at least one bundle, and combine partners when the products genuinely belong together.` : ''}
- 1 to ${MAX_PICKS_PER_BRAND} products from any one brand, 2 to 6 products total.
- discountPercent is the bundle discount versus buying separately, an integer from 10 to 25.

Return JSON only. Write each concept's fields in the order given: commit to the angle and the
person first, and choose products that serve them. Picking obvious products and labelling them
"odd-couple" afterwards is the failure mode here.
{
  "concepts": [
    {
      "angle": "one of the angle keys above",
      "occasion": "The specific person and moment, in under 12 words. Not 'the home cook'. Someone like 'the friend who hosts on a Tuesday for no reason'.",
      "name": "Bundle name, 4 words or fewer",
      "hook": "One customer-facing sentence. No two hooks in your response may open with the same two words.",
      "products": ["S1", "A3"],
      "why": "One sentence for the merchandiser on why these products belong together",
      "discountPercent": 15
    }
  ],
  "summary": "Written last, once the bundles above exist. ONE short sentence, 16 words or fewer, naming the thread running through them. Concrete and a little playful, the way you would say it out loud to a colleague: what kind of person, or what stretch of the year, this set is for. Open on the person or the moment, never on the list. Banned: collection, selection, curated, thoughtfully, seamlessly, diverse, elevate, essentials, offerings, targeting, culinary moments, and any opener of the shape 'This X brings together' or 'Here are'."
}`;

  return { text, handles };
}
