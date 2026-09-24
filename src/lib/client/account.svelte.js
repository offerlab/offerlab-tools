/**
 * The OfferLab account behind the header control, as reactive state: which OfferLab this is
 * talking to and whether the account may create anything. Shown because an operator about to
 * publish a brand's bundle should be able to see, without clicking, which team it is going into.
 */
import * as offerlab from './offerlab.js';
import { app } from './state.svelte.js';
import { setDraft } from './picker-state.svelte.js';

export const session = $state({
  enabled: true,        // offerlab.isEnabled(), re-read on every refresh
  connected: false,
  account: null,        // { team, developer } once loadAccount has answered
  canCreateDrafts: null, // null until the role is known
  menuOpen: false
});

export function toggleAccountMenu() {
  session.menuOpen = !session.menuOpen;
}

export function closeAccountMenu() {
  session.menuOpen = false;
}

export async function refreshAccount() {
  closeAccountMenu();
  session.enabled = offerlab.isEnabled();
  if (!session.enabled) return;

  // Signed out, the control is the way in. Connecting used to be reachable only from the tray,
  // which means only after searching, opening a picker and selecting something.
  session.connected = offerlab.isConnected();
  if (!session.connected) {
    session.account = null;
    session.canCreateDrafts = null;
    app.account = null;
    app.staff = false;
    return;
  }

  try {
    const { account } = await offerlab.loadAccount();
    session.account = account;
    app.account = account;
    app.staff = account?.developer === true;
  } catch (err) {
    console.warn('[OfferLab] could not read the account:', err.message);
  }
  session.canCreateDrafts = offerlab.canCreateDrafts();
}

export async function connectOfferLab() {
  try {
    await offerlab.connect();
  } catch (err) {
    console.warn('[OfferLab] could not start sign-in:', err);
    setDraft('error', err.message || 'Could not reach OfferLab');
  }
}

export function signOut() {
  offerlab.disconnect();
  refreshAccount();
}

/**
 * Re-running OAuth would hand back the same account: the authorize step reuses the session on
 * OfferLab's side and the server has no prompt handling to override that. So signing out there is
 * a separate step, in its own tab, and the operator comes back and signs in again.
 */
export async function switchAccount() {
  offerlab.disconnect();
  refreshAccount();
  window.open(`${await offerlab.host()}/users/sign_out`, '_blank', 'noopener');
  setDraft('pending', 'Sign out of OfferLab in the new tab, then sign in again here');
}
