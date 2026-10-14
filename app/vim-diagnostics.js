import { EditorView } from '@codemirror/view';
import { getCM } from '@replit/codemirror-vim';

// Opt-in troubleshooting only. Record exit shortcuts and focus, never note text
// or ordinary typing. This distinguishes editor handling from intercepted keys.
if (new URLSearchParams(location.search).has('vim-debug')) {
  const panel = document.createElement('aside');
  panel.setAttribute('aria-label', 'Vim shortcut diagnostics');
  panel.style.cssText = 'position:fixed;bottom:72px;right:8px;z-index:10000;background:#fff;border:1px solid #789568;border-radius:8px;padding:12px;max-width:min(440px,95vw);box-shadow:0 3px 18px #0002;font:12px/1.5 monospace;';
  const label = document.createElement('strong'); label.textContent = 'Vim shortcut diagnostics';
  const instructions = document.createElement('p'); instructions.textContent = 'Enter Insert mode, press Esc and Ctrl+[, then copy these details.';
  const output = document.createElement('textarea'); output.readOnly = true; output.rows = 8;
  output.setAttribute('aria-label', 'Vim diagnostic details'); output.style.cssText = 'display:block;width:100%;font:11px/1.5 monospace;';
  const copy = document.createElement('button'); copy.textContent = 'Copy details';
  copy.onclick = async () => { try { await navigator.clipboard.writeText(output.value); copy.textContent = 'Copied'; } catch { output.select(); } };
  panel.append(label, instructions, output, copy); document.body.append(panel);
  const events = [];
  let lastEditor;
  function state() {
    const active = document.activeElement;
    const view = active?.closest('.cm-editor') ? EditorView.findFromDOM(active) : lastEditor;
    if (view) lastEditor = view;
    const vim = view && getCM(view)?.state.vim;
    return { focus: active?.matches('.cm-content') ? 'editor' : active?.tagName,
      vimEnabled: document.querySelector('#vim-toggle')?.getAttribute('aria-pressed'),
      mode: vim?.insertMode ? 'INSERT' : vim?.mode || 'unavailable', composing: view?.compositionStarted };
  }
  function update() { output.value = JSON.stringify({ build: document.querySelector('script[type=module]')?.getAttribute('src'), current: state(), events }, null, 2); }
  window.addEventListener('keydown', event => {
    if (!(event.key === 'Escape' || event.code === 'Escape' || (event.ctrlKey && (event.key === '[' || event.code === 'BracketLeft')))) return;
    const entry = { key: event.key, code: event.code, ctrl: event.ctrlKey, composing: event.isComposing, before: state() };
    events.push(entry); if (events.length > 6) events.shift();
    setTimeout(() => { entry.prevented = event.defaultPrevented; entry.after = state(); update(); }, 0);
  }, true);
  document.addEventListener('focusin', update);
  setInterval(update, 1000);
  update();
}
