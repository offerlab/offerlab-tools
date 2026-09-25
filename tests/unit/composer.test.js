import { describe, expect, it, vi } from 'vitest';
import { composerIntent, confidentBrand } from '$lib/client/composer.js';

describe('composerIntent', () => {
  it('searches a web address, with or without a scheme or path', () => {
    expect(composerIntent('olipop.com')).toBe('search');
    expect(composerIntent('https://www.olipop.com/pages/about')).toBe('search');
  });

  it('looks up one or two plain words', () => {
    expect(composerIntent('olipop')).toBe('lookup');
    expect(composerIntent('Liquid Death')).toBe('lookup');
  });

  it('sends a sentence, or anything punctuated, as a note', () => {
    expect(composerIntent('more like Liquid Death')).toBe('note');
    expect(composerIntent('gifting?')).toBe('note');
    expect(composerIntent('less pantry, more gear')).toBe('note');
  });

  it('is nothing for nothing', () => {
    expect(composerIntent('  ')).toBe('none');
  });
});

describe('confidentBrand', () => {
  const rows = [{ name: 'OLIPOP', domain: 'olipop.com' }, { name: 'Olive & June', domain: 'oliveandjune.com' }];

  it('is sure of a history match by its site label', async () => {
    expect(await confidentBrand('olipop', { history: () => ['https://olipop.com', 'built.com'] })).toBe('olipop.com');
  });

  it('is sure of a suggestion whose name or site is the typed text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(rows))));
    try {
      expect(await confidentBrand('olipop')).toBe('olipop.com');
      expect(await confidentBrand('Liquid Death')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
