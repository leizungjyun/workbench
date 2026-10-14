import { Prec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { insertNewlineContinueMarkupCommand, deleteMarkupBackward } from '@codemirror/lang-markdown';

const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });
// Retain CodeMirror's nesting, task markers, renumbering, and list exit logic,
// but never create a second newline just because an existing list is loose.
export const compactMarkdownKeys = Prec.high(keymap.of([
  { key: 'Enter', run(view) {
    return continueMarkup({ state: view.state, dispatch(transaction) {
      const corrections = [];
      transaction.changes.iterChanges((_from, _to, start, _end, inserted) => {
        const match = /^(\r?\n)([\t >]*\r?\n)(?=[\t >]*(?:[-+*]|\d+[.)])\s)/.exec(inserted.toString());
        if (match) corrections.push({ from: start + match[1].length, to: start + match[1].length + match[2].length });
      });
      if (!corrections.length) return view.dispatch(transaction);
      const trimmed = transaction.state.changes(corrections);
      view.dispatch(view.state.update({ changes: transaction.changes.compose(trimmed), selection: transaction.newSelection.map(trimmed), scrollIntoView: true, userEvent: 'input' }));
    } });
  } },
  { key: 'Backspace', run: deleteMarkupBackward },
]));
