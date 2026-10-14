import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export class WorkspaceTerminal {
  constructor({ api, notice, restoreFocus }) {
    Object.assign(this, { api, notice, restoreFocus }); this.records = new Map(); this.visible = false; this.height = 240;
    this.panel = document.getElementById('terminal-panel'); this.host = document.getElementById('terminal-host'); this.status = document.getElementById('terminal-status'); this.toggleButton = document.getElementById('toggle-terminal');
    this.toggleButton.onclick = () => this.toggle(); document.getElementById('hide-terminal').onclick = () => this.hide();
    document.getElementById('close-terminal').onclick = () => this.close(); document.getElementById('restart-terminal').onclick = () => this.show(true);
    this.resizeObserver = new ResizeObserver(() => { if (!this.panel.hidden) { this.setHeight(this.height); this.fit(); } }); this.resizeObserver.observe(document.getElementById('notebook'));
    const divider = document.getElementById('terminal-divider');
    divider.onpointerdown = event => { if (event.button !== 0) return; event.preventDefault(); divider.setPointerCapture(event.pointerId); const y = event.clientY, height = this.panel.offsetHeight; const move = e => this.setHeight(height + y - e.clientY); const end = () => { divider.removeEventListener('pointermove', move); divider.removeEventListener('pointerup', end); divider.removeEventListener('pointercancel', end); }; divider.addEventListener('pointermove', move); divider.addEventListener('pointerup', end); divider.addEventListener('pointercancel', end); };
    divider.onkeydown = event => { if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); this.setHeight(this.height + (event.key === 'ArrowUp' ? 24 : -24)); } };
    window.addEventListener('pagehide', () => { for (const record of this.records.values()) record.ws?.close(); });
  }
  setNote(note, active = true) {
    this.note = active ? note : null; this.toggleButton.disabled = !this.note || this.note.readOnly;
    if (!this.note || this.note.readOnly) { this.panel.hidden = true; this.toggleButton.setAttribute('aria-expanded', 'false'); return; }
    if (this.visible) this.show(false, false);
  }
  setHeight(height) { const workspace = document.getElementById('notebook'); const available = workspace.clientHeight - workspace.querySelector('.note-heading').offsetHeight - workspace.querySelector('.note-footer').offsetHeight - 120; this.height = Math.max(100, Math.min(height, Math.max(100, available))); this.panel.style.height = `${this.height}px`; document.getElementById('terminal-divider').setAttribute('aria-valuenow', Math.round(this.height)); this.fit(); }
  fit() { const record = this.records.get(this.note?.path); if (!this.panel.hidden && record?.fit && record.element.parentElement === this.host) { record.fit.fit(); if (record.ws?.readyState === WebSocket.OPEN) record.ws.send(JSON.stringify({ type: 'resize', cols: record.terminal.cols, rows: record.terminal.rows })); } }
  toggle() { if (!this.note) { this.notice('Open a notebook first.'); return; } if (this.note.readOnly) { this.notice('Restore this notebook before opening a terminal.'); return; } if (this.visible && !this.panel.hidden) this.hide(); else this.show(); }
  hide(focus = true) { this.visible = false; this.panel.hidden = true; this.toggleButton.setAttribute('aria-expanded', 'false'); if (focus) this.restoreFocus(); }
  label(record, message) { if (this.note?.path !== record.path || this.panel.hidden) return; this.status.textContent = message; document.getElementById('restart-terminal').hidden = record.alive !== false; document.getElementById('close-terminal').disabled = !record.session; }
  async show(restart = false, focus = true) {
    const note = this.note; if (!note || note.readOnly) return;
    this.visible = true; this.panel.hidden = false; this.toggleButton.setAttribute('aria-expanded', 'true'); document.getElementById('terminal-title').textContent = note.path.replace(/\.(md|ipynb)$/i, ''); this.setHeight(this.height);
    let record = this.records.get(note.path);
    if (restart && record) { await this.dispose(record, true); record = null; }
    if (!record) {
      const element = document.createElement('div'); element.className = 'terminal-instance'; element.setAttribute('aria-label', `Terminal for ${note.path}`);
      const terminal = new Terminal({ cursorBlink: true, fontSize: 12, fontFamily: '"SFMono-Regular", Consolas, monospace', scrollback: 2000, theme: { background: '#f6f8f2', foreground: '#303a32', cursor: '#305a46', selectionBackground: '#c8d8ba', black: '#303a32', red: '#a13f36', green: '#326740', yellow: '#8a681d', blue: '#345ea1', magenta: '#80538c', cyan: '#28797d', white: '#71816a', brightBlack: '#687662', brightRed: '#b7463a', brightGreen: '#427840', brightYellow: '#96731f', brightBlue: '#436db3', brightMagenta: '#936099', brightCyan: '#318589', brightWhite: '#85917d' } });
      const fit = new FitAddon(); terminal.loadAddon(fit); record = { path: note.path, terminal, fit, element, alive: null }; this.records.set(note.path, record); this.host.replaceChildren(element); terminal.open(element);
      terminal.onData(data => { if (record.ws?.readyState === WebSocket.OPEN && record.alive) record.ws.send(JSON.stringify({ type: 'input', data })); });
    } else this.host.replaceChildren(record.element);
    this.label(record, record.alive === false ? 'Shell exited' : record.ws?.readyState === WebSocket.OPEN ? 'Connected' : 'Connecting…'); document.getElementById('terminal-cwd').textContent = record.session?.cwd || 'Starting in the notebook working directory…'; this.fit();
    try {
      if (!record.pending && (!record.ws || record.ws.readyState >= WebSocket.CLOSING)) record.pending = this.connect(record).finally(() => { record.pending = null; });
      await record.pending;
      if (this.note?.path === record.path && this.visible) { this.host.replaceChildren(record.element); document.getElementById('terminal-cwd').textContent = record.session.cwd; this.fit(); if (focus) record.terminal.focus(); }
    } catch (error) { record.alive = false; this.label(record, error.message); this.notice(error.message); }
  }
  async connect(record) {
    const { sessions } = await this.api('/api/terminals');
    record.session = sessions.find(s => s.path === record.path) || await this.api('/api/terminal', 'POST', { path: record.path, cols: Math.max(2, record.terminal.cols), rows: Math.max(1, record.terminal.rows) });
    record.terminal.reset(); record.alive = record.session.alive;
    const ws = record.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminal/${record.session.id}`);
    await new Promise((resolve, reject) => {
      ws.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === 'output' || message.type === 'replay') record.terminal.write(message.data);
        if (message.type === 'replay') { record.alive = message.alive; this.label(record, message.alive ? 'Connected' : `Shell exited (${message.exitCode ?? 0})`); resolve(); }
        if (message.type === 'exit') { record.alive = false; this.label(record, `Shell exited (${message.exitCode ?? 0})`); }
      };
      ws.onerror = () => { this.label(record, 'Connection failed · hide and reopen to retry'); reject(new Error('Terminal connection failed. Hide and reopen to retry.')); };
      ws.onclose = () => { if (!record.disposed && record.alive) this.label(record, 'Disconnected · hide and reopen to reconnect'); reject(new Error('Terminal disconnected.')); };
    });
  }
  async dispose(record, stop = false) { if (record.pending) await record.pending.catch(() => {}); if (stop && record.session) await this.api(`/api/terminal/${record.session.id}`, 'DELETE', {}); record.disposed = true; record.ws?.close(); record.terminal.dispose(); record.element.remove(); this.records.delete(record.path); }
  async close() { const record = this.records.get(this.note?.path); if (!record) return; try { await this.dispose(record, true); this.hide(); } catch (error) { this.notice(error.message); } }
  forget(ids) { for (const record of this.records.values()) if (ids.includes(record.session?.id)) { this.dispose(record).catch(() => {}); if (this.note?.path === record.path) this.hide(false); } }
}
