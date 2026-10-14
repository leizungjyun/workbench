import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

class AlignmentSpacer extends WidgetType {
  constructor(height) { super(); this.height = height; }
  eq(other) { return Math.abs(this.height - other.height) < 0.5; }
  get estimatedHeight() { return this.height; }
  toDOM() { const element = document.createElement('div'); element.className = 'alignment-spacer'; element.style.height = `${this.height}px`; element.setAttribute('aria-hidden', 'true'); return element; }
  ignoreEvent() { return true; }
}
const setPadding = StateEffect.define();
const paddingField = StateField.define({
  create: () => ({ decorations: Decoration.none, padding: new Map() }),
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setPadding)) {
      const padding = effect.value;
      return { padding, decorations: Decoration.set([...padding].sort((a, b) => a[0] - b[0]).map(([position, height]) => Decoration.widget({ widget: new AlignmentSpacer(height), block: true, side: 1 }).range(position))) };
    }
    // Keep the existing geometry during typing. Move spacers with the text;
    // replace their measurements only after the preview has caught up.
    if (transaction.docChanged) {
      const decorations = value.decorations.map(transaction.changes), padding = new Map();
      decorations.between(0, transaction.newDoc.length, (position, _to, decoration) => {
        padding.set(position, (padding.get(position) || 0) + decoration.spec.widget.height);
      });
      return { decorations, padding };
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
});
export const alignmentExtension = paddingField;

export function synchronizeScroll(view, preview, enabled, previewCurrent = () => true) {
  const editor = view.scrollDOM, expected = new Map();
  let frame = 0, pending = null, leader = editor;
  let geometry = null;
  const sourceHeights = new Map();
  const range = element => Math.max(0, element.scrollHeight - element.clientHeight);
  const blocks = () => [...preview.querySelectorAll(':scope > [data-source-from]')];
  const sourceTop = position => view.lineBlockAt(position).top + view.documentTop - editor.getBoundingClientRect().top + editor.scrollTop;
  const previewTop = element => element.getBoundingClientRect().top - preview.getBoundingClientRect().top + preview.scrollTop;

  function sync(from) {
    if (!enabled() || !previewCurrent()) return;
    const to = from === editor ? preview : editor;
    if (!range(from) || !range(to)) return;
    const points = [[0, 0], ...blocks().map(block => [sourceTop(Number(block.dataset.sourceFrom)), previewTop(block)]), [range(editor), range(preview)]];
    const axis = from === editor ? 0 : 1;
    const ordered = points.filter(p => p[0] >= 0 && p[1] >= 0 && p[0] <= range(editor) && p[1] <= range(preview)).sort((a, b) => a[axis] - b[axis]);
    const position = Math.max(0, Math.min(range(from), from.scrollTop));
    let target = position <= 0 ? 0 : range(to);
    if (position > 0 && position < range(from) - 1) {
      for (let i = 1; i < ordered.length; i++) {
        const a = ordered[i - 1], b = ordered[i];
        if (b[axis] < position || b[axis] <= a[axis]) continue;
        const progress = (position - a[axis]) / (b[axis] - a[axis]);
        target = a[1 - axis] + progress * (b[1 - axis] - a[1 - axis]);
        break;
      }
    }
    leader = from;
    if (Math.abs(to.scrollTop - target) < 0.5) return;
    const previous = to.scrollTop;
    to.scrollTop = target;
    expected.set(to, to.scrollTop);
    // A synchronized editor scroll exposes new lines whose actual heights may
    // differ from their estimates. Measure that viewport before settling.
    if (Math.abs(to.scrollTop - previous) >= 0.5) schedule(from);
  }

  function schedule(source = leader) {
    if (enabled() && !previewCurrent()) return;
    pending = source;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      leader = pending || leader;
      pending = null;
      const measuredDoc = view.state.doc;
      view.requestMeasure({
        key: preview,
        read() {
          if (!enabled()) return null;
          if (!previewCurrent()) return undefined;
          const nextGeometry = [view.state.doc, editor.clientWidth, view.defaultLineHeight, view.defaultCharacterWidth];
          if (!geometry || nextGeometry.some((value, i) => value !== geometry[i])) {
            geometry = nextGeometry;
            sourceHeights.clear();
          }
          const applied = view.state.field(paddingField).padding;
          return blocks().map(block => {
            const start = Number(block.dataset.sourceFrom), end = Number(block.dataset.sourceTo);
            const first = view.lineBlockAt(start), last = view.lineBlockAt(end === view.state.doc.length ? end : Math.max(start, end - 1));
            const lastLine = view.state.doc.lineAt(end === view.state.doc.length ? end : Math.max(start, end - 1)).to;
            let sourceHeight = last.bottom - first.top;
            for (const [position, height] of applied) if (position >= start && position <= lastLine) sourceHeight -= height;
            // Offscreen wrapped lines use CodeMirror's height estimates. Adding
            // spacers changes that height map, so repeatedly measuring every
            // estimate can oscillate forever and prevent scroll synchronization.
            // Keep each estimate until the entire source block is rendered and
            // can be measured accurately; invalidate on edits or text geometry.
            const visible = start >= view.viewport.from && lastLine <= view.viewport.to;
            if (visible || !sourceHeights.has(block)) sourceHeights.set(block, sourceHeight);
            else sourceHeight = sourceHeights.get(block);
            const renderedHeight = block.firstElementChild.getBoundingClientRect().height;
            const height = Math.max(sourceHeight, renderedHeight);
            return { block, lastLine, height, padding: Math.max(0, height - sourceHeight) };
          });
        },
        write(rows) { queueMicrotask(() => {
          if (rows === undefined || (enabled() && !previewCurrent())) return;
          if (view.state.doc !== measuredDoc) { schedule(); return; }
          // Input may arrive while CodeMirror is measuring. Preserve the newest
          // scrolling pane rather than replaying an older alignment request.
          const from = pending || leader;
          const old = view.state.field(paddingField).padding;
          const next = new Map();
          if (rows) for (const row of rows) {
            row.block.style.minHeight = `${row.height}px`;
            if (row.padding > 0.5) next.set(row.lastLine, Math.round(row.padding * 100) / 100);
          }
          else blocks().forEach(block => block.style.removeProperty('min-height'));
          const changed = old.size !== next.size || [...next].some(([p, h]) => Math.abs((old.get(p) || 0) - h) > 0.5);
          if (changed) view.dispatch({ effects: [setPadding.of(next), view.scrollSnapshot()] });
          // CodeMirror measures the new line padding on its next layout pass.
          if (changed) schedule(from);
          else sync(from);
        }); },
      });
    });
  }

  for (const element of [editor, preview]) {
    element.addEventListener('scroll', () => {
      if (!enabled() || !previewCurrent()) return;
      if (expected.has(element) && Math.abs(element.scrollTop - expected.get(element)) < 1) return;
      expected.delete(element);
      leader = element;
      schedule(element);
    }, { passive: true });
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) element.addEventListener(event, () => {
      expected.delete(element); leader = element; if (pending) pending = element;
    }, { passive: true });
  }
  const resize = new ResizeObserver(() => schedule());
  resize.observe(editor); resize.observe(preview);
  preview.addEventListener('load', () => schedule(), true);
  document.fonts.ready.then(() => schedule());
  return {
    refresh: schedule,
    reset() {
      cancelAnimationFrame(frame); frame = 0; pending = null; leader = editor; expected.clear();
      preview.scrollTop = 0; expected.set(preview, 0);
      geometry = null; sourceHeights.clear();
    },
  };
}
