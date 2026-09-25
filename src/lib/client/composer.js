/**
 * What the results bar does with what was typed. A web address searches; a sentence is a note to
 * the agent; one or two bare words could be either (a brand name, or a steer like "gifting"), so
 * they are looked up first and the person is asked when the lookup is sure.
 */
import { looksLikeDomain, suggestBrands, hostOf } from './resolve.js';

const LOOKUP_WORDS = 2;

/** 'search' for a web address, 'lookup' for one or two plain words, 'note' for anything longer. */
export function composerIntent(text) {
  const typed = String(text || '').trim();
  if (!typed) return 'none';
  if (looksLikeDomain(typed)) return 'search';
  const words = typed.split(/\s+/);
  if (words.length <= LOOKUP_WORDS && !/[?!.,;:]/.test(typed)) return 'lookup';
  return 'note';
}

/**
 * The site of a brand whose name is exactly what was typed, or null. History matches count as
 * sure; a suggestion counts only when its name or its site's own label is the typed text, so
 * "olipop" is olipop.com and "gifting" is nothing.
 */
export async function confidentBrand(text, { history = () => [] } = {}) {
  const typed = String(text || '').trim().toLowerCase();
  if (!typed) return null;
  const slug = typed.replace(/[^a-z0-9]/g, '');
  const fromHistory = (history() || []).map(hostOf).find(domain => domain && label(domain) === slug);
  if (fromHistory) return fromHistory;
  const rows = await suggestBrands(typed);
  const exact = rows.find(row => row.name.toLowerCase() === typed || label(row.domain) === slug);
  return exact ? exact.domain : null;
}

function label(domain) {
  return String(domain || '').split('.')[0].replace(/[^a-z0-9]/g, '');
}
