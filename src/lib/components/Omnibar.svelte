<script>
  /**
   * The search pill: the field, the photo and submit controls, and the dropdown that holds the
   * search history or, as a name is typed, brand suggestions (resolve.js). Two variants: the
   * landing page's, and the results bar's, which shows the searched brand as favicon + domain
   * whenever it is not being edited and swaps its submit for a stop control while a search runs.
   */
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { app } from '$lib/client/state.svelte.js';
  import { getFaviconUrl, CONFIG } from '$lib/client/util.js';
  import { attachBrandSuggestions } from '$lib/client/resolve.js';
  import { createTypingAnimation } from '$lib/client/actions/typing.js';
  import { historyList, renderHistoryRows } from '$lib/client/actions/history_list.js';
  import { refreshSearchHistory, removeFromSearchHistory } from '$lib/client/history.svelte.js';
  import { performSearch, submitSearch, submitComposer, stopActivity, sendNote, registerOmnibar } from '$lib/client/search.svelte.js';

  let { variant = 'landing' } = $props();
  // The variant is fixed for the life of the bar; the ids below are set once from it.
  // svelte-ignore state_referenced_locally
  const results = variant === 'results';
  const ids = results
    ? { form: 'resultsSearchForm', input: 'resultsSearchInput', dropdown: 'resultsSearchHistoryDropdown', list: 'resultsHistoryList', button: 'resultsSearchButton', placeholder: 'resultsTypingPlaceholder' }
    : { form: 'searchForm', input: 'searchInput', dropdown: 'searchHistoryDropdown', list: 'historyList', button: 'searchButton', placeholder: 'typingPlaceholder' };

  let form, input, dropdown, list, placeholderEl;
  let suggest = null;
  let typing = null;
  let focused = $state(false);
  let value = $state('');
  let dropdownOpen = $state(false);
  // One or two words that are surely a brand: the dropdown asks which was meant.
  let ask = $state(null);

  // The results composer rests empty with its invitation; the searched brand is on its card.
  const showingDisplay = false;

  // The suggestions (resolve.js) open and close the same dropdown imperatively, so the classes
  // are set directly as well: a directive only acts when its own value changes.
  function showHistory() {
    renderHistoryRows(list, app.history);
    refreshSearchHistory();
    dropdownOpen = true;
    dropdown.classList.add('visible');
    form.classList.add('dropdown-open');
  }

  function hideHistory() {
    dropdownOpen = false;
    ask = null;
    dropdown?.classList.remove('visible');
    form?.classList.remove('dropdown-open');
  }

  function showAsk(next) {
    ask = next;
    dropdownOpen = true;
    dropdown.classList.add('visible');
    form.classList.add('dropdown-open');
  }

  function sendAskAsNote() {
    const text = ask.text;
    hideHistory();
    sendNote(text);
  }

  function onFocus() {
    focused = true;
    showHistory();
    suggest?.sync();
  }

  function onBlur() {
    focused = false;
    setTimeout(() => {
      if (!dropdown.contains(document.activeElement)) hideHistory();
    }, 200);
  }

  function onSubmit(e) {
    e.preventDefault();
    if (results) submitComposer(input, suggest, { ask: showAsk });
    else submitSearch(input, suggest);
  }

  // Typing on after the question dismisses it; the answer is whatever is submitted next.
  function onInput() {
    if (ask) { ask = null; hideHistory(); }
  }

  function choose(domain) {
    value = domain;
    hideHistory();
    performSearch(domain);
  }

  $effect(() => {
    // Re-rendered whenever history changes (unless suggestions hold the list).
    renderHistoryRows(list, app.history);
  });

  onMount(() => {
    suggest = attachBrandSuggestions({
      input, dropdown, list,
      history: () => app.history.map(item => item.domain),
      showHistory: () => { renderHistoryRows(list, app.history); refreshSearchHistory(); },
      favicon: getFaviconUrl
    });
    typing = createTypingAnimation(placeholderEl, input);
    if (!results) typing?.start();
    // Results placeholder starts hidden (results page not visible); it starts on blur if empty.

    // Escape puts the dropdown away, whatever it holds, and leaves the text alone.
    const onKeydown = (e) => { if (e.key === 'Escape') hideHistory(); };
    document.addEventListener('keydown', onKeydown);

    const unregister = registerOmnibar(variant, {
      setValue(next) { value = next; },
      getValue() { return input.value; },
      focus() { input.focus(); },
      blur() { input.blur(); },
      hideHistory,
      hidePlaceholder() { typing?.hide(); }
    });
    return () => {
      document.removeEventListener('keydown', onKeydown);
      unregister();
      typing?.destroy();
    };
  });
</script>

<form class="search-form" id={ids.form} class:dropdown-open={dropdownOpen} bind:this={form} onsubmit={onSubmit}>
  <div class="search-input-wrapper" class:showing-display={showingDisplay}>
    <span class="typing-placeholder" class:typing-placeholder-results={results} class:hidden={results} id={ids.placeholder} bind:this={placeholderEl} aria-hidden="true"></span>
    <input
      type="text"
      class="search-input"
      class:focused
      id={ids.input}
      placeholder={results ? 'Want different picks? Just ask' : 'Brand name or website'}
      autocomplete="off"
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
      data-placeholder-focus={results ? 'Ask for changes, or search another brand' : 'Brand name or website'}
      bind:this={input}
      bind:value
      onfocus={onFocus}
      onblur={onBlur}
      oninput={onInput}
    >
    <div class="submit-button-wrapper">
      <input type="file" class="photo-input" id="photoInput-{variant}" accept="image/*" hidden>
      <button type="button" class="photo-button" id="photoButton-{variant}" aria-label="Search by photo of a product" title="Search by photo">
        <Icon name="camera-1" size={20} />
      </button>
      <!-- Normal search button (visible when not loading) -->
      <button type="submit" class="search-button" id={ids.button}>
        <Icon name="arrow-up" class="search-icon" />
      </button>
      {#if results}
        <!-- Stop button (visible during loading) -->
        <button type="button" class="stop-button search-button--stop" id="stopSearchButton" aria-label="Stop" onclick={stopActivity}>
          <Icon name="spinner" class="spinner-ring" />
          <Icon name="stop-filled" class="stop-icon" />
        </button>
      {/if}
    </div>
  </div>
  <!-- A tap inside the dropdown must not blur the input: on a phone the blur dismisses the
       keyboard, the viewport reflows under the finger, and the tap's click lands on whatever
       moved there. Refusing the mousedown keeps the focus where it was. -->
  <div class="search-history-dropdown" class:visible={dropdownOpen} class:is-asking={!!ask} id={ids.dropdown} bind:this={dropdown} onmousedown={(e) => e.preventDefault()}>
    {#if ask}
      <div class="composer-ask" role="group" aria-label="Search or send as a note">
        <span class="composer-ask-text">Search {ask.domain}, or send this as a note?</span>
        <div class="composer-ask-chips">
          <button type="button" class="btn btn--md btn--secondary composer-ask-chip" onclick={() => choose(ask.domain)}>Search {ask.domain}</button>
          <button type="button" class="btn btn--md btn--ai composer-ask-chip" onclick={sendAskAsNote}>Send as a note</button>
        </div>
      </div>
    {/if}
    <div class="history-header">
      <span>Search history</span>
    </div>
    <ul class="history-list" id={ids.list} bind:this={list} use:historyList={{ onChoose: choose, onRemove: removeFromSearchHistory }}></ul>
  </div>
</form>
