import { Extension, InputRule } from '@tiptap/core';

// StarterKit handles headings, emphasis and lists. Add Markdown link syntax to
// the same editor so a completed link becomes editable, rendered text in place.
export const StudentMarkdown = Extension.create({
  name: 'studentMarkdown',
  addInputRules() {
    return [new InputRule({
      find: /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)$/,
      handler: ({ state, range, match }) => {
        state.tr.replaceWith(range.from, range.to, state.schema.text(match[1], [state.schema.marks.link.create({ href: match[2] })]));
        state.tr.removeStoredMark(state.schema.marks.link);
      }
    })];
  }
});
