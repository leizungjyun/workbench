const inside = (parent, child) => child === parent || child.startsWith(parent + '/');
const parentOf = value => value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : '';
const nameOf = value => value.split('/').at(-1).replace(/\.(md|ipynb)$/i, '');
const el = (tag, value, className) => { const node = document.createElement(tag); if (value !== undefined) node.textContent = value; if (className) node.className = className; return node; };

export class NotebookSidebar {
  constructor({ icon, open, action, expanded, remember, url, isOpen, follow }) { Object.assign(this, { icon, open, action, expanded, remember, url, isOpen, follow }); }
  actionButtons(ref) {
    const group = el('span', undefined, 'row-actions');
    group.setAttribute('role', 'group'); group.setAttribute('aria-label', `Actions for ${nameOf(ref.displayPath || ref.path)}`);
    const active = ref.scope === 'active', isFolder = ref.kind === 'folder';
    const pinned = active && this.tree.pins.includes(ref.path);
    const actions = active ? isFolder ? [['New Notebook', 'note', 'filePlus'], ['New Subfolder', 'folder', 'folderPlus'], ['Rename/Move', 'move', 'edit'], ['Archive', 'archive', 'archive'], ['Move to Trash', 'trash', 'trash']] : [[pinned ? 'Unpin' : 'Pin', 'pin', 'pin'], ['Rename/Move', 'move', 'edit'], ['Archive', 'archive', 'archive'], ['Move to Trash', 'trash', 'trash']] : ref.scope === 'archive' ? [['Unarchive', 'restore', 'unarchive'], ['Move to Trash', 'trash', 'trash']] : [['Restore', 'restore', 'restore'], ['Delete Permanently', 'purge', 'purge']];
    for (const [label, action, glyph] of actions) {
      const button = el('button', undefined, action === 'purge' || action === 'trash' ? 'action-danger' : '');
      button.type = 'button'; button.title = `${label} · ${ref.displayPath || ref.path}`; button.setAttribute('aria-label', label);
      if (action === 'pin') { button.setAttribute('aria-pressed', String(pinned)); button.classList.toggle('is-pinned', pinned); }
      button.append(this.icon(glyph));
      button.onclick = event => { event.preventDefault(); event.stopPropagation(); Promise.resolve(this.action(action, ref)).catch(() => {}); };
      group.append(button);
    }
    group.onkeydown = event => {
      const buttons = [...group.querySelectorAll('button')], index = buttons.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); (group.parentElement.querySelector('.note-link') || group.parentElement).focus(); }
      else if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length].focus();
      }
    };
    return group;
  }
  note(ref) {
    const row = el('div', undefined, 'sidebar-row'); row.dataset.scope = ref.scope; row.dataset.path = ref.displayPath || ref.path;
    const button = el('a', undefined, 'note-link'); button.href = this.url(ref); button.setAttribute('role', 'button'); button.title = ref.displayPath || ref.path; button.setAttribute('aria-label', nameOf(ref.displayPath || ref.path));
    const selected = this.current && (this.current.scope || 'active') === ref.scope && (ref.scope === 'active' ? this.current.path === ref.path : this.current.id === ref.id && this.current.storedPath === ref.path);
    button.classList.toggle('selected', !!selected); button.append(this.icon(/\.ipynb$/i.test(ref.displayPath || ref.path) ? 'book' : 'file'), el('span', nameOf(ref.displayPath || ref.path)));
    if (ref.scope === 'active' && this.isOpen(ref.path)) { button.append(el('small', 'Open in another tab', 'tab-status')); }
    button.onkeydown = event => { if (event.key === ' ') { event.preventDefault(); button.click(); } };
    button.onclick = event => this.follow(event, ref); button.onauxclick = event => this.follow(event, ref); row.append(button, this.actionButtons(ref)); return row;
  }
  folder(ref, children, count, metadata = '') {
    const details = el('details', undefined, 'tree-folder'); const key = ref.scope === 'active' ? ref.path : `${ref.scope}:${ref.id}:${ref.path}`;
    details.open = this.expanded.has(key) || (ref.scope === 'active' && !this.current?.readOnly && this.current?.path.startsWith(ref.path + '/'));
    const summary = el('summary'); summary.append(this.icon('chevron'), this.icon('folder'), el('span', nameOf(ref.displayPath || ref.path)), el('small', String(count)), this.actionButtons(ref));
    summary.title = (ref.displayPath || ref.path) + (metadata ? ` · ${metadata}` : '');
    const body = el('div', undefined, 'tree-children'); body.append(children); details.append(summary, body);
    if (metadata) body.prepend(el('p', metadata, 'stored-detail'));
    details.addEventListener('toggle', () => { if (details.open) this.expanded.add(key); else this.expanded.delete(key); this.remember(); });
    return details;
  }
  draw(tree, current) {
    this.tree = tree; this.current = current;
    const active = path => ({ scope: 'active', path, displayPath: path, kind: 'note' });
    for (const [id, paths, empty] of [['pinned', tree.pins, 'Pin a notebook to keep it close.'], ['recent', tree.recent, 'Your recently opened notes appear here.']]) {
      document.getElementById(id).replaceChildren(...(paths.length ? paths.map(p => this.note(active(p))) : [el('p', empty, 'sidebar-empty')]));
    }
    const build = (parent = '') => {
      const fragment = document.createDocumentFragment();
      for (const f of tree.folders.filter(p => parentOf(p) === parent)) fragment.append(this.folder({ scope: 'active', path: f, displayPath: f, kind: 'folder' }, build(f), tree.notes.filter(n => inside(f, n.path)).length));
      for (const note of tree.notes.filter(n => parentOf(n.path) === parent)) fragment.append(this.note(active(note.path)));
      return fragment;
    };
    const main = document.getElementById('tree'); main.replaceChildren(build());
    if (!tree.notes.length && !tree.folders.length) main.append(el('p', 'A fresh start. Create your first notebook.', 'sidebar-empty'));
    for (const scope of ['archive', 'trash']) {
      const entries = tree[scope] || [], container = document.getElementById(`${scope}-tree`);
      document.getElementById(`${scope}-count`).textContent = entries.length;
      container.replaceChildren();
      if (!entries.length) container.append(el('p', scope === 'archive' ? 'Archived notebooks will appear here.' : 'Trash is empty.', 'sidebar-empty'));
      for (const entry of entries) {
        const ref = path => ({ scope, id: entry.id, path, kind: path === '' ? entry.kind : entry.folders.includes(path) ? 'folder' : 'note', displayPath: entry.displayPath + (path ? '/' + path : '') });
        const metadata = `${entry.legacy ? 'Original location unknown' : entry.displayPath} · ${new Date(entry.deletedAt || entry.archivedAt).toLocaleDateString()}`;
        const buildStored = (parent = '') => {
          const fragment = document.createDocumentFragment();
          for (const f of entry.folders.filter(p => parentOf(p) === parent)) fragment.append(this.folder(ref(f), buildStored(f), entry.notes.filter(n => inside(f, n.path)).length));
          for (const note of entry.notes.filter(n => n.path && parentOf(n.path) === parent)) fragment.append(this.note(ref(note.path)));
          return fragment;
        };
        if (entry.kind === 'folder') container.append(this.folder(ref(''), buildStored(), entry.noteCount, metadata));
        else { const group = el('div', undefined, 'stored-note'); group.append(this.note(ref('')), el('p', metadata, 'stored-detail')); container.append(group); }
      }
      document.getElementById('empty-trash').disabled = !(tree.trash || []).length;
    }
    document.getElementById('pin-count').textContent = tree.pins.length || ''; document.getElementById('note-count').textContent = tree.notes.length;
  }
}
