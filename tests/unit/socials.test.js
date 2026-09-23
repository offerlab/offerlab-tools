import { describe, expect, it } from 'vitest';
import { normalizeSocial, matchSocial, socialCandidatesFromHtml, mergeSocial, SOCIAL_DISPLAY_ORDER } from '$lib/shared/socials.js';

const CHANNEL_ID = 'UC' + 'a'.repeat(22);

describe('normalizeSocial', () => {
  it('accepts handles, urls and stored objects', () => {
    const out = normalizeSocial({
      instagram: '@graza',
      tiktok: 'https://www.tiktok.com/@grazaco',
      twitter: { handle: 'graza' },
      youtube: CHANNEL_ID,
      facebook: 'not a handle!!',
      pinterest: null,
      shopmy: { handle: 'graza', url: 'https://shopmy.us/graza-shop' }
    });
    expect(out).toEqual({
      instagram: { handle: 'graza', url: 'https://www.instagram.com/graza' },
      tiktok: { handle: 'grazaco', url: 'https://www.tiktok.com/@grazaco' },
      twitter: { handle: 'graza', url: 'https://twitter.com/graza' },
      youtube: { handle: CHANNEL_ID, url: `https://www.youtube.com/channel/${CHANNEL_ID}` },
      shopmy: { handle: 'graza', url: 'https://shopmy.us/graza-shop' }
    });
    expect(Object.keys(out)).toEqual(SOCIAL_DISPLAY_ORDER.filter(key => key in out));
  });

  it('drops a url for the wrong platform and ignores junk', () => {
    expect(normalizeSocial({ instagram: 'https://www.tiktok.com/@x' })).toEqual({});
    expect(normalizeSocial(null)).toEqual({});
    expect(normalizeSocial('graza')).toEqual({});
  });
});

describe('matchSocial', () => {
  it('takes the first real handle per platform and skips blocklisted paths', () => {
    const found = {};
    matchSocial(found, 'https://www.instagram.com/p/abc123');
    expect(found.instagram).toBeUndefined();
    matchSocial(found, 'https://instagram.com/graza?hl=en');
    matchSocial(found, 'https://instagram.com/other');
    expect(found.instagram).toEqual({ handle: 'graza', url: 'https://www.instagram.com/graza' });
  });

  it('matches hosts at a boundary', () => {
    const found = {};
    matchSocial(found, 'https://netflix.com/graza');
    expect(found.twitter).toBeUndefined();
    matchSocial(found, 'https://x.com/graza');
    expect(found.twitter.handle).toBe('graza');
    matchSocial(found, 'https://m.tiktok.com/@graza');
    expect(found.tiktok.handle).toBe('graza');
  });

  it('lets a youtube handle replace a channel id, never the other way', () => {
    const found = {};
    matchSocial(found, `https://www.youtube.com/channel/${CHANNEL_ID}`);
    expect(found.youtube.handle).toBe(CHANNEL_ID);
    matchSocial(found, 'https://www.youtube.com/@graza');
    expect(found.youtube).toEqual({ handle: 'graza', url: 'https://www.youtube.com/@graza' });
    matchSocial(found, `https://www.youtube.com/channel/${CHANNEL_ID}`);
    expect(found.youtube.handle).toBe('graza');
  });
});

describe('socialCandidatesFromHtml', () => {
  const html = `
    <html><head>
      <meta property="og:title" content="Graza">
      <meta name="twitter:site" content="@graza" />
      <script type="application/ld+json">{"@type":"Organization","sameAs":["https://www.instagram.com/graza","https://www.tiktok.com/@graza"]}</script>
    </head><body>
      <a href="https://www.facebook.com/graza?ref=x&amp;y=1">fb</a>
      <a href='/about'>about</a>
    </body></html>`;

  it('lists hrefs, sameAs entries and the meta values', () => {
    const { candidates, metadata } = socialCandidatesFromHtml(html);
    expect(candidates).toEqual([
      'https://www.facebook.com/graza?ref=x&y=1',
      '/about',
      'https://www.instagram.com/graza',
      'https://www.tiktok.com/@graza'
    ]);
    expect(metadata).toEqual({ 'og:title': 'Graza', 'twitter:site': '@graza' });
  });

  it('feeds matchSocial', () => {
    const found = {};
    for (const raw of socialCandidatesFromHtml(html).candidates) matchSocial(found, raw);
    expect(Object.keys(found).sort()).toEqual(['facebook', 'instagram', 'tiktok']);
  });
});

describe('mergeSocial', () => {
  it('lets the site win and the AI fill the gaps', () => {
    const merged = mergeSocial(
      { instagram: { handle: 'graza_official', url: 'https://www.instagram.com/graza_official' } },
      { instagram: '@graza', tiktok: '@grazaco' }
    );
    expect(merged).toEqual({
      instagram: { handle: 'graza_official', url: 'https://www.instagram.com/graza_official' },
      tiktok: { handle: 'grazaco', url: 'https://www.tiktok.com/@grazaco' }
    });
  });

  it('copes with nothing on either side', () => {
    expect(mergeSocial(undefined, undefined)).toEqual({});
  });
});
