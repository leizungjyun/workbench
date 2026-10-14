// Locks arbitrate editing; announcements only provide presence and focus hints.
export class NotebookTabs {
  constructor(changed) {
    this.id = crypto.randomUUID(); this.path = null; this.windows = new Map();
    try { this.windows = window.opener?.fieldnotesTabs?.windows || this.windows; } catch { /* unrelated opener */ }
    window.fieldnotesTabs = this;
    this.peers = new Map(); this.changed = changed;
    this.channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('fieldnotes-tabs') : null;
    this.channel?.addEventListener('message', ({ data }) => {
      if (data.type === 'query') this.announce();
      if (data.type === 'presence') { const previous = this.peers.get(data.id)?.path; if (data.path) this.peers.set(data.id, { path: data.path, seen: Date.now() }); else this.peers.delete(data.id); if (previous !== (data.path || undefined)) this.changed(); }
      if (data.type === 'focus' && data.path === this.path) window.focus();
    });
    this.channel?.postMessage({ type: 'query' });
  }
  refreshPresence() {
    let expired = false;
    for (const [id, peer] of this.peers) if (Date.now() - peer.seen >= 10000) { this.peers.delete(id); expired = true; }
    if (expired) this.changed();
    this.channel?.postMessage({ type: 'query' });
  }
  announce() { this.channel?.postMessage({ type: 'presence', id: this.id, path: this.path }); }
  isOpen(path) { return [...this.peers.values()].some(peer => peer.path === path && Date.now() - peer.seen < 10000); }
  targetName(path) { return `fieldnotes-${encodeURIComponent(location.origin)}-${encodeURIComponent(path)}`; }
  findWindow(path) {
    const target = this.windows.get(path);
    if (!target || target.closed) { this.windows.delete(path); return null; }
    try {
      if (target.location.href === 'about:blank') return target;
      if (target.location.origin !== location.origin || new URLSearchParams(target.location.search).get('path') !== path) { this.windows.delete(path); return null; }
    } catch { this.windows.delete(path); return null; }
    return target;
  }
  focus(path) {
    let target = this.path === path ? window : this.findWindow(path);
    if (!target) {
      // Named windows can reconnect related tabs after a reload. Never navigate
      // the existing editor: it might contain an unsaved draft or running kernel.
      target = window.open('', this.targetName(path));
      if (!target) return false;
      try {
        if (target.location.href === 'about:blank') { target.close(); return false; }
        if (target.location.origin !== location.origin || target.fieldnotesTabs?.path !== path) return false;
      } catch { return false; }
      this.windows.set(path, target);
    }
    target.focus(); return true;
  }
  open(ref) {
    if ((ref.scope || 'active') !== 'active') {
      return window.open(notebookUrl(ref), '_blank') ? 'opened' : 'blocked';
    }
    const path = ref.path;
    if (this.path === path || this.findWindow(path)) return this.focus(path) ? 'focused' : 'blocked';
    if (this.isOpen(path)) return this.focus(path) ? 'focused' : 'unreachable';
    const target = window.open('', this.targetName(path));
    if (!target) return 'blocked';
    try {
      if (target.location.href === 'about:blank') target.location.href = new URL(notebookUrl(ref), location.href).href;
      this.windows.set(path, target); target.focus(); return 'opened';
    } catch { return 'unreachable'; }
  }
  async acquire(path) {
    if (this.path === path) return true;
    if (!navigator.locks) return false; // Never allow an uncoordinated second writer.
    return new Promise((resolve, reject) => {
      navigator.locks.request(`fieldnotes:${path}`, { ifAvailable: true }, async lock => {
        if (!lock) { this.channel?.postMessage({ type: 'focus', path }); resolve(false); return; }
        this.release(); this.path = path; window.name = this.targetName(path); this.windows.set(path, window);
        const held = new Promise(done => { this.unlock = done; });
        this.announce(); resolve(true); await held;
      }).catch(reject);
    });
  }
  release() { if (this.windows.get(this.path) === window) this.windows.delete(this.path); if (this.path) window.name = ''; this.unlock?.(); this.unlock = null; this.path = null; this.announce(); }
}
export function notebookUrl(ref) {
  return `?${new URLSearchParams({ scope: ref.scope || 'active', path: ref.path || '', ...(ref.id ? { id: ref.id } : {}) })}`;
}
export function comparisonText(source, path) {
  if (!/\.ipynb$/i.test(path)) return source;
  const note = JSON.parse(source);
  return note.cells.map((cell, i) => `Cell ${i + 1} · ${cell.cell_type}\n${Array.isArray(cell.source) ? cell.source.join('') : cell.source}\n${cell.outputs?.length ? 'Outputs:\n' + JSON.stringify(cell.outputs, null, 2) : ''}`).join('\n\n');
}
