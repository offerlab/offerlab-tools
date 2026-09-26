/**
 * The Catalyst extension (offerlab/chrome_extension) as the finder's browser: on a machine where
 * it is installed, a product page a server cannot read is opened in a background tab on the
 * person's own IP and session, and the page context comes back for the build to read. The
 * extension announces itself with its id on load; nothing here is available until it has.
 */

const CAPTURE_TIMEOUT_MS = 45000;

let extensionId = null;
const readyListeners = new Set();

if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (data?.source !== 'offerlab-importer' || data?.type !== 'ready' || !data.id) return;
    extensionId = String(data.id);
    readyListeners.forEach(listener => listener(extensionId));
  });
  // An announcer that ran before this listener existed answers a hello.
  window.postMessage({ source: 'collab-finder', type: 'hello' }, window.location.origin);
}

/** Whether the extension has announced itself in this page. */
export function available() {
  return !!extensionId && typeof globalThis.chrome?.runtime?.sendMessage === 'function';
}

export function onReady(listener) {
  readyListeners.add(listener);
  if (extensionId) listener(extensionId);
  return () => readyListeners.delete(listener);
}

function send(message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The extension did not answer in time.')), timeoutMs);
    try {
      globalThis.chrome.runtime.sendMessage(extensionId, message, (response) => {
        clearTimeout(timer);
        const failure = globalThis.chrome.runtime.lastError;
        if (failure) reject(new Error(failure.message));
        else resolve(response);
      });
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

/** The page context the extension captured for `url`, or a rejection saying why not. */
export async function capturePage(url) {
  if (!available()) throw new Error('The OfferLab extension is not installed here.');
  const response = await send({ type: 'CAPTURE_PAGE', url }, CAPTURE_TIMEOUT_MS);
  if (!response?.success || !response.context) throw new Error(response?.error || 'The page could not be read.');
  return response.context;
}
