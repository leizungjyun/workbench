import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { notebookVim } from './vim.js';
import { compactMarkdownKeys } from './markdown-keys.js';
import { indentationKeys } from './editor-keys.js';
import { renderMarkdown, safeHTML } from './render.js';
const sourceText = source => Array.isArray(source) ? source.join('') : source || '';
const el = (tag, content, cls) => { const node = document.createElement(tag); if (content !== undefined) node.textContent = content; if (cls) node.className = cls; return node; };
const button = (label, action, cls) => { const b = el('button', label, cls); b.type = 'button'; b.onclick = action; return b; };
const cleanText = value => sourceText(value).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
export class JupyterEditor {
  constructor({ parent, api, changed, notice, save, vimEnabled }) { Object.assign(this, { parent, api, changed, notice, save, vimEnabled }); this.views = []; this.sessions = new Map(); this.environments = []; this.running = false; this.generation = 0; }
  get content() { return this.raw; }
  update() { if (this.readOnly) return; this.raw = JSON.stringify(this.data, null, 1) + '\n'; this.changed(); }
  async load(note, content) {
    this.generation++; this.readOnly = !!note.readOnly; this.note = note; this.data = JSON.parse(content); this.raw = content;
    this.draw();
    if (!this.readOnly) await this.discover();
  }
  async discover(force = false) {
    const generation = this.generation;
    try {
      this.envSelect.disabled = true;
      const result = await this.api(`/api/environments${force ? '?refresh=true' : ''}`);
      if (generation !== this.generation) return;
      this.environments = result.environments; this.envSelect.replaceChildren();
      this.envSelect.append(new Option('Choose Python environment…', ''));
      for (const env of this.environments) { const option = new Option(`${env.name} · Python ${env.version}${env.available ? '' : ' · needs Jupyter'}`, env.id); option.disabled = !env.available; option.title = `${env.prefix}${env.reason ? ` — ${env.reason}` : ''}`; this.envSelect.append(option); }
      const session = (result.sessions || []).find(s => s.path === this.note.path) || this.sessions.get(this.note.path);
      if (session) this.sessions.set(this.note.path, session);
      let stored; try { stored = localStorage.getItem(`kernel-env:${this.note.path}`); } catch { /* Optional preference. */ }
      const preferred = this.data.metadata?.kernelspec?.display_name;
      this.envSelect.value = session?.environment || this.environments.find(e => e.available && e.id === stored)?.id || this.environments.find(e => e.available && e.name === preferred)?.id || this.environments.find(e => e.available)?.id || '';
      this.status.textContent = session ? `Idle · ${session.name}` : 'Kernel not started';
      if (!this.environments.some(e => e.available)) this.status.textContent = 'No ready environment. Install ipykernel and jupyter_client in a Conda environment, then refresh.';
    } catch (e) { if (generation === this.generation) this.status.textContent = `Could not discover environments: ${e.message}`; }
    finally { if (generation === this.generation) this.envSelect.disabled = this.running; }
  }
  draw() {
    this.views.forEach(v => v.editor.destroy()); this.views = []; this.parent.replaceChildren();
    if (this.readOnly) {
      this.cellList = el('div', undefined, 'jupyter-cells'); this.parent.append(this.cellList);
      this.data.cells.forEach((cell, index) => { const section = el('section', undefined, `nb-cell cell-${cell.cell_type}`); section.dataset.cell = index; const head = el('div', `Cell ${index + 1} · ${cell.cell_type}${cell.cell_type === 'code' ? ` · [${cell.execution_count ?? ' '}]` : ''}`, 'cell-header'); const preview = el('div', undefined, 'cell-render prose'); preview.style.width = '100%'; this.renderCell(cell, preview); section.append(head, preview); this.cellList.append(section); });
      this.setMode('preview'); return;
    }
    const toolbar = el('div', undefined, 'jupyter-toolbar');
    this.envSelect = document.createElement('select'); this.envSelect.setAttribute('aria-label', 'Python environment'); this.envSelect.append(new Option('Finding Python environments…', ''));
    this.envSelect.onchange = async () => { const old = this.sessions.get(this.note.path); if (old) { await this.api('/api/kernel/stop', 'POST', { session: old.id }).catch(e => this.notice(e.message)); this.sessions.delete(this.note.path); } try { localStorage.setItem(`kernel-env:${this.note.path}`, this.envSelect.value); } catch { /* optional */ } this.status.textContent = 'Kernel not started'; };
    this.status = el('span', 'Finding environments…', 'kernel-status'); this.status.setAttribute('role', 'status');
    this.runAllButton = button('▶ Run all', () => this.runAll(), 'kernel-button');
    this.startButton = button('Start kernel', () => this.start().catch(e => this.notice(e.message)), 'kernel-button');
    this.interruptButton = button('Interrupt', () => this.interrupt(), 'kernel-button');
    this.restartButton = button('Restart', () => this.restart(), 'kernel-button');
    this.stopButton = button('Stop', () => this.stop(), 'kernel-button');
    toolbar.append(this.envSelect, button('↻', () => this.discover(true), 'kernel-button refresh-env'), this.startButton, this.runAllButton, this.interruptButton, this.restartButton, this.stopButton);
    toolbar.querySelector('.refresh-env').setAttribute('aria-label', 'Refresh environments');
    const statusLine = el('div', undefined, 'kernel-status-line'); statusLine.append(this.status, el('span', 'Shift + Enter to run a cell', 'kernel-shortcut'));
    this.cellList = el('div', undefined, 'jupyter-cells');
    this.parent.append(toolbar, statusLine, this.cellList);
    this.data.cells.forEach((cell, i) => this.drawCell(cell, i));
    const additions = el('div', undefined, 'cell-additions');
    additions.append(button('+ Code cell', () => this.add('code')), button('+ Markdown cell', () => this.add('markdown')));
    this.parent.append(additions); this.setMode(this.mode || 'split'); this.setBusy(this.running);
  }
  drawCell(cell, index) {
    const section = el('section', undefined, `nb-cell cell-${cell.cell_type}`); section.dataset.cell = index;
    const head = el('div', undefined, 'cell-header');
    const count = el('span', cell.cell_type === 'code' ? `[${cell.execution_count ?? ' '}]` : '¶', 'execution-count');
    const type = document.createElement('select'); type.setAttribute('aria-label', `Cell ${index + 1} type`);
    for (const value of ['code', 'markdown', 'raw']) type.append(new Option(value[0].toUpperCase() + value.slice(1), value)); type.value = cell.cell_type;
    type.onchange = () => { cell.cell_type = type.value; if (cell.cell_type === 'code') { cell.outputs = []; cell.execution_count = null; } else { delete cell.outputs; delete cell.execution_count; } this.update(); this.redrawCells(); };
    head.append(count, type, el('span', `Cell ${index + 1}`, 'cell-number'));
    const run = button('▶ Run', () => this.runCell(index)); run.hidden = cell.cell_type !== 'code'; run.setAttribute('aria-label', `Run cell ${index + 1}`);
    head.append(run, button('↑', () => this.move(index, -1)), button('↓', () => this.move(index, 1)), button('Delete', () => { if (confirm(`Delete cell ${index + 1}?`)) { this.data.cells.splice(index, 1); this.update(); this.redrawCells(); } }));
    head.children[4].setAttribute('aria-label', `Move cell ${index + 1} up`); head.children[5].setAttribute('aria-label', `Move cell ${index + 1} down`);
    const body = el('div', undefined, 'cell-body'), source = el('div', undefined, 'cell-source'), preview = el('div', undefined, 'cell-render prose');
    const vimConfig = new Compartment(), readOnlyConfig = new Compartment();
    const editor = new EditorView({ parent: source, state: EditorState.create({ doc: sourceText(cell.source), extensions: [readOnlyConfig.of([]), vimConfig.of(this.vimEnabled ? notebookVim() : []), keymap.of([{ key: 'Shift-Enter', run: () => { this.runCell(index); return true; } }]), basicSetup, indentationKeys, cell.cell_type === 'code' ? python() : [markdown({ addKeymap: false }), compactMarkdownKeys], EditorView.lineWrapping, EditorView.contentAttributes.of({ 'aria-label': `${cell.cell_type} cell ${index + 1}` }), EditorView.theme({ '.cm-scroller': { fontFamily: '"SFMono-Regular",Consolas,monospace', fontSize: '13px', lineHeight: '1.8' }, '.cm-content': { padding: '14px 0' }, '.cm-gutters': { backgroundColor: '#f2f5ee', color: '#9ca892', border: 'none' }, '.cm-line': { padding: '0 14px' }, '&.cm-focused': { outline: 'none' }, '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#eaf0e2' } }), EditorView.updateListener.of(update => { if (update.docChanged) { cell.source = update.state.doc.toString().match(/[^\n]*\n|[^\n]+$/g) || []; this.update(); this.renderCell(cell, preview); } })] }) });
    body.append(source, preview); section.append(head, body); this.cellList.append(section);
    this.views.push({ editor, vimConfig, readOnlyConfig, section, preview, count, run, cell }); this.renderCell(cell, preview);
  }
  renderCell(cell, target) {
    target.replaceChildren();
    if (cell.cell_type === 'markdown') {
      const attachments = { ...this.note.attachments };
      for (const [name, bundle] of Object.entries(cell.attachments || {})) for (const mime of ['image/png', 'image/jpeg', 'image/gif']) if (bundle[mime]) { attachments[`attachment:${name}`] = `data:${mime};base64,${sourceText(bundle[mime])}`; break; }
      renderMarkdown(target, sourceText(cell.source), attachments);
    } else if (cell.cell_type === 'raw') target.append(el('pre', sourceText(cell.source)));
    else {
      const code = el('pre', sourceText(cell.source), 'code-preview'); target.append(code);
      for (const output of cell.outputs || []) {
        const block = el('div', undefined, 'cell-output');
        if (output.output_type === 'stream') block.append(el('pre', cleanText(output.text), output.name === 'stderr' ? 'output-error' : ''));
        else if (output.output_type === 'error') block.append(el('pre', cleanText((output.traceback || []).join('\n')) || `${output.ename}: ${output.evalue}`, 'output-error'));
        else {
          const data = output.data || {};
          if (data['image/png'] || data['image/jpeg']) { const mime = data['image/png'] ? 'image/png' : 'image/jpeg'; const img = document.createElement('img'); img.src = `data:${mime};base64,${sourceText(data[mime])}`; img.alt = 'Cell output'; block.append(img); }
          else if (data['text/html']) safeHTML(block, sourceText(data['text/html']));
          else if (data['text/markdown']) renderMarkdown(block, sourceText(data['text/markdown']));
          else if (data['text/latex']) renderMarkdown(block, sourceText(data['text/latex']));
          else if (data['image/svg+xml']) safeHTML(block, sourceText(data['image/svg+xml']));
          else if (data['application/json']) block.append(el('pre', JSON.stringify(data['application/json'], null, 2)));
          else if (data['text/plain']) block.append(el('pre', cleanText(data['text/plain'])));
          else block.append(el('p', 'This rich output requires JupyterLab to display. Its data is preserved.'));
        }
        target.append(block);
      }
      if (!(cell.outputs || []).length) target.append(el('p', 'No output yet', 'no-output'));
    }
  }
  redrawCells() { const selected = this.envSelect.value, status = this.status.textContent; this.draw(); this.discover().then(() => { if (selected) this.envSelect.value = selected; this.status.textContent = status; }); }
  add(type) { const cell = { id: crypto.randomUUID(), cell_type: type, metadata: {}, source: [], ...(type === 'code' ? { outputs: [], execution_count: null } : {}) }; this.data.cells.push(cell); this.update(); this.redrawCells(); this.views.at(-1)?.editor.focus(); }
  move(index, direction) { const target = index + direction; if (target < 0 || target >= this.data.cells.length) return; [this.data.cells[index], this.data.cells[target]] = [this.data.cells[target], this.data.cells[index]]; this.update(); this.redrawCells(); }
  setMode(mode) { this.mode = mode; this.parent.dataset.mode = mode; this.views.forEach(v => v.editor.requestMeasure()); }
  setVim(enabled) { this.vimEnabled = enabled; this.views.forEach(v => v.editor.dispatch({ effects: v.vimConfig.reconfigure(enabled ? notebookVim() : []) })); }
  focusMatch(match) { if (this.readOnly) { const cell = this.cellList.querySelector(`[data-cell="${match.cell}"]`); cell?.scrollIntoView({ block: 'center' }); cell?.classList.add('search-target'); return; } const view = this.views[match.cell]; if (!view) return; const from = Math.min(match.offset, view.editor.state.doc.length), to = Math.min(from + match.length, view.editor.state.doc.length); view.editor.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from) }); view.section.scrollIntoView({ block: 'center' }); view.editor.focus(); }
  setBusy(busy) {
    this.running = busy;
    this.envSelect.disabled = busy; this.runAllButton.disabled = busy; this.startButton.disabled = busy; this.restartButton.disabled = busy;
    this.parent.querySelectorAll('.cell-header button, .cell-header select, .cell-additions button, .refresh-env').forEach(b => b.disabled = busy);
    for (const view of this.views) view.editor.dispatch({ effects: view.readOnlyConfig.reconfigure([EditorState.readOnly.of(busy), EditorView.editable.of(!busy)]) });
  }
  async start() {
    if (this.readOnly) throw new Error('Restore this notebook before executing it.');
    const existing = this.sessions.get(this.note.path); if (existing) return existing;
    if (this.starting) return this.starting;
    if (!this.envSelect.value) throw new Error('Select a ready Python environment first.');
    this.status.textContent = 'Starting kernel…';
    const relative = this.note.path, environment = this.envSelect.value;
    this.starting = this.api('/api/kernel/start', 'POST', { path: relative, environment }).catch(e => { this.status.textContent = e.message; throw e; }).then(session => { this.sessions.set(relative, session); this.status.textContent = `Idle · ${session.name}`; this.status.title = `Working folder: ${session.cwd}`; return session; }).finally(() => { this.starting = null; });
    return this.starting;
  }
  async execute(index) {
    const cell = this.data.cells[index]; if (cell.cell_type !== 'code') return true;
    const session = await this.start(); if (this.cancelRun) return false; this.status.textContent = `Running cell ${index + 1} · ${session.name}`; this.views[index].count.textContent = '[*]';
    const result = await this.api('/api/kernel/execute', 'POST', { session: session.id, code: sourceText(cell.source) });
    cell.outputs = result.outputs; cell.execution_count = result.execution_count;
    this.views[index].count.textContent = `[${cell.execution_count ?? ' '}]`; this.renderCell(cell, this.views[index].preview); this.update(); await this.save();
    this.status.textContent = `Idle · ${session.name}`; return !result.outputs.some(o => o.output_type === 'error');
  }
  async runCell(index) {
    if (this.readOnly || this.running || this.data.cells[index].cell_type !== 'code') return;
    this.cancelRun = false; this.setBusy(true);
    try { await this.save(); await this.execute(index); } catch (e) { this.status.textContent = e.message; this.notice(e.message); } finally { this.setBusy(false); this.views.forEach(v => v.count.textContent = v.cell.cell_type === 'code' ? `[${v.cell.execution_count ?? ' '}]` : '¶'); }
  }
  async runAll() {
    if (this.readOnly || this.running) return; this.cancelRun = false; this.setBusy(true);
    try { await this.save(); for (let i = 0; i < this.data.cells.length; i++) { if (this.cancelRun || !await this.execute(i)) break; } }
    catch (e) { this.status.textContent = e.message; this.notice(e.message); } finally { this.setBusy(false); this.views.forEach(v => v.count.textContent = v.cell.cell_type === 'code' ? `[${v.cell.execution_count ?? ' '}]` : '¶'); }
  }
  async interrupt() { this.cancelRun = true; const session = this.sessions.get(this.note.path); if (session) { try { await this.api('/api/kernel/interrupt', 'POST', { session: session.id }); this.status.textContent = 'Interrupt requested…'; } catch (e) { this.notice(e.message); } } }
  async stop() { this.cancelRun = true; if (this.starting) await this.starting.catch(() => {}); const session = this.sessions.get(this.note.path); if (session) { await this.api('/api/kernel/stop', 'POST', { session: session.id }).catch(e => this.notice(e.message)); this.sessions.delete(this.note.path); } this.status.textContent = 'Kernel stopped'; }
  async restart() { await this.stop(); this.start().catch(e => this.notice(e.message)); }
}
