import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';

export const indentationKeys = keymap.of([indentWithTab]);
