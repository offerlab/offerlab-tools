<script>
  /**
   * The header's OfferLab account control. Signed out the chip signs in; signed in it opens its
   * menu. One control, two jobs, because the header has room for one thing and both are about
   * the same connection.
   */
  import { onMount } from 'svelte';
  import * as offerlab from '$lib/client/offerlab.js';
  import { session, refreshAccount, connectOfferLab, switchAccount, signOut, toggleAccountMenu, closeAccountMenu } from '$lib/client/account.svelte.js';
  import Icon from './Icon.svelte';

  const team = $derived(session.connected && session.account ? (session.account.team || 'OfferLab') : 'Sign in');
  // Standing in for the team's avatar, which list_teams does not return yet (OL-3997).
  const initial = $derived(team.trim().charAt(0).toUpperCase());
  const limited = $derived(session.connected && session.account?.developer === false);

  function onAccountClick(e) {
    e.stopPropagation();
    if (!offerlab.isConnected()) { connectOfferLab(); return; }
    toggleAccountMenu();
  }

  function onMenuClick(e) {
    const item = e.target.closest('[data-action]');
    if (!item) return;
    closeAccountMenu();
    if (item.dataset.action === 'offerlab-signout') signOut();
    else if (item.dataset.action === 'offerlab-switch') switchAccount();
  }

  onMount(() => {
    // Before anything reads the query string: a sign-in redirect left its own parameters there and
    // this puts the finder's back. Not awaited — the token exchange only has to beat the next click.
    offerlab.completeRedirect()
      .catch(err => { console.warn('[OfferLab] sign-in did not complete:', err); })
      .finally(refreshAccount);
    const onKeydown = (e) => { if (e.key === 'Escape') closeAccountMenu(); };
    document.addEventListener('click', closeAccountMenu);
    document.addEventListener('keydown', onKeydown);
    return () => {
      document.removeEventListener('click', closeAccountMenu);
      document.removeEventListener('keydown', onKeydown);
    };
  });
</script>

<div class="offerlab-account-wrap" id="offerlabAccountWrap" class:hidden={!session.enabled}>
  <button type="button" class="offerlab-account" id="offerlabAccount" aria-haspopup="true" aria-expanded={session.menuOpen}
    class:is-disconnected={!session.connected} class:is-limited={limited}
    title={session.connected ? '' : 'Sign in to OfferLab to create bundles from here'}
    aria-label={session.connected ? 'OfferLab account' : 'Sign in to OfferLab'}
    onclick={onAccountClick}>
    <span class="offerlab-account-badge" id="offerlabAccountBadge" aria-hidden="true">{#if !session.connected}<Icon name="passkeys" size={18} />{:else if session.account}{initial}{/if}</span>
    <span class="offerlab-account-team" id="offerlabAccountTeam">{team}</span>
    <span class="offerlab-account-caret" id="offerlabAccountCaret" aria-hidden="true">{#if session.connected}<Icon name="chevron-bottom" size={12} />{/if}</span>
  </button>
  <div class="offerlab-account-menu" id="offerlabAccountMenu" role="menu" class:hidden={!session.menuOpen} onclick={onMenuClick}>
    {#if limited}<div class="offerlab-account-menu-meta" id="offerlabAccountMeta">No developer access, so bundles cannot be created</div>{/if}
    <button type="button" class="offerlab-account-menu-item" role="menuitem" data-action="offerlab-switch"><Icon name="arrows-switch-swap" size={20} />Switch account</button>
    <button type="button" class="offerlab-account-menu-item" role="menuitem" data-action="offerlab-signout"><Icon name="arrow-box-left" size={20} />Sign out</button>
  </div>
</div>
