<script>
  /**
   * A generated pitch: channel and contacts, the drafted messages, and brand intel, each in a
   * collapsible section. Mounted fresh per result (the modal keys it), so collapse and "Copied!"
   * state start over with every generation.
   */
  import Icon from './Icon.svelte';
  import { getFaviconUrl, getInitials } from '$lib/client/util.js';

  let { data, searchedDomain = '', partnerDomain = '' } = $props();

  const channel = $derived(data?.channel_recommendation || null);
  const contacts = $derived(channel?.suggested_contacts || []);
  const messages = $derived(data?.messages || null);
  const intelligence = $derived(data?.brand_intelligence || null);
  const messageCards = $derived(!messages ? [] : [
    messages.primary && { msg: messages.primary, id: 'msg-primary' },
    messages.secondary && { msg: messages.secondary, id: 'msg-secondary' },
    messages.follow_up && { msg: messages.follow_up, id: 'msg-followup' }
  ].filter(Boolean));
  const brandCards = $derived(!intelligence ? [] : [
    { brand: intelligence.brand_1, domain: searchedDomain },
    { brand: intelligence.brand_2, domain: partnerDomain }
  ].filter(card => card.brand));

  let collapsed = $state({});
  let copied = $state({});

  function toggle(section) {
    collapsed[section] = !collapsed[section];
  }

  function onHeaderKeydown(event, section) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle(section);
    }
  }

  async function copyMessage(id) {
    const el = document.getElementById(id);
    if (!el) return;
    try {
      await navigator.clipboard.writeText(el.textContent);
    } catch {
      // Fallback for older browsers
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('copy');
      sel.removeAllRanges();
    }
    copied[id] = true;
    setTimeout(() => { copied[id] = false; }, 2000);
  }

  function hideImage(event) {
    event.currentTarget.style.display = 'none';
  }
</script>

<div class="pitch-results">
  {#if channel}
    <div class="pitch-section" data-section="channel" class:collapsed={collapsed.channel}>
      <div class="pitch-section-header" role="button" tabindex="0"
           onclick={() => toggle('channel')} onkeydown={(e) => onHeaderKeydown(e, 'channel')}>
        <h3 class="pitch-section-title">Channel &amp; Contacts</h3>
        <Icon name="chevron-bottom" class="pitch-section-chevron" />
      </div>
      <div class="pitch-section-content">
        <div class="pitch-channel-card">
          <p class="pitch-channel-label">Recommended Channel</p>
          <p class="pitch-channel-name">{channel.channel_display_name || ''}</p>
          <p class="pitch-channel-reasoning">{channel.reasoning || ''}</p>
        </div>
        {#if contacts.length > 0}
          <p class="pitch-contacts-heading">Suggested Contacts</p>
          <div class="pitch-contacts-list">
            {#each contacts as c}
              <div class="pitch-contact-chip">
                <div class="pitch-contact-avatar">{getInitials(c.name)}</div>
                <div class="pitch-contact-info">
                  <span class="pitch-contact-name">{c.name || ''}</span>
                  <span class="pitch-contact-title">{c.title || ''}</span>
                </div>
                {#if c.linkedin_url || c.email}
                  <div class="pitch-contact-actions">
                    {#if c.linkedin_url}
                      <a href={c.linkedin_url} target="_blank" rel="noopener noreferrer" class="pitch-contact-icon-btn" title="LinkedIn"><Icon name="linkedin" size={18} /></a>
                    {/if}
                    {#if c.email}
                      <a href="mailto:{c.email}" class="pitch-contact-icon-btn" title={c.email}><Icon name="email-1" size={18} /></a>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
          <div class="pitch-contact-details">
            {#each contacts as c}
              <p class="pitch-contact-why"><strong>Tier {c.tier} — {c.name || ''}:</strong> {c.why || ''}</p>
            {/each}
          </div>
        {/if}
        {#if channel.backup_display_name}
          <p class="pitch-backup-channel"><strong>Backup channel (Day 10–14):</strong> {channel.backup_display_name}</p>
        {/if}
      </div>
    </div>
  {/if}

  {#if messages}
    <div class="pitch-section" data-section="messages" class:collapsed={collapsed.messages}>
      <div class="pitch-section-header" role="button" tabindex="0"
           onclick={() => toggle('messages')} onkeydown={(e) => onHeaderKeydown(e, 'messages')}>
        <h3 class="pitch-section-title">Messages</h3>
        <Icon name="chevron-bottom" class="pitch-section-chevron" />
      </div>
      <div class="pitch-section-content">
        <div class="pitch-messages">
          {#each messageCards as { msg, id } (id)}
            <div class="pitch-message-card">
              <div class="pitch-message-header">
                <span class="pitch-message-channel">{msg.channel_label || ''}</span>
                <button type="button" class="pitch-copy-btn" class:copied={copied[id]} data-copy-target={id} onclick={() => copyMessage(id)}>
                  {#if copied[id]}Copied!{:else}<Icon name="copy-2-layers-pages" /> Copy{/if}
                </button>
              </div>
              {#if msg.subject != null && msg.subject !== ''}
                <p class="pitch-message-subject"><strong>Subject:</strong> {msg.subject}</p>
              {/if}
              <div class="pitch-message-body" {id}>{msg.body || ''}</div>
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}

  {#if intelligence}
    <div class="pitch-section" data-section="intelligence" class:collapsed={collapsed.intelligence}>
      <div class="pitch-section-header" role="button" tabindex="0"
           onclick={() => toggle('intelligence')} onkeydown={(e) => onHeaderKeydown(e, 'intelligence')}>
        <h3 class="pitch-section-title">Brand Intel</h3>
        <Icon name="chevron-bottom" class="pitch-section-chevron" />
      </div>
      <div class="pitch-section-content">
        <div class="pitch-brand-grid">
          {#each brandCards as { brand, domain }}
            <div class="pitch-brand-card">
              <div class="pitch-brand-card-header">
                {#if domain}
                  <img class="pitch-brand-favicon" src={getFaviconUrl(domain)} alt="" onerror={hideImage} />
                {/if}
                <h4 class="pitch-brand-name">{brand.name || ''}</h4>
              </div>
              <p class="pitch-brand-summary">{brand.summary || ''}</p>
              {#if brand.noteworthy?.length}
                <div>
                  <p class="pitch-noteworthy-label">Noteworthy</p>
                  <ul class="pitch-noteworthy-list">
                    {#each brand.noteworthy as n}<li>{n}</li>{/each}
                  </ul>
                </div>
              {/if}
              {#if brand.conversation_starters?.length}
                <div class="pitch-starters-box">
                  <p class="pitch-starters-label">Conversation Starters</p>
                  <ul class="pitch-starters-list">
                    {#each brand.conversation_starters as s}<li>{s}</li>{/each}
                  </ul>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/if}
</div>
