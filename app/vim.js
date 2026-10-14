import { ViewPlugin } from '@codemirror/view';
import { getCM, Vim, vim } from '@replit/codemirror-vim';

// CodeMirror suppresses its entire key-handler chain during composition, so
// even a highest-priority keymap cannot receive Escape then. Capture just Vim's
// exit keys at the editor DOM boundary; leave other keys and dialogs alone.
export function notebookVim() {
  return [vim({ status: true }), ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.keydown = event => this.exitInsert(event);
      view.dom.addEventListener('keydown', this.keydown, true);
    }
    exitInsert(event) {
      const view = this.view;
      if (!view.contentDOM.contains(event.target)) return;
      const escape = ['Escape', 'Esc', '\u001b'].includes(event.key) || event.code === 'Escape';
      const bracket = event.ctrlKey && (event.key === '[' || event.code === 'BracketLeft');
      if ((!escape && !bracket) || event.altKey || event.metaKey) return;
      const cm = getCM(view);
      if (!cm?.state.vim?.insertMode) return;
      event.preventDefault();
      event.stopPropagation();
      // Finish the browser's input session before moving Vim's cursor, keeping
      // the composed text instead of replacing or recreating the editor.
      if (view.compositionStarted) { view.contentDOM.blur(); view.focus(); }
      cm.operation(() => Vim.handleKey(cm, '<Esc>', 'user'));
    }
    destroy() { this.view.dom.removeEventListener('keydown', this.keydown, true); }
  })];
}
