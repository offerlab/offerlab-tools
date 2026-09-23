<script>
  /**
   * The dialog that adds a brand by name or web address. Lives on body, so its listeners are
   * attached here rather than delegated from the app root.
   */
  import { picker, view } from '$lib/client/picker-state.svelte.js';
  import { submitUrl, hideUrlDialog } from '$lib/client/picker-add.js';
  import { portal } from '$lib/client/actions/portal.js';
  import Icon from './Icon.svelte';

  function dialogEvents(form) {
    const onSubmit = (e) => {
      e.preventDefault();
      submitUrl(form.querySelector('input').value.trim());
    };
    const onClick = (e) => {
      if (e.target === form || e.target.closest('[data-action="close-dialog"]')) hideUrlDialog();
    };
    form.addEventListener('submit', onSubmit);
    form.addEventListener('click', onClick);
    view.focusUrlInput = () => {
      const input = form.querySelector('input');
      input.value = '';
      input.focus();
    };
    return {
      destroy() {
        form.removeEventListener('submit', onSubmit);
        form.removeEventListener('click', onClick);
        view.focusUrlInput = () => {};
      }
    };
  }
</script>

<form class="dialog-backdrop picker-url-dialog" id="pickerUrlDialog" class:hidden={!picker.dialog.open} novalidate use:portal use:dialogEvents>
  <div class="dialog picker-url-modal" role="dialog" aria-modal="true" aria-labelledby="pickerUrlHeading">
    <div class="dialog-header">
      <h2 class="dialog-heading" id="pickerUrlHeading">Add brand from URL</h2>
      <button type="button" class="dialog-close" data-action="close-dialog" aria-label="Close"><Icon name="cross-large" size={16} /></button>
    </div>
    <div class="dialog-body">
      <div class="ai-input ai-input--compact">
        <span class="ai-input__glow ai-input__glow--1" aria-hidden="true"></span>
        <span class="ai-input__glow ai-input__glow--2" aria-hidden="true"></span>
        <div class="ai-input__field floating-input">
          <input type="text" name="url" id="pickerUrlInput" class="floating-input-field" placeholder="glossier.com" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
          <label class="floating-label" for="pickerUrlInput">Brand name or website</label>
        </div>
      </div>
      <p class="picker-url-error" role="alert">{picker.dialog.error}</p>
    </div>
    <div class="dialog-actions">
      <button type="button" class="btn btn--lg btn--overlay" data-action="close-dialog">Cancel</button>
      <button type="submit" class="btn btn--lg btn--primary" disabled={picker.dialog.busy}>{picker.dialog.label}</button>
    </div>
  </div>
</form>
