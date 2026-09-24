/**
 * The omnibar's typing placeholder: cycles through the hints, then "Try {domain}" with the demo
 * brand's favicon inline, one demo brand per cycle. Stops on focus or once there is text.
 */
import { CONFIG, getFaviconUrl } from '../util.js';

const TYPING_MESSAGES = ['Find your next collab', 'Type a brand name or URL', 'Get instant recommendations'];
// Brands seeded into the demo environment. The "Try {domain}" placeholder rotates through these.
export const DEMO_BRANDS = ['magicspoon.com', 'monos.com', 'flamingoestate.com', 'wildone.com', 'fanttik.com', 'jolieskinco.com'];
const TRY_PREFIX = 'Try ';
const TYPING_SPEED = 80;
const PAUSE_AFTER_TYPE = 2000;
const FADE_OUT_DURATION = 400;

export function preloadDemoAvatars() {
  DEMO_BRANDS.forEach((domain) => { new Image().src = getFaviconUrl(domain); });
}

function buildTypingSequence(demoIndex) {
  const domain = DEMO_BRANDS[demoIndex % DEMO_BRANDS.length];
  return [...TYPING_MESSAGES, { text: `${TRY_PREFIX}${domain}`, avatarDomain: domain }];
}

/** Returns { start, stop, hide }; binds focus, blur and input on the field. */
export function createTypingAnimation(placeholderEl, inputEl) {
  if (!placeholderEl || !inputEl) return null;

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
    timeoutId = setTimeout(charIndex === text.length ? fadeOutAndNext : tick, charIndex === text.length ? PAUSE_AFTER_TYPE : TYPING_SPEED);
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

  // Hidden without restoring the field's placeholder: the results bar shows the searched brand.
  function hide() {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    placeholderEl.classList.add('hidden');
    placeholderEl.innerHTML = '';
  }

  const onFocus = () => stop();
  const onBlur = () => { if (!inputEl.value.trim()) start(); };
  const onInput = () => {
    if (inputEl.value.trim()) {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      placeholderEl.classList.add('hidden');
    } else if (document.activeElement !== inputEl) {
      start();
    }
  };
  inputEl.addEventListener('focus', onFocus);
  inputEl.addEventListener('blur', onBlur);
  inputEl.addEventListener('input', onInput);

  function destroy() {
    hide();
    inputEl.removeEventListener('focus', onFocus);
    inputEl.removeEventListener('blur', onBlur);
    inputEl.removeEventListener('input', onInput);
  }

  return { start, stop, hide, destroy };
}
