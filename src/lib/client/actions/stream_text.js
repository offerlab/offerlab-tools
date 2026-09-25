/**
 * Word-chunk streaming, mirrored from the main app (app/javascript/lib/stream_text.js): the full
 * text is in the DOM from the first frame so nothing reflows, and only the ink arrives, word by
 * word on a cadence that opens slowly and gathers pace. How a word looks arriving is in styles.css
 * (.stream-word); this only sets each word's --stream-delay.
 */

// Agent turns: open slow, then larger bites.
export const CADENCE = Object.freeze({ openMs: 85, cruiseMs: 8, tauWords: 14, pauseOpenMs: 600, pauseFloorMs: 120, chunkMax: 20 });

// Short headings: one word per beat, slower cruise. CADENCE makes these flicker.
export const HEADING_CADENCE = Object.freeze({ openMs: 90, cruiseMs: 46, tauWords: 4, pauseOpenMs: 420, pauseFloorMs: 200, chunkMax: 1 });

/** One clock for a turn; blocks streamed on the same cadence follow one another. */
export function createCadence(startMs = 0, tuning = undefined) {
  const pace = tuning ? { ...CADENCE, ...tuning } : CADENCE;
  let elapsed = startMs;
  let word = 0;
  let chunkAt = 0;
  let chunkLeft = 0;
  const momentum = () => Math.exp(-word / pace.tauWords);
  return {
    get elapsed() { return elapsed; },
    nextWord() {
      if (chunkLeft <= 0) {
        chunkAt = elapsed;
        // Granularity lags the speed on purpose: the reveal stays word-by-word through the opening
        // line, and the bites grow only once the agent is visibly in flow.
        chunkLeft = Math.max(1, Math.floor(1 + (1 - momentum()) ** 2 * (pace.chunkMax - 1)));
      }
      elapsed += pace.cruiseMs + (pace.openMs - pace.cruiseMs) * momentum();
      word += 1;
      chunkLeft -= 1;
      return chunkAt;
    },
    pause() {
      chunkLeft = 0;
      elapsed += pace.pauseFloorMs + (pace.pauseOpenMs - pace.pauseFloorMs) * momentum();
    },
    hold(ms) {
      chunkLeft = 0;
      elapsed += ms;
    }
  };
}

/** Wraps each word of `block` in its own span, keeping the whitespace and any markup around it. */
export function splitWords(block) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  const words = [];
  for (const node of textNodes) {
    const parts = node.nodeValue.split(/(\s+)/).filter(part => part.length);
    if (!parts.length) continue;
    const fragment = document.createDocumentFragment();
    for (const part of parts) {
      if (/^\s+$/.test(part)) { fragment.appendChild(document.createTextNode(part)); continue; }
      const span = document.createElement('span');
      span.className = 'stream-word';
      span.textContent = part;
      fragment.appendChild(span);
      words.push(span);
    }
    node.parentNode.replaceChild(fragment, node);
  }
  return words;
}

/** Splits `block` and starts it streaming on the cadence. Returns how many words it holds. */
export function streamIn(block, cadence = createCadence()) {
  if (!block) return 0;
  const words = splitWords(block);
  if (!words.length) return 0;
  words.forEach(word => word.style.setProperty('--stream-delay', `${cadence.nextWord()}ms`));
  block.style.setProperty('--stream-delay', words[0].style.getPropertyValue('--stream-delay'));
  block.classList.add('is-streaming');
  return words.length;
}

/**
 * Svelte action: streams the element's text in when it mounts, on the cadence it shares with its
 * neighbours; `onStreamed(ms)` hears when this element's last word will have landed. Reduced
 * motion leaves the text as it is and reports 0.
 */
export function streamText(node, { cadence, onStreamed } = {}) {
  if (typeof window === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    onStreamed?.(0);
    return;
  }
  const clock = cadence || createCadence(0, HEADING_CADENCE);
  streamIn(node, clock);
  onStreamed?.(clock.elapsed + WORD_FADE_MS);
  clock.pause();
}

// How long a word takes to arrive once its delay is up (.is-streaming .stream-word in styles.css).
const WORD_FADE_MS = 480;
