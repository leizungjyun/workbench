import { CalendarWorkspace } from './calendar.js';
import { CalendarReminders } from './calendar-reminders.js';
import { DailyWorkspace } from './daily.js';
import { StudentWorkspace } from './students.js';
import { notebookHeading, replaceNotebookHeading } from './notebook-title.js';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Vim } from '@replit/codemirror-vim';
import { notebookVim } from './vim.js';
import { renderMarkdown } from './render.js';
import { exportMarkdownPDF } from './pdf-export.js';
import { JupyterEditor } from './jupyter.js';
import { synchronizeScroll, alignmentExtension } from './scroll-sync.js';
import { compactMarkdownKeys } from './markdown-keys.js';
import { WorkspaceTerminal } from './terminal.js';
import { NotebookSidebar } from './sidebar.js';
import { indentationKeys } from './editor-keys.js';
import { NotebookTabs, notebookUrl, comparisonText } from './notebook-tabs.js';
import './style.css';
import './vim-diagnostics.js';

const $ = id => document.getElementById(id);
const icons = {
 book: '<rect x="6" y="3" width="14" height="18" rx="2"/><path d="M10 3v18M3 7h5M3 12h5M3 17h5"/>',
 search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>', plus:'<path d="M12 5v14M5 12h14"/>',
 pin:'<path d="m9 3 6 0-1 6 4 4v2H6v-2l4-4-1-6ZM12 15v6"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', layers:'<path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/>',
 folder:'<path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11H3V7Z"/>',
 folderPlus:'<path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11H3V7ZM12 10v6M9 13h6"/>',
 panel:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
 file:'<path d="M14 3H5v18h14V8l-5-5ZM14 3v5h5M8 12h8M8 16h6"/>',
 arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>', leaf:'<path d="M20 4C8 2 3 9 6 16c7 4 15-1 14-12ZM4 21 15 10"/>',
 edit:'<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z"/>', trash:'<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
 archive:'<path d="M3 4h18v4H3zM5 8v13h14V8M9 12h6"/>',
 filePlus:'<path d="M14 3H5v18h14V8l-5-5ZM14 3v5h5M12 11v7M8.5 14.5h7"/>',
 restore:'<path d="M4 10a8 8 0 1 1 1 8M4 4v6h6"/>',
 unarchive:'<path d="M3 4h18v4H3zM5 8v13h14V8M12 18v-7m-3 3 3-3 3 3"/>',
 purge:'<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M9 11l6 6m0-6-6 6"/>',
 terminal:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m6 8 4 4-4 4m7 0h5"/>',
 chevronDown:'<path d="m5 9 7 7 7-7"/>',
 chevron:'<path d="m9 5 7 7-7 7"/>'
};
function icon(name) { const s = document.createElement('span'); s.className = 'icon'; s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.file}</svg>`; return s; }
document.querySelectorAll('[data-icon]').forEach(el => el.append(icon(el.dataset.icon)));
const text = (tag, value, cls) => { const el = document.createElement(tag); el.textContent = value; if (cls) el.className = cls; return el; };
const title = p => p.split('/').at(-1).replace(/\.(md|ipynb)$/i, '');
const folder = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
const storage = { get(key, fallback = null) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }, set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Disk saving still works if browser storage is unavailable. */ } }, remove(key) { try { localStorage.removeItem(key); } catch { /* optional draft cache */ } } };
let tree = { notes: [], folders: [], pins: [], recent: [] }, current = null, editor, savedContent = '', saving = null, saveTimer, searchTimer, searchId = 0, navigating = false, conflict = false, blocked = false;
const tabs = new NotebookTabs(() => renderSidebar());
let screen = 'welcome', mode = storage.get('fieldnotes-mode', matchMedia('(max-width: 760px)').matches ? 'preview' : 'split');
let vimEnabled = storage.get('fieldnotes-vim', true);
const vimConfig = new Compartment();
const isMarkdown = () => !current || current.kind === 'markdown';
const languageConfig = new Compartment();
const isJupyter = () => /\.ipynb$/i.test(current?.path || '');
const content = () => isJupyter() ? jupyter.content : editor.state.doc.toString();
let previewTimer, renderedDoc = null, renderedPath = null;
let expanded = new Set(storage.get('fieldnotes-folders', []));
async function api(url, method = 'GET', data) { const response = await fetch(url, { method, ...(data !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}) }); const payload = await response.json(); if (!response.ok) throw Object.assign(new Error(payload.error || 'Request failed.'), { status: response.status, code: payload.code, terminals: payload.terminals }); return payload; }
function notice(message) { $('notice-text').textContent = message; $('notice').hidden = false; }
$('dismiss-notice').onclick = () => $('notice').hidden = true;
function saveLabel(label, state = '') {
  $('save-label').textContent = label; $('save-note').dataset.state = state;
  const timestamp = current?.savedAt ? new Date(current.savedAt) : null;
  $('save-time').textContent = timestamp ? ` · ${timestamp.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : '';
  $('save-time').dateTime = timestamp?.toISOString() || '';
  $('save-time').title = timestamp ? `Last saved to disk: ${timestamp.toLocaleString()}` : '';
}
function dirty() { return !!current && !current.readOnly && !current.viewOnly && content() !== savedContent; }
function cacheDraft() { if (dirty()) storage.set(`draft:${current.path}`, { content: content(), revision: current.revision }); else if (current && !current.readOnly) storage.remove(`draft:${current.path}`); }
function updateWordCount() {
  if (!current) return;
  if (isJupyter()) { $('word-count').textContent = `${jupyter.data.cells.length} cells · ${jupyter.data.cells.filter(c => c.cell_type === 'code').length} code cells`; return; }
  const value = editor.state.doc.toString();
  const words = value.trim() ? value.trim().split(/\s+/u).length : 0;
  $('word-count').textContent = `${words.toLocaleString()} words · ${value.length.toLocaleString()} characters`;
}
function renderPreview() {
  clearTimeout(previewTimer);
  updateWordCount();
  if (!current || current.viewOnly || isJupyter() || mode === 'edit') return;
  if (renderedDoc === editor.state.doc && renderedPath === current.path) return;
  if (!isMarkdown()) { const pre = document.createElement('pre'); for (let number=1; number<=editor.state.doc.lines; number++) { const line=editor.state.doc.line(number), span=text('span', line.text || ' '); span.style.display='block'; span.dataset.sourceFrom=line.from; span.dataset.sourceTo=line.to+1; pre.append(span); } $('preview').replaceChildren(pre); renderedDoc = editor.state.doc; renderedPath = current.path; return; }
  renderMarkdown($('preview'), editor.state.doc.toString(), current.attachments, href => openNote(decodeURIComponent(new URL(href, `http://notes/${current.path}`).pathname.slice(1))), true);
  renderedDoc = editor.state.doc; renderedPath = current.path;
  scrollSync.refresh(editor.scrollDOM);
}
function schedulePreview() {
  clearTimeout(previewTimer);
  if (current && !isJupyter() && mode !== 'edit') previewTimer = setTimeout(renderPreview, 160);
}

function editorState(content, readOnly = false) {
  return EditorState.create({ doc: content, extensions: [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly), alignmentExtension, vimConfig.of(vimEnabled ? notebookVim() : []), basicSetup, indentationKeys, languageConfig.of(isMarkdown() ? markdown({ codeLanguages: languages, addKeymap: false }) : []), ...(isMarkdown() ? [compactMarkdownKeys] : []), EditorView.lineWrapping, EditorView.contentAttributes.of({ 'aria-label': isMarkdown() ? 'Markdown source' : 'Text source', spellcheck: 'true' }), EditorView.theme({ '&': { height: '100%', fontSize: '14px' }, '.cm-scroller': { overflow: 'auto', fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace', lineHeight: '1.85' }, '.cm-content': { padding: '24px 0 80px' }, '.cm-line': { padding: '0 24px 0 12px' }, '.cm-gutters': { backgroundColor: 'transparent', color: '#abb0a5', border: 'none', padding: '0 4px 0 10px' }, '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#edf0e780' }, '&.cm-focused': { outline: 'none' }, '.cm-cursor': { borderLeftColor: '#2d5745' } }), EditorView.updateListener.of(update => { if (update.docChanged) { changed(); } })] });
}
function changed() { updateNotebookTitle(); updateWordCount(); schedulePreview(); cacheDraft(); if (dirty()) { saveLabel(conflict ? 'Conflict · draft preserved' : 'Unsaved changes', 'unsaved'); clearTimeout(saveTimer); if (!blocked && !conflict) saveTimer = setTimeout(() => save().catch(() => {}), 750); } else saveLabel('Saved to disk'); }
editor = new EditorView({ state: editorState(''), parent: $('editor') });
const scrollSync = synchronizeScroll(editor, $('preview'), () => screen === 'notebook' && mode === 'split' && isMarkdown(), () => renderedDoc === editor.state.doc && renderedPath === current?.path);
const jupyter = new JupyterEditor({ parent: $('jupyter-editor'), api, changed, notice, save: () => save(), vimEnabled });
const workspaceTerminal = new WorkspaceTerminal({ api, notice, restoreFocus: () => { if (current && screen === 'notebook') { if (isJupyter()) jupyter.views[0]?.editor.focus(); else if (mode !== 'preview') editor.focus(); else $('note-title').focus(); } } });
const students = new StudentWorkspace({ schedule: async (studentId, date) => { if (await openCalendar(date)) calendar.edit(undefined, undefined, { studentId, title: 'Student conversation', duration: '30' }); }, parent: $('students-workspace'), api, notice, prepare: flush, navigate: id => openStudents(id), enter: async () => {
  tabs.release(); clearTimeout(saveTimer); clearTimeout(previewTimer); current = null; savedContent = '';
  setScreen('students-workspace'); renderSidebar(); return true;
} });
async function openStudents(id, push = true) {
  if (navigating) return false; navigating = true;
  try { return await students.open(id, push); } finally { navigating = false; }
}
$('students-launch').onclick = () => openStudents();
const daily = new DailyWorkspace({ parent: $('daily-workspace'), api, notice, prepare: flush, navigate: (date, task) => openDaily(date, task), enter: async () => {
  tabs.release(); clearTimeout(saveTimer); clearTimeout(previewTimer); current = null; savedContent = '';
  setScreen('daily-workspace'); renderSidebar();
} });
async function openDaily(date, task, push = true) {
  if (navigating) return false; navigating = true;
  try { return await daily.open(date, task, push); } finally { navigating = false; }
}
$('daily-launch').onclick = () => openDaily();
const calendarReminders = new CalendarReminders({ api, parent: $('calendar-reminders'), notice });
const calendar = new CalendarWorkspace({ parent: $('calendar-workspace'), api, notice, prepare: flush, navigate: date => openCalendar(date), reminders: calendarReminders, enter: async () => {
  tabs.release(); clearTimeout(saveTimer); clearTimeout(previewTimer); current = null; savedContent = '';
  setScreen('calendar-workspace'); renderSidebar();
} });
async function openCalendar(date, push = true) {
  if (navigating) return false; navigating = true;
  try { const eventId = new URLSearchParams(location.search).get('event'); const opened = await calendar.open(date, push); if (opened) { const event = calendar.data.events.find(e => e.id === eventId); if (event) calendar.edit(event); } return opened; } finally { navigating = false; }
}
$('calendar-launch').onclick = () => openCalendar();
function updateVimButton() { $('vim-toggle').textContent = `Vim: ${vimEnabled ? 'on' : 'off'}`; $('vim-toggle').setAttribute('aria-pressed', String(vimEnabled)); }
$('vim-toggle').onclick = () => { vimEnabled = !vimEnabled; storage.set('fieldnotes-vim', vimEnabled); editor.dispatch({ effects: vimConfig.reconfigure(vimEnabled ? notebookVim() : []) }); jupyter.setVim(vimEnabled); updateVimButton(); };
Vim.defineEx('write', 'w', () => save().catch(e => notice(e.message)));
updateVimButton();

async function save(force = false) {
  clearTimeout(saveTimer);
  if (saving) { await saving; return dirty() ? save(force) : true; }
  if (!current || current.readOnly || current.viewOnly || (!dirty() && !force)) return true;
  if (tabs.path !== current.path) throw new Error('This tab no longer owns the notebook. Reopen it before saving.');
  if (conflict && !force) throw new Error('Resolve the external edit before leaving this note.');
  const path = current.path, source = content(), revision = current.revision;
  saveLabel('Saving…', 'saving');
  saving = (async () => {
    try {
      const result = await api('/api/note', 'PUT', { path, content: source, revision, force });
      current = result; savedContent = source; conflict = false; blocked = false; $('conflict').hidden = true;
      cacheDraft(); saveLabel(dirty() ? 'Unsaved changes' : 'Saved to disk', dirty() ? 'unsaved' : '');
      if (dirty()) saveTimer = setTimeout(() => save().catch(() => {}), 750);
      return true;
    } catch (e) {
      blocked = true; cacheDraft(); saveLabel(e.status === 409 ? 'Conflict · draft preserved' : 'Save failed · retry', 'error');
      if (e.status === 409) { conflict = true; $('conflict').hidden = false; } else notice(e.message);
      throw e;
    } finally { saving = null; }
  })();
  return saving;
}
async function flush() { if (!await calendar.flush()) return false; if (!await daily.flush()) return false; if (!await students.flush()) return false; if (jupyter.running || jupyter.starting) { notice('Wait for the kernel operation to finish, or interrupt it before switching notebooks.'); return false; } try { await save(); return true; } catch (e) { notice(e.message); return false; } }
$('save-note').onclick = () => save().catch(e => notice(e.message));
$('overwrite-note').onclick = () => { if (confirm('Replace the disk version with your current draft?')) save(true).catch(e => notice(e.message)); };
$('reload-note').onclick = async () => {
  if (!confirm('Discard your local draft and load the version on disk?')) return;
  try { const note = await api(`/api/note?path=${encodeURIComponent(current.path)}`); storage.remove(`draft:${current.path}`); showNote(note); } catch (e) { notice(e.message); }
};
function setScreen(next) {
  if (next !== 'calendar-workspace' && screen === 'calendar-workspace') calendar.close();
  if (next !== 'daily-workspace' && screen === 'daily-workspace') daily.close();
  if (next !== 'students-workspace' && screen === 'students-workspace') students.close();
  screen = next;
  for (const id of ['welcome', 'notebook', 'search-view', 'students-workspace', 'daily-workspace', 'calendar-workspace']) $(id).hidden = id !== next;
  const topbar = document.querySelector('.topbar');
  const notebookOpen = next === 'notebook';
  const header = notebookOpen ? document.querySelector('.note-heading-context') : topbar;
  const studentOpen = next === 'calendar-workspace' || next === 'students-workspace' || next === 'daily-workspace';
  const sidebarToggle = $('toggle-sidebar'); sidebarToggle.classList.toggle('student-navigation-toggle', studentOpen);
  if (studentOpen) document.querySelector('.shell').insertBefore(sidebarToggle, document.querySelector('main')); else header.prepend(sidebarToggle);
  topbar.hidden = notebookOpen || studentOpen;
  $('breadcrumb').textContent = next === 'students-workspace' ? 'Student supervision' : next === 'search-view' ? 'Search your collection' : 'Your collection';
  if (notebookOpen) $('note-folder').textContent = (current.readOnly ? `${current.scope === 'archive' ? 'Archive' : 'Trash'} / ` : '') + current.path;
  workspaceTerminal.setNote(current, notebookOpen);
  if (matchMedia('(max-width: 760px)').matches) document.body.classList.remove('sidebar-open');
  updateSidebarControls();
}

function setMode(next) { if (current?.readOnly || current?.viewOnly) next = 'preview'; const previous = mode; mode = ['edit', 'split', 'preview'].includes(next) ? next : 'split'; $('writing-space').dataset.mode = mode; document.querySelectorAll('[data-mode]').forEach(el => { if (el.tagName === 'BUTTON') { el.classList.toggle('active', el.dataset.mode === mode); el.setAttribute('aria-pressed', String(el.dataset.mode === mode)); } }); $('mode-label').textContent = `${mode[0].toUpperCase() + mode.slice(1)} view`; if (!current?.readOnly && !current?.viewOnly) storage.set('fieldnotes-mode', mode); editor.requestMeasure(); jupyter.setMode(mode); renderPreview(); scrollSync.refresh(previous === 'preview' ? $('preview') : editor.scrollDOM); }
document.querySelectorAll('button[data-mode]').forEach(button => button.onclick = () => setMode(button.dataset.mode));
$('export-pdf').onclick = async () => {
  if (!current || isJupyter()) return;
  const button = $('export-pdf');
  button.disabled = true;
  try { await exportMarkdownPDF({ source: content(), path: current.path, attachments: current.attachments }); }
  catch (error) { notice(error.message); }
  finally { button.disabled = false; }
};
function showNote(note) {
  clearTimeout(saveTimer); clearTimeout(previewTimer); renderedDoc = null; renderedPath = null;
  scrollSync.reset();
  current = note; savedContent = note.content; conflict = false; blocked = false; $('conflict').hidden = true;
  const draft = note.readOnly ? null : storage.get(`draft:${note.path}`);
  const notebookType = isJupyter();
  $('export-pdf').hidden = !isMarkdown();
  $('writing-space').hidden = notebookType || note.viewOnly; $('jupyter-editor').hidden = !notebookType; $('file-format').textContent = note.kind;
  const media = $('file-viewer'); media.hidden = !note.viewOnly; media.replaceChildren();
  const raw = `/api/file/raw?${refQuery(noteRef(note))}`;
  if (note.viewOnly) {
    const info = text('p', `${note.path} · ${note.size.toLocaleString()} bytes${note.reason ? ' · ' + note.reason : ''}`); media.append(info);
    if (note.kind === 'image' || note.kind === 'pdf') { const preview = document.createElement(note.kind === 'image' ? 'img' : 'iframe'); preview.src = raw + '&preview=true'; preview.title = note.path; if (note.kind === 'image') preview.alt = note.path; media.append(preview); }
    const download = text('a', 'Download file', 'file-download'); download.href = raw; download.download = note.path.split('/').at(-1); media.append(download);
  }
  if (notebookType) jupyter.load(note, draft?.content ?? note.content).catch(e => notice(e.message));
  else { editor.setState(editorState(draft?.content ?? note.content, !!note.readOnly || note.viewOnly)); if (note.kind === 'text') { const lang = LanguageDescription.matchFilename(languages, note.path); lang?.load().then(support => { if (current?.path === note.path) editor.dispatch({ effects: languageConfig.reconfigure(support) }); }); } }
  if (draft && draft.content !== note.content) { current.revision = draft.revision; conflict = draft.revision !== note.revision; blocked = conflict; $('conflict').hidden = !conflict; if (!conflict) saveTimer = setTimeout(() => save().catch(() => {}), 750); }
  $('stored-banner').hidden = !note.readOnly;
  $('restore-current').hidden = !!note.duplicate;
  $('claim-notebook').hidden = !note.duplicate;
  $('focus-notebook').hidden = !note.duplicate;
  $('stored-label').textContent = note.duplicate ? (!navigator.locks ? 'This browser cannot coordinate editing tabs · Read-only' : 'Already being edited in another tab · Read-only') : note.scope === 'archive' ? 'Archived · Read-only' : 'In Trash · Read-only';
  $('restore-current').textContent = note.scope === 'archive' ? 'Unarchive' : 'Restore';
  $('save-note').hidden = !!note.readOnly || note.viewOnly; $('vim-toggle').hidden = !!note.readOnly || note.viewOnly;
  document.querySelector('.mode-switch').hidden = !!note.readOnly || note.viewOnly;
  if (!note.readOnly) mode = storage.get('fieldnotes-mode', 'split');
  updateNotebookTitle();
  $('note-folder').disabled = !!note.readOnly;
  setScreen('notebook'); setMode(mode); renderPreview(); renderSidebar();
  saveLabel(conflict ? 'Conflict · draft preserved' : dirty() ? 'Restored unsaved draft' : 'Saved to disk', dirty() ? 'unsaved' : '');
}
function followNotebook(event, ref, match) {
  if (event.type === 'auxclick' && event.button !== 1) return;
  if (event.altKey) return;
  event.preventDefault();
  const active = (ref.scope || 'active') === 'active';
  if (active && tabs.path === ref.path && !event.metaKey && !event.ctrlKey && !event.shiftKey && event.button !== 1) {
    if (match) openReference(ref, match); else setScreen('notebook');
    return;
  }
  if ((active && (tabs.path === ref.path || tabs.isOpen(ref.path) || tabs.findWindow(ref.path))) || event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) {
    const result = tabs.open(ref);
    if (result === 'blocked') notice('Your browser blocked opening the notebook tab. Allow popups for this app and try again.');
    if (result === 'unreachable') notice('This notebook is already being edited in a tab opened separately. Switch to that tab using the browser tab bar.');
    if (tabs.path === ref.path && screen !== 'notebook') setScreen('notebook');
    return;
  }
  openReference(ref, match);
}
function bindNotebookLink(link, ref, match) {
  link.href = notebookUrl(ref); link.setAttribute('role', 'button');
  link.onclick = event => followNotebook(event, ref, match);
  link.onauxclick = event => followNotebook(event, ref, match);
}
async function openNote(path, match) { return openReference({ scope: 'active', path, kind: 'note' }, match); }
function noteRef(note) { return note.readOnly && !note.duplicate ? { scope: note.scope, id: note.id, path: note.storedPath, displayPath: note.path, kind: 'note' } : { scope: 'active', path: note.path, displayPath: note.path, kind: 'note' }; }
const refQuery = ref => new URLSearchParams({ scope: ref.scope || 'active', path: ref.path || '', ...(ref.id ? { id: ref.id } : {}) }).toString();
async function openReference(ref, match) {
  if (navigating) return; navigating = true;
  try {
    if (!await flush()) return;
    const note = await api(`/api/note?${refQuery(ref)}`);
    if (!note.readOnly) {
      const owned = await tabs.acquire(note.path);
      if (!owned) { tabs.release(); note.readOnly = true; note.duplicate = true; }
    } else tabs.release();
    showNote(note);
    if (location.search !== notebookUrl(ref)) history.pushState(null, '', notebookUrl(ref));
    try { if (!note.readOnly) { tree = await api('/api/metadata', 'POST', { path: note.path, recent: true }); renderSidebar(); } } catch (e) { notice(e.message); }
    if (match && note.readOnly) { if (isJupyter()) jupyter.focusMatch(match); else { const block = [...$('preview').querySelectorAll('[data-source-from]')].find(b => Number(b.dataset.sourceFrom) <= match.offset && Number(b.dataset.sourceTo) > match.offset); block?.scrollIntoView({ block: 'center' }); block?.classList.add('search-target'); } return; }
    if (match) { setMode(matchMedia('(max-width: 760px)').matches ? 'edit' : 'split'); if (isJupyter()) { jupyter.focusMatch(match); return; } const from = Math.min(match.offset, editor.state.doc.length), to = Math.min(from + match.length, editor.state.doc.length); editor.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) }); editor.focus(); }
  } catch (e) { notice(e.message); } finally { navigating = false; }
}
const sidebar = new NotebookSidebar({ icon, url: notebookUrl, isOpen: path => tabs.isOpen(path), open: ref => openReference(ref), follow: followNotebook, action: sidebarAction, expanded, remember: () => storage.set('fieldnotes-folders', [...expanded]) });
function renderSidebar() { sidebar.draw(tree, screen === 'notebook' ? current : null); }
function renderWelcome() {
  $('overview').replaceChildren(...[[tree.notes.length, 'Notebooks', 'file'], [tree.folders.length, 'Folders', 'folder'], [tree.pins.length, 'Pinned notes', 'pin']].map(([number, label, symbol]) => { const item = document.createElement('div'); item.append(icon(symbol), text('strong', String(number)), text('span', label)); return item; }));
  const cards = [...tree.notes].sort((a, b) => b.modified - a.modified).slice(0, 6).map(note => {
    const card = text('a', '', 'note-card'); card.href = notebookUrl({ path: note.path }); const heading = text('div', '', 'card-top'); heading.append(icon('file'), text('span', folder(note.path) || 'Collection')); card.append(heading, text('h3', title(note.path)), text('span', 'Open notebook', 'card-open'), icon('arrow')); bindNotebookLink(card, { scope: 'active', path: note.path }); return card;
  });
  $('note-cards').replaceChildren(...(cards.length ? cards : [text('p', 'No notebooks yet. Start with a blank page.', 'empty-message')]));
}
async function refresh() { const latest = await api('/api/tree'); if (JSON.stringify(latest) !== JSON.stringify(tree)) { tree = latest; renderSidebar(); renderWelcome(); } if (screen === 'search-view') await runSearch(); }
async function home() { if (navigating) return; if (!await flush()) return; if (location.search) history.pushState(null, '', location.pathname); clearCurrent(); setScreen('welcome'); document.title = 'Workbench · Your personal workspace'; renderSidebar(); renderWelcome(); }
$('home').onclick = home;
async function launchSearch() { if (navigating) return; if (!await flush()) return; setScreen('search-view'); renderSidebar(); $('search-input').focus(); runSearch(); }
$('search-launch').onclick = launchSearch; $('welcome-search').onclick = launchSearch;
function highlightedSnippet(match) { const span = document.createElement('span'); span.append(document.createTextNode(match.snippet.slice(0, match.highlight)), text('mark', match.snippet.slice(match.highlight, match.highlight + match.length)), document.createTextNode(match.snippet.slice(match.highlight + match.length))); return span; }
async function runSearch() {
  const id = ++searchId, query = $('search-input').value;
  if (!query.trim()) { $('search-summary').textContent = 'Search Collections, Archive, Daily, and Students. Trash is excluded.'; $('search-results').replaceChildren(); return; }
  $('search-summary').textContent = 'Searching…';
  try {
    const result = await api(`/api/search?q=${encodeURIComponent(query)}`); if (id !== searchId) return;
    const count = result.notes.length + (result.daily?.length || 0) + (result.students?.length || 0), kind = result.daily?.length || result.students?.length ? 'result' : 'notebook';
    $('search-summary').textContent = `${count} matching ${kind}${count === 1 ? '' : 's'} · ${result.occurrences} text match${result.occurrences === 1 ? '' : 'es'}`;
    $('search-results').replaceChildren(...result.notes.map(note => {
      const group = text('section', '', 'result-group'), heading = text('a', '', 'result-title'); heading.append(icon('file'), text('strong', title(note.path)), text('span', `${note.count} ${note.count === 1 ? 'match' : 'matches'}`, 'match-badge')); if (note.scope === 'archive') heading.append(text('span', 'Archive', 'archive-badge')); const ref = { scope: note.scope || 'active', id: note.id, path: note.scope === 'archive' ? note.storedPath : note.path, kind: 'note' }; bindNotebookLink(heading, ref, note.matches[0]); group.append(heading, text('div', note.path, 'result-path'));
      for (const match of note.matches) { const button = text('a', '', 'result-snippet'); button.append(highlightedSnippet(match)); bindNotebookLink(button, ref, match); group.append(button); }
      if (note.count > note.matches.length) group.append(text('p', `Showing the first ${note.matches.length} of ${note.count} matches.`, 'result-path'));
      return group;
    }));
    for (const item of result.daily || []) {
      const group = text('section', '', 'result-group'), heading = text('a', `Daily · ${item.date} · ${item.category || 'Daily notes'} · ${item.status}`, 'result-title');
      const bind = (link, date = item.date) => { link.href = `?view=daily&date=${date}${item.taskId ? `&task=${item.taskId}` : ''}`; link.onclick = async event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); if (await openDaily(date, item.taskId)) highlightDailyMatch(query); }; };
      bind(heading); group.append(heading, text('div', item.title, 'result-path'));
      for (const match of item.matches) { const link = text('a', '', 'result-snippet'); link.append(highlightedSnippet(match)); bind(link, match.date || item.date); group.append(link); }
      if (item.count > item.matches.length) group.append(text('p', `Showing the first ${item.matches.length} of ${item.count} matches.`, 'result-path'));
      $('search-results').append(group);
    }
    for (const item of result.students || []) {
      const group = text('section', '', 'result-group'), heading = text('a', '', 'result-title');
      heading.append(text('strong', `Students · ${item.name}`), text('span', `${item.count} ${item.count === 1 ? 'match' : 'matches'}`, 'match-badge'));
      if (item.archived) heading.append(text('span', 'Archived student', 'archive-badge'));
      const bind = (link, match) => { link.href = `?view=student&id=${item.id}`; link.onclick = async event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); if (await openStudents(item.id)) students.focusMatch(match); }; };
      bind(heading, item.matches[0]); group.append(heading);
      for (const match of item.matches) { const link = text('a', '', 'result-snippet'); link.append(text('span', `${match.section} · `), highlightedSnippet(match)); bind(link, match); group.append(link); }
      if (item.count > item.matches.length) group.append(text('p', `Showing the first ${item.matches.length} of ${item.count} matches.`, 'result-path'));
      $('search-results').append(group);
    }
    if (!result.notes.length && !result.daily?.length && !result.students?.length) $('search-results').append(text('p', 'No results found. Try a different word or a shorter phrase.', 'empty-message'));
  } catch (e) { if (id === searchId) { $('search-summary').textContent = e.message; $('search-results').replaceChildren(); } }
}
function highlightDailyMatch(query) {
  const host = daily.focusId ? [...$('daily-workspace').querySelectorAll('[data-task]')].find(n => n.dataset.task === daily.focusId) : $('daily-workspace').querySelector('.daily-editor > .daily-formatted');
  if (!host) return;
  for (const input of host.querySelectorAll('input')) if (input.value.toLocaleLowerCase().includes(query.toLocaleLowerCase())) { input.classList.add('daily-match'); input.title = `Search match: ${query}`; }
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT), nodes = []; let node;
  while ((node = walker.nextNode())) if (!node.parentElement.closest('button, textarea, select, summary, mark')) nodes.push(node);
  for (const node of nodes) {
    const value = node.textContent, index = value.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
    if (index < 0) continue;
    const fragment = document.createDocumentFragment(); fragment.append(document.createTextNode(value.slice(0, index)), text('mark', value.slice(index, index + query.length)), document.createTextNode(value.slice(index + query.length))); node.replaceWith(fragment);
  }
  if (!daily.focusId) host.scrollIntoView({ block: 'center' });
}
$('search-input').oninput = () => { clearTimeout(searchTimer); ++searchId; searchTimer = setTimeout(runSearch, 180); };
let dialogAction, dialogRef, dialogInfo, dialogReturn;
const containsPath = (parent, child) => child === parent || child.startsWith(parent + '/');
function currentAffected(ref) { return current && (current.scope || 'active') === ref.scope && (ref.scope === 'active' ? containsPath(ref.path, current.path) : current.id === ref.id && (!ref.path || containsPath(ref.path, current.storedPath))); }
function clearCurrent() { tabs.release(); history.replaceState(null, '', location.pathname); clearTimeout(saveTimer); clearTimeout(previewTimer); current = null; savedContent = ''; editor.setState(editorState('')); setScreen('welcome'); document.title = 'Workbench · Your personal workspace'; }
function updateBrowserPaths(ref, result, source, destination) {
  try {
    const fromPrefix = ref.scope === 'active' ? '' : `stored:${ref.scope}:${ref.id}:`;
    const toPrefix = result.scope === 'active' ? '' : `stored:${result.scope}:${result.id}:`;
    for (const key of Object.keys(localStorage)) for (const type of ['draft:', 'kernel-env:']) {
      const prefix = fromPrefix + type;
      if (!key.startsWith(prefix)) continue;
      const old = key.slice(prefix.length); if (!containsPath(source, old)) continue;
      const value = localStorage.getItem(key); localStorage.removeItem(key);
      if (result.scope) localStorage.setItem(toPrefix + type + destination + old.slice(source.length), value);
    }
  } catch { /* Browser preferences are optional. Disk records remain intact. */ }
  if (ref.scope === 'active') {
    const next = [...expanded].map(p => containsPath(source, p) ? result.scope === 'active' ? destination + p.slice(source.length) : null : p).filter(Boolean);
    expanded.clear(); next.forEach(p => expanded.add(p)); storage.set('fieldnotes-folders', [...expanded]);
  }
}
async function itemInfo(ref) {
  if (currentAffected(ref) && !current.readOnly) {
    const latest = await api(`/api/note?path=${encodeURIComponent(current.path)}`);
    if (latest.revision !== current.revision) throw new Error('An open notebook changed on disk. Reload it before moving this item.');
  }
  return api(`/api/item?${refQuery(ref)}`);
}
async function performTransfer(action, ref, info, destination) {
  const sidebarWasOpen = document.body.classList.contains('sidebar-open');
  const affected = currentAffected(ref), suffix = affected ? current.path.slice(info.displayPath.length) : '';
  const input = { ...ref, action, revision: info.revision, ...(destination ? { destination } : {}) };
  let result;
  try { result = await api('/api/item', 'POST', input); } catch (error) {
    if (error.code !== 'TERMINALS_ACTIVE') throw error;
    if (!confirm(`Close ${error.terminals.length} affected terminal session(s) and continue? This stops their running commands.`)) return null;
    result = await api('/api/item', 'POST', { ...input, stopTerminals: true }); workspaceTerminal.forget(error.terminals.map(s => s.id));
  }
  if (ref.scope === 'active') for (const path of jupyter.sessions.keys()) if (containsPath(info.displayPath, path)) jupyter.sessions.delete(path);
  const targetDisplay = result.scope === 'active' ? result.path : info.displayPath;
  updateBrowserPaths(ref, result, info.displayPath, targetDisplay);
  if (affected) {
    if (result.scope === 'active') { clearCurrent(); await openNote(result.path + suffix); }
    else clearCurrent();
  }
  if (result.scope && result.scope !== 'active') $(''+result.scope+'-section').open = true;
  await refresh();
  if (sidebarWasOpen) document.body.classList.add('sidebar-open');
  if (!current || !affected) {
    const section = result.scope === 'active' ? 'tree' : result.scope === 'archive' ? 'archive-tree' : 'trash-tree';
    const trigger = [...$(section).querySelectorAll('.row-actions button')].find(b => b.closest('.sidebar-row')?.dataset.path === targetDisplay);
    (trigger || document.querySelector(`#${section === 'tree' ? 'archive' : section.replace('-tree', '')}-section summary`) || $('new-note')).focus();
  }
  return result;
}
async function sidebarAction(action, ref) {
  try {
    if (action !== 'pin' && (currentAffected(ref) || ['note', 'folder'].includes(action)) && !await flush()) return;
    if (action === 'pin') { tree = await api('/api/metadata', 'POST', { path: ref.path, pin: !tree.pins.includes(ref.path) }); renderSidebar(); renderWelcome(); [...$('tree').querySelectorAll('.sidebar-row')].find(row => row.dataset.path === ref.path)?.querySelector('.row-actions button')?.focus(); return; }
    if (['note', 'folder', 'move'].includes(action)) { await pathDialog(action, ref); return; }
    const info = await itemInfo(ref);
    if (action === 'trash' && !confirm(`Move “${title(info.displayPath)}” to Trash?${info.kind === 'folder' ? ` This includes ${info.noteCount} notebooks and ${info.fileCount} files.` : ''} You can restore it later.`)) return;
    if (action === 'purge' && !confirm(`Permanently delete “${title(info.displayPath)}”${info.kind === 'folder' ? ' and all its contents' : ''}? This cannot be undone.`)) return;
    if (action === 'restore') {
      try { await performTransfer(action, ref, info); }
      catch (error) { if (error.status === 409) await pathDialog('restore', ref, info); else throw error; }
    } else await performTransfer(action, ref, info);
  } catch (error) { notice(error.message); }
}
async function pathDialog(action, ref, info) {
  if ((!ref || currentAffected(ref) || ['note', 'folder'].includes(action)) && !await flush()) return;
  if (!ref && action === 'move') { if (!current || current.readOnly) return; ref = noteRef(current); }
  dialogAction = action; dialogRef = ref; dialogInfo = info || (action === 'move' ? await itemInfo(ref) : null); dialogReturn = document.activeElement;
  const parent = ref?.kind === 'folder' && ['note', 'folder'].includes(action) ? ref.path : current && !current.readOnly ? folder(current.path) : '';
  $('format-field').hidden = action !== 'note'; $('note-format').value = 'md';
  $('dialog-title').textContent = action === 'restore' ? 'Choose a restore destination' : action === 'move' ? `Rename or move ${ref.kind === 'folder' ? 'folder' : 'notebook'}` : action === 'folder' ? 'A new folder' : 'A fresh page';
  document.querySelector('label[for="path-input"]').textContent = action === 'folder' || ref?.kind === 'folder' && ['move', 'restore'].includes(action) ? 'Folder path' : 'Notebook path';
  $('path-input').value = ['move', 'restore'].includes(action) ? dialogInfo.displayPath : parent ? `${parent}/` : '';
  $('path-input').placeholder = action === 'folder' ? 'ideas/research' : action === 'note' ? 'ideas/a-new-thought' : 'ideas/a-new-thought.md';
  $('dialog-hint').textContent = action === 'restore' ? 'The original destination is occupied. Choose a new path; neither copy will be overwritten. Missing parent folders will be recreated.' : action === 'note' ? 'Use a path relative to Collections. The selected format adds the file extension automatically.' : 'Use a path relative to Collections. Notebook names must keep their .md or .ipynb extension.';
  $('dialog-error').textContent = ''; $('submit-dialog').textContent = action === 'restore' ? 'Restore' : action === 'move' ? 'Save changes' : 'Create'; $('path-dialog').showModal(); $('path-input').focus();
}
$('new-note').onclick = () => pathDialog('note'); $('welcome-new').onclick = () => pathDialog('note'); $('new-folder').onclick = () => pathDialog('folder');
function titleSource() {
  if (!isJupyter()) return { source: content() };
  const cell = jupyter.data.cells.find(cell => cell.cell_type === 'markdown' && notebookHeading(Array.isArray(cell.source) ? cell.source.join('') : cell.source || ''));
  return { cell, source: cell ? (Array.isArray(cell.source) ? cell.source.join('') : cell.source || '') : '' };
}
function updateNotebookTitle() {
  if (!current) return;
  const heading = notebookHeading(titleSource().source);
  const name = !isMarkdown() && !isJupyter() ? title(current.path) : heading?.title || '[Untitled]';
  $('note-title').textContent = name;
  $('note-title').setAttribute('role', current.readOnly ? 'heading' : 'button');
  $('note-title').setAttribute('aria-label', current.readOnly ? name : 'Edit notebook title');
  $('note-title').tabIndex = current.readOnly ? -1 : 0;
  $('note-title').title = current.readOnly ? '' : 'Click to edit notebook title';
  $('title-hint').hidden = !!heading?.title || (!isMarkdown() && !isJupyter());
  document.title = `${name} · Workbench`;
}
function editTitle() {
  if (!current || current.readOnly) return;
  if (!isMarkdown() && !isJupyter()) { pathDialog('move').catch(e => notice(e.message)); return; }
  if (isJupyter() && (jupyter.running || jupyter.starting)) { notice('Wait for the kernel operation to finish before editing the title.'); return; }
  $('title-input').value = notebookHeading(titleSource().source)?.title || '';
  $('title-dialog').showModal(); $('title-input').focus(); $('title-input').select();
}
$('note-title').onclick = editTitle;
$('note-title').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); editTitle(); } };
$('note-folder').onclick = () => pathDialog('move').catch(e => notice(e.message));
$('cancel-title').onclick = () => $('title-dialog').close();
$('title-dialog').addEventListener('close', () => $('note-title').focus());
$('title-form').onsubmit = e => {
  e.preventDefault();
  const name = $('title-input').value.trim(); if (!name || !current || current.readOnly) return;
  const { cell, source } = titleSource(), next = replaceNotebookHeading(source, name);
  if (isJupyter()) {
    if (cell) cell.source = next;
    else jupyter.data.cells.unshift({ id: crypto.randomUUID(), cell_type: 'markdown', metadata: {}, source: [next] });
    jupyter.update(); jupyter.draw();
  } else {
    const heading = notebookHeading(source);
    editor.dispatch({ changes: heading ? { from: heading.from, to: heading.to, insert: `# ${name}` } : { from: 0, insert: `# ${name}\n\n` } });
  }
  $('title-dialog').close();
};
$('restore-current').onclick = () => sidebarAction('restore', noteRef(current));
$('empty-trash').onclick = async () => {
  if (!await flush() || !confirm('Permanently delete everything in Trash? This cannot be undone.')) return;
  try { await api('/api/trash/empty', 'POST', {}); for (const key of Object.keys(localStorage)) if (key.startsWith('stored:trash:')) localStorage.removeItem(key); if (current?.scope === 'trash') clearCurrent(); await refresh(); } catch (e) { notice(e.message); }
};
$('note-format').onchange = () => { const extension = $('note-format').value; $('path-input').placeholder = 'ideas/a-new-thought'; if (/\.(md|ipynb)$/i.test($('path-input').value)) $('path-input').value = $('path-input').value.replace(/\.(md|ipynb)$/i, `.${extension}`); };
$('cancel-dialog').onclick = () => $('path-dialog').close();
$('path-dialog').addEventListener('close', () => { if (dialogReturn?.isConnected) dialogReturn.focus(); else $('new-note').focus(); });
$('path-form').onsubmit = async e => {
  e.preventDefault(); let path = $('path-input').value.trim();
  if (dialogAction === 'note' && path) path = path.replace(/\.(md|ipynb)$/i, '') + `.${$('note-format').value}`; $('submit-dialog').disabled = true;
  try {
    let note;
    if (['move', 'restore'].includes(dialogAction)) { await performTransfer(dialogAction, dialogRef, dialogInfo, path); }
    else if (dialogAction === 'folder') await api('/api/folder', 'POST', { path });
    else { const content = /\.ipynb$/i.test(path) ? JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } }, cells: [{ id: crypto.randomUUID(), cell_type: 'code', metadata: {}, source: [], outputs: [], execution_count: null }] }, null, 1) + '\n' : `# ${title(path)}\n\n`; note = await api('/api/note', 'POST', { path, content }); }
    $('path-dialog').close(); await refresh(); if (note) await openNote(note.path);
  } catch (error) { $('dialog-error').textContent = error.message; } finally { $('submit-dialog').disabled = false; }
};
const isMac = /Mac|iPhone|iPad/.test(navigator.platform), shortcut = isMac ? '⌘' : 'Ctrl+';
function updateSidebarControls() {
  const open = matchMedia('(max-width: 760px)').matches ? document.body.classList.contains('sidebar-open') : !document.body.classList.contains('sidebar-collapsed');
  for (const id of ['toggle-sidebar', 'collapse-sidebar']) { $(id).setAttribute('aria-expanded', String(open)); $(id).title = `${id === 'collapse-sidebar' ? 'Collapse' : 'Expand'} sidebar (${shortcut}B)`; $(id).setAttribute('aria-keyshortcuts', `${isMac ? 'Meta' : 'Control'}+B`); }
}
function toggleSidebar() { if (matchMedia('(max-width: 760px)').matches) document.body.classList.toggle('sidebar-open'); else document.body.classList.toggle('sidebar-collapsed'); updateSidebarControls(); }
$('toggle-sidebar').onclick = toggleSidebar; $('collapse-sidebar').onclick = toggleSidebar; $('sidebar-backdrop').onclick = () => { document.body.classList.remove('sidebar-open'); updateSidebarControls(); };
$('toggle-terminal').title = `Terminal (${shortcut}J)`; $('toggle-terminal').setAttribute('aria-keyshortcuts', `${isMac ? 'Meta' : 'Control'}+J`);
matchMedia('(max-width: 760px)').addEventListener('change', updateSidebarControls); updateSidebarControls();
document.addEventListener('keydown', event => {
  const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier || event.altKey || event.shiftKey || !['b', 'j'].includes(event.key.toLowerCase())) return;
  event.preventDefault(); event.stopImmediatePropagation(); if (event.repeat) return;
  if (event.key.toLowerCase() === 'b') toggleSidebar(); else if (!$('path-dialog').open) workspaceTerminal.toggle();
}, true);
document.addEventListener('keydown', e => { if (e.target.closest?.('#terminal-panel')) return; if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); (screen === 'calendar-workspace' ? (calendar.parent.querySelector('form') ? Promise.resolve(calendar.parent.querySelector('form').requestSubmit()) : calendar.save()) : screen === 'daily-workspace' ? daily.save() : screen === 'students-workspace' ? students.save() : save()).catch(error => notice(error.message)); } if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); launchSearch(); } if (e.key === 'Escape' && screen === 'search-view' && !$('path-dialog').open) { if (current) setScreen('notebook'); else home(); } });
window.addEventListener('beforeunload', e => { if (calendar.dirty || calendar.formDirty || daily.dirty || students.dirty || dirty() || jupyter.running || jupyter.starting) { cacheDraft(); e.preventDefault(); e.returnValue = ''; } });
let checkingExternal = false;
async function checkExternal() {
  if (checkingExternal || navigating || jupyter.running || jupyter.starting) return;
  checkingExternal = true;
  const observed = current;
  try {
    await refresh();
    if (!current || saving || screen !== 'notebook') return;
    const latest = await api(`/api/note?${refQuery(noteRef(current))}`);
    if (current !== observed || navigating || saving || latest.revision === current.revision) return;
    if (dirty()) {
      clearTimeout(saveTimer); conflict = blocked = true; cacheDraft();
      $('conflict').hidden = false; saveLabel('Conflict · draft preserved', 'error');
    } else {
      showNote({ ...latest, ...(current.duplicate ? { duplicate: true, readOnly: true } : {}) });
    }
  } catch (e) { notice(e.message); }
  finally { checkingExternal = false; }
}
window.addEventListener('focus', checkExternal);
setInterval(() => {
  if (!document.hidden) checkExternal();
  tabs.refreshPresence();
}, 3000);
window.addEventListener('pagehide', () => tabs.release());
window.addEventListener('pageshow', async e => {
  if (!e.persisted || !current || current.readOnly) return;
  navigating = true;
  try {
    if (!await tabs.acquire(current.path)) {
      const latest = await api(`/api/note?${refQuery(noteRef(current))}`);
      showNote({ ...latest, duplicate: true, readOnly: true });
    }
  } catch (error) { notice(error.message); }
  finally { navigating = false; }
});
window.addEventListener('popstate', async () => {
  const params = new URLSearchParams(location.search);
  if (params.get('view') === 'calendar') await openCalendar(params.get('date') || undefined, false);
  else if (params.get('view') === 'daily') await openDaily(params.get('date') || undefined, params.get('task'), false);
  else if (params.get('view') === 'students' || params.get('view') === 'student') await openStudents(params.get('view') === 'student' ? params.get('id') : undefined, false);
  else if (params.has('path')) await openReference(Object.fromEntries(params)); else await home();
  // A failed save can refuse navigation; keep the URL attached to the preserved draft.
  if (screen === 'calendar-workspace') history.replaceState(null, '', calendar.url);
  else if (screen === 'daily-workspace') history.replaceState(null, '', daily.url);
  else if (screen === 'students-workspace') history.replaceState(null, '', students.url);
  else if (current) history.replaceState(null, '', notebookUrl(noteRef(current)));
});
$('claim-notebook').onclick = () => openReference(noteRef(current));
$('focus-notebook').onclick = () => {
  if (!tabs.focus(current.path)) notice('The editing tab was opened separately, so this browser cannot activate it from here. Switch to it using the browser tab bar.');
};
$('compare-note').onclick = async () => {
  try {
    const latest = await api(`/api/note?${refQuery(noteRef(current))}`);
    $('compare-draft').textContent = comparisonText(content(), current.path);
    $('compare-disk').textContent = comparisonText(latest.content, current.path);
    $('compare-dialog').showModal();
  } catch (e) { notice(e.message); }
};
$('save-copy').onclick = async () => {
  const path = prompt('Save your draft as a new notebook:', current.path.replace(/(\.(md|ipynb))$/i, ' (draft)$1'));
  if (!path) return;
  try {
    await api('/api/note', 'POST', { path, content: content() });
    notice(`Draft saved separately as ${path}. The original conflict is still preserved.`);
    await refresh();
  } catch (e) { notice(e.message); }
};
setMode(mode); refresh().then(() => { const params = new URLSearchParams(location.search); if (params.get('view') === 'calendar') return openCalendar(params.get('date') || undefined, false); if (params.get('view') === 'daily') return openDaily(params.get('date') || undefined, params.get('task'), false); if (params.get('view') === 'students' || params.get('view') === 'student') return openStudents(params.get('view') === 'student' ? params.get('id') : undefined, false); if (params.has('path')) return openReference(Object.fromEntries(params)); }).catch(e => notice(`Could not load your collection: ${e.message}`));
