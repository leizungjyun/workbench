import { checkConversation } from '../timetable-model.js';
import { localDate, shiftDate, validDate, newTask, updateTask, visibleTasks, stateAt, validateDaily, normalizeDaily } from '../daily-model.js';
import { renderMarkdown } from './render.js';
import './daily.css';
import { DailyCardLayout } from './daily-layout.js';
const el = (tag, text = '', cls = '') => { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; };
const clone = value => structuredClone(value);
function download(value, name, plain = false) { const url = URL.createObjectURL(new Blob([plain ? value : JSON.stringify(value, null, 2)], { type: plain ? 'text/markdown' : 'application/json' })); const a = el('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
export class DailyWorkspace {
  constructor({ parent, api, notice, prepare, enter, navigate }) {
    Object.assign(this, { parent, api, notice, prepare, enter, navigate }); this.expanded = new Set();
    window.addEventListener('pagehide', () => { this.cache(); this.release(); });
    window.addEventListener('pageshow', e => { if (e.persisted && this.data) this.claim(); });
    window.addEventListener('focus', () => this.checkExternal());
    this.interval = setInterval(() => { if (!document.hidden) this.checkExternal(); }, 3000);
  }
  get url() { return `?view=daily&date=${this.date}${this.focusId ? `&task=${this.focusId}` : ''}`; }
  get dirty() { return !!this.data && !this.readOnly && JSON.stringify(this.data) !== this.saved; }
  draftKey() { return 'fieldnotes-daily-draft'; }
  cache() { if (!this.data || this.readOnly) return; try { if (this.dirty) localStorage.setItem(this.draftKey(), JSON.stringify({ document: this.data, revision: this.revision })); else localStorage.removeItem(this.draftKey()); } catch { /* Disk saving remains available. */ } }
  release() { this.unlock?.(); this.unlock = null; }
  async acquire() {
    if (this.unlock) return true;
    if (!navigator.locks) return false;
    return new Promise((resolve, reject) => navigator.locks.request('fieldnotes:daily', { ifAvailable: true }, async lock => { if (!lock) { resolve(false); return; } const held = new Promise(done => { this.unlock = done; }); resolve(true); await held; }).catch(reject));
  }
  close() { this.cardLayout?.destroy(); this.cardLayout = null; clearTimeout(this.timer); this.cache(); this.release(); this.data = null; this.saved = ''; this.undo = null; this.status = null; this.expanded.clear(); }
  load(result, recover = false) {
    this.data = normalizeDaily(clone(result.document)); this.saved = JSON.stringify(this.data); this.revision = result.revision; this.savedAt = result.savedAt; this.blocked = this.conflict = false;
    if (recover && !this.readOnly) try {
      const draft = JSON.parse(localStorage.getItem(this.draftKey()));
      if (draft?.document?.id === this.data.id) {
        validateDaily(draft.document); const recovered = normalizeDaily(draft.document);
        if (JSON.stringify(recovered) !== this.saved) { this.data = recovered; this.blocked = true; this.conflict = draft.revision !== result.revision; this.notice('Recovered your Daily draft. Review it and retry save or resolve the conflict.'); }
      }
    } catch { this.notice('The Daily browser draft could not be read. Disk data is preserved.'); }
  }
  async open(date = localDate(), taskId, push = true) {
    let opened = false;
    const controls = [...this.parent.querySelectorAll('button, input, select, textarea')].map(node => [node, node.disabled]);
    this.parent.inert = true; controls.forEach(([node]) => { node.disabled = true; });
    try {
      if (!validDate(date)) throw new Error('Choose a valid calendar date.');
      if (!await this.prepare()) return false;
      await this.api('/api/daily'); const [roster, records, academic, calendar] = await Promise.all([this.api('/api/students'), this.api('/api/students/export'), this.api('/api/timetables'), this.api('/api/calendar')]);
      this.studentDocuments = records.students; this.academic = academic.document; this.calendar = calendar.document;
      await this.enter(); clearTimeout(this.timer); this.undo = null; this.expanded.clear(); this.readOnly = !await this.acquire();
      // Acquire before reading again: a previous owner may have saved while we were opening.
      this.load(await this.api('/api/daily'), true); this.roster = roster.students; this.date = date; this.focusId = taskId; this.followToday = date === localDate();
      if (taskId) this.expanded.add(taskId); this.render();
      if (push && location.search !== this.url) history.pushState(null, '', this.url);
      document.title = `Daily · ${date} · Workbench`; opened = true; return true;
    } catch (e) { this.notice(e.message); return false; }
    finally { controls.forEach(([node, disabled]) => { if (node.isConnected) node.disabled = disabled; }); this.parent.inert = false; if (opened) this.focusTask(); }
  }
  focusTask() { if (this.focusId) { const target = [...this.parent.querySelectorAll('[data-task]')].find(n => n.dataset.task === this.focusId); target?.scrollIntoView({ block: 'center' }); target?.classList.add('daily-target'); target?.querySelector('input[type=text]')?.focus(); } }
  async flush() { try { await this.save(); return !this.dirty && !this.conflict; } catch (e) { this.notice(e.message); return false; } }
  changed() { this.updateDayPreview(); this.cache(); clearTimeout(this.timer); this.updateStatus(); if (!this.blocked && this.dirty) this.timer = setTimeout(() => this.save().catch(() => {}), 750); }
  async save() {
    clearTimeout(this.timer); if (this.saving) { await this.saving; return this.save(); }
    if (this.conflict) throw new Error('Resolve the Daily disk conflict before saving or leaving.');
    if (!this.dirty) { this.blocked = false; this.updateStatus(); return; }
    const document = clone(this.data), revision = this.revision;
    this.saving = (async () => {
      try { const result = await this.api('/api/daily', 'PUT', { document, revision }); this.saved = JSON.stringify(document); this.revision = result.revision; this.savedAt = result.savedAt; this.blocked = false; this.cache(); }
      catch (e) { this.blocked = true; this.conflict = e.status === 409; this.cache(); this.notice(e.message); throw e; }
      finally { this.saving = null; this.updateStatus(); }
    })(); this.updateStatus(); await this.saving;
    if (this.dirty) this.timer = setTimeout(() => this.save().catch(() => {}), 750);
  }
  async checkExternal() {
    if (!this.data || this.parent.inert || this.checking || this.saving || this.parent.querySelector('dialog[open]')) return;
    this.checking = true; const observed = this.data;
    try {
      const latest = await this.api('/api/daily'); if (this.data !== observed || this.saving) return;
      if (latest.revision !== this.revision) {
        if (this.dirty) { clearTimeout(this.timer); this.blocked = this.conflict = true; this.cache(); this.updateStatus(); }
        else { this.load(latest); this.render(); }
      }
      if (this.followToday && this.date !== localDate() && await this.flush()) { this.date = localDate(); this.focusId = null; history.replaceState(null, '', this.url); this.render(); }
    } catch (e) { this.notice(e.message); } finally { this.checking = false; }
  }
  async claim() {
    if (this.claiming) return; this.claiming = true; this.parent.inert = true;
    try { if (this.saving) await this.saving.catch(() => {}); this.cache(); this.readOnly = !await this.acquire(); this.load(await this.api('/api/daily'), true); this.render(); }
    finally { this.claiming = false; this.parent.inert = false; }
  }
  button(label, action, mutation = false) { const b = el('button', label); b.type = 'button'; b.disabled = mutation && this.readOnly; b.onclick = () => Promise.resolve().then(action).catch(e => this.notice(e.message)); return b; }
  field(label, value, change, type = 'text') {
    const wrap = el('label', '', 'daily-field'); wrap.append(el('span', label)); const input = el('input'); input.type = type; input.value = value; input.setAttribute('aria-label', label); input.disabled = this.readOnly;
    input.oninput = () => { if (input.validity.valid) { change(input.value); this.changed(); } }; wrap.append(input); return wrap;
  }
  select(label, value, choices, change) {
    const wrap = el('label', '', 'daily-field'); wrap.append(el('span', label)); const input = el('select'); input.setAttribute('aria-label', label); input.disabled = this.readOnly;
    for (const [id, name] of choices) { const option = el('option', name); option.value = id; input.append(option); } input.value = value; input.onchange = () => { change(input.value); this.changed(); }; wrap.append(input); return wrap;
  }
  formatted(label, value, change) {
    const wrap = el('section', '', 'daily-formatted'); const toggle = this.button(`Edit ${label.toLowerCase()}`, () => { editor.hidden = !editor.hidden; preview.hidden = !editor.hidden; toggle.textContent = editor.hidden ? `Edit ${label.toLowerCase()}` : 'Done editing'; }); toggle.disabled = this.readOnly;
    const heading = el('div', '', 'daily-section-heading'); heading.append(el('h3', label), toggle); const preview = el('div', '', 'daily-prose'); if (value) renderMarkdown(preview, value); else preview.append(el('p', 'No notes yet.', 'daily-muted'));
    const editor = el('div'); editor.hidden = true; const textarea = el('textarea'); textarea.value = value; textarea.setAttribute('aria-label', label); textarea.disabled = this.readOnly;
    textarea.oninput = () => { change(textarea.value); this.changed(); renderMarkdown(preview, textarea.value); };
    const toolbar = el('div', '', 'daily-actions'); toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', `${label} formatting`);
    for (const [name, before, after] of [['Bold', '**', '**'], ['Italic', '*', '*'], ['Link', '[', '](https://example.com)'], ['Bullet list', '- ', '']]) toolbar.append(this.button(name, () => { const start = textarea.selectionStart, end = textarea.selectionEnd; textarea.setRangeText(before + textarea.value.slice(start, end) + after, start, end, 'select'); textarea.oninput(); textarea.focus(); }, true));
    editor.append(toolbar, textarea); wrap.append(heading, preview, editor); return wrap;
  }
  updateStatus() {
    if (!this.status) return;
    this.status.textContent = this.readOnly ? 'Read-only · another tab may be editing Daily' : this.conflict ? 'Conflict · draft preserved' : this.saving ? 'Saving…' : this.blocked ? 'Save failed · draft preserved' : this.dirty ? 'Unsaved changes' : `Saved to disk · ${new Date(this.savedAt).toLocaleString()}`;
    this.conflictBar.hidden = !this.conflict;
  }
  patch(task, patch) { updateTask(task, this.date, patch); this.changed(); }
  transition(task, patch) { this.undo = { id: task.id, versions: clone(task.versions) }; this.patch(task, patch); if (patch.status === 'cancelled') { this.focusId = null; history.replaceState(null, '', this.url); } this.render(); }
  render() {
    this.cardLayout?.destroy();
    const head = el('header', '', 'daily-heading'); head.append(el('div', 'DAILY · 日常', 'eyebrow'), el('h1', this.date));
    const nav = el('div', '', 'daily-actions'); nav.append(this.button('Previous day', () => this.navigate(shiftDate(this.date, -1))), this.button('Today', () => this.navigate(localDate())), this.button('Next day', () => this.navigate(shiftDate(this.date, 1))));
    const calendar = el('input'); calendar.type = 'date'; calendar.value = this.date; calendar.setAttribute('aria-label', 'Daily date'); calendar.onchange = async () => { if (validDate(calendar.value) && !await this.navigate(calendar.value)) calendar.value = this.date; }; nav.append(calendar);
    nav.append(this.button('Categories', () => this.categories(), true), this.button('Import from Markdown', () => this.importLog(), true), this.button('Export JSON', async () => { if (await this.flush()) download(await this.api('/api/daily/export'), 'workbench-daily.json'); }), this.button('Export Markdown', async () => { if (await this.flush()) download((await this.api('/api/daily/export?format=markdown')).content, 'workbench-daily.md', true); })); head.append(nav);
    this.status = el('span'); this.status.setAttribute('role', 'status'); const statusRow = el('div', '', 'daily-actions daily-status'); statusRow.append(this.status, this.button('Retry save', () => this.save(), true), this.button('Export draft', () => download({ document: this.data, revision: this.revision }, 'workbench-daily-draft.json')));
    if (this.readOnly) statusRow.append(this.button('Claim editing', () => this.claim()));
    this.conflictBar = el('div', '', 'daily-conflict'); this.conflictBar.append(el('p', 'Your draft is preserved. Compare it with disk before choosing which version to keep.'), this.button('Compare', () => this.compare()), this.button('Reload disk version', async () => { if (!confirm('Discard the Daily draft and load the disk version?')) return; const latest = await this.api('/api/daily'); localStorage.removeItem(this.draftKey()); this.load(latest); this.undo = null; this.render(); }, true), this.button('Overwrite with draft', async () => this.compare(true), true));
    const body = el('div', '', 'daily-groups'); const rows = this.dayRows();
    const categories = this.data.categories.filter(c => !c.hidden || rows.some(r => r.state.categoryId === c.id));
    for (const category of categories) {
      const section = el('section', '', 'daily-group'); section.append(el('h2', category.name));
      for (const row of rows.filter(r => r.state.categoryId === category.id)) section.append(this.taskRow(row));
      if (!category.hidden) {
        const input = el('input', '', 'daily-add'); input.placeholder = 'Add a task…'; input.setAttribute('aria-label', `Add task to ${category.name}`); input.disabled = this.readOnly;
        input.onkeydown = e => { if (e.key === 'Enter' && input.value.trim()) { e.preventDefault(); this.data.tasks.push(newTask(crypto.randomUUID(), this.date, input.value, category.id)); this.changed(); this.render(); [...this.parent.querySelectorAll('.daily-add')].find(n => n.getAttribute('aria-label') === input.getAttribute('aria-label'))?.focus(); } }; section.append(input);
      }
      body.append(section);
    }
    const notes = this.formatted('Daily notes', this.data.days[this.date]?.notes || '', value => { this.data.days[this.date] = { notes: value }; });
    this.parent.replaceChildren(head, statusRow, this.conflictBar);
    if (this.undo) this.parent.append(this.button('Undo task change', () => { const task = this.data.tasks.find(t => t.id === this.undo.id); if (task) task.versions = this.undo.versions; this.undo = null; this.changed(); this.render(); }, true));
    const layout = el('div', '', 'daily-layout'), editor = el('div', '', 'daily-editor');
    this.dayPreview = el('aside', '', 'daily-day-preview'); this.dayPreview.setAttribute('aria-label', 'Day preview');
    editor.append(notes, body); layout.append(editor, this.dayPreview); this.parent.append(layout);
    const inactive = this.data.tasks.filter(t => { const state = t.versions.filter(v => v.date <= this.date).at(-1); return state && state.status !== 'open' && !rows.some(r => r.task.id === t.id); });
    if (inactive.length) {
      const archive = el('details', '', 'daily-archive'); archive.append(el('summary', `Finished tasks (${inactive.length})`));
      for (const task of inactive) { const state = task.versions.filter(v => v.date <= this.date).at(-1); const line = el('div', '', 'daily-actions'); line.append(el('span', `${state.text} · ${state.status} ${state.date}`), this.button('View record', () => this.navigate(state.date, task.id)), this.button('Reopen today', () => this.transition(task, { status: 'open', scheduledDate: this.date }), true)); archive.append(line); }
      editor.append(archive);
    }
    this.cardLayout = new DailyCardLayout(body);
    this.updateDayPreview(); this.updateStatus();
  }
  dayRows() {
    const rows = visibleTasks(this.data, this.date).filter(row => row.state.status !== 'cancelled');
    // A search/history link can still open a removed task's dated record.
    if (this.focusId && !rows.some(row => row.task.id === this.focusId)) {
      const task = this.data.tasks.find(task => task.id === this.focusId), state = task && stateAt(task, this.date);
      if (state) rows.push({ task, state });
    }
    // Stable partition: preserve the existing order within each status group.
    return rows.sort((a, b) => Number(a.state.status === 'completed') - Number(b.state.status === 'completed'));
  }
  updateDayPreview() {
    if (!this.data || !this.dayPreview?.isConnected) return;
    const rows = this.dayRows().filter(row => row.state.status !== 'cancelled');
    this.dayPreview.replaceChildren(el('h2', 'Day preview'), el('p', this.date, 'daily-muted'), el('p', `${rows.filter(row => row.state.status === 'completed').length} / ${rows.length} completed`, 'daily-preview-progress'));
    const notes = this.data.days[this.date]?.notes;
    if (notes) { const section = el('section'); section.append(el('h3', 'Daily notes')); const rich = el('div', '', 'daily-preview-rich'); renderMarkdown(rich, notes); section.append(rich); this.dayPreview.append(section); }
    for (const category of this.data.categories) {
      const items = rows.filter(row => row.state.categoryId === category.id); if (!items.length) continue;
      const section = el('section', '', 'daily-preview-category'); section.append(el('h3', category.name));
      for (const { task, state } of items) {
        const item = el('article', '', `daily-preview-task ${state.status}`);
        const title = el('p', '', 'daily-preview-title'); title.append(el('span', state.status === 'completed' ? '✓ ' : '○ '), el('span', state.text)); item.append(title);
        const metadata = [state.time, state.deadline && `Due ${state.deadline}`, state.scheduledDate > this.date && `Scheduled ${state.scheduledDate}`, task.originDate < this.date && `From ${task.originDate}`, state.studentId && (this.roster.find(student => student.id === state.studentId)?.name || 'Linked student')].filter(Boolean);
        if (metadata.length) item.append(el('p', metadata.join(' · '), 'daily-muted'));
        if (state.details) { const rich = el('div', '', 'daily-preview-rich'); renderMarkdown(rich, state.details); item.append(rich); }
        for (const subtask of state.subtasks) item.append(el('p', `${subtask.done ? '✓' : '○'} ${subtask.text}`, 'daily-preview-subtask'));
        section.append(item);
      }
      this.dayPreview.append(section);
    }
    if (!rows.length) this.dayPreview.append(el('p', 'No tasks for this day.', 'daily-muted'));
  }
  taskRow({ task, state }) {
    const row = el('article', '', `daily-task ${state.status}`); row.dataset.task = task.id;
    const top = el('div', '', 'daily-task-line'); const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.checked = state.status === 'completed'; checkbox.disabled = this.readOnly; checkbox.setAttribute('aria-label', `Complete ${state.text}`); checkbox.onchange = () => this.transition(task, { status: checkbox.checked ? 'completed' : 'open', scheduledDate: this.date });
    const title = this.field('Task', state.text, value => { if (value.trim()) { this.patch(task, { text: value }); checkbox.setAttribute('aria-label', `Complete ${value}`); } }); title.classList.add('daily-task-title'); top.append(checkbox, title, this.button(this.expanded.has(task.id) ? 'Hide details' : 'Details', () => { if (this.expanded.has(task.id)) this.expanded.delete(task.id); else this.expanded.add(task.id); this.render(); }), this.button('Remove', () => this.transition(task, { status: 'cancelled', scheduledDate: this.date }), true)); row.append(top);
    const latest = task.versions.at(-1); const meta = el('div', '', 'daily-muted');
    meta.textContent = `${task.originDate < this.date ? `From ${task.originDate} · ` : ''}${state.status}${state.scheduledDate > this.date ? ` · Scheduled ${state.scheduledDate}` : ''}${state.time ? ` · ${state.time}` : ''}${state.deadline ? ` · Due ${state.deadline}` : ''}${latest.date > this.date ? ` · Later ${latest.status} on ${latest.date}` : ''}`; row.append(meta);
    const event = this.calendar?.events.find(e => e.id === task.id && e.studentId);
    if (event) {
      const student = this.studentDocuments.find(s => s.id === event.studentId);
      if (student) { const checked = checkConversation(event, student, this.academic, this.calendar.events);
        if (checked.incomplete) row.append(el('p', 'Conversation availability incomplete', 'timetable-warning'));
        for (const conflict of checked.conflicts) row.append(el('p', `Conversation conflict: ${conflict.title}`, 'timetable-warning'));
      } else row.append(el('p', 'Conversation student unavailable', 'timetable-warning'));
      const link = el('a', 'Reschedule in Calendar'); link.href = `?view=calendar&date=${state.scheduledDate}&event=${event.id}`; link.onclick = async e => { e.preventDefault(); if (await this.flush()) location.href = link.href; }; row.append(link);
    }
    if (this.expanded.has(task.id)) {
      const details = el('div', '', 'daily-task-details'); const fields = el('div', '', 'daily-fields');
      fields.append(this.select('Category', state.categoryId, this.data.categories.map(c => [c.id, c.name]), value => { this.patch(task, { categoryId: value }); this.render(); }), this.field('Time', state.time, value => this.patch(task, { time: value }), 'time'), this.field('Deadline', state.deadline, value => this.patch(task, { deadline: value }), 'date'), this.select('Student', state.studentId, [['', 'No student'], ...this.roster.map(s => [s.id, s.name]), ...(!this.roster.some(s => s.id === state.studentId) && state.studentId ? [[state.studentId, 'Unavailable student']] : [])], value => { this.patch(task, { studentId: value }); this.render(); }));
      if (task.calendarEvent) { for (const label of ['Time', 'Student']) fields.querySelector(`[aria-label="${label}"]`).disabled = true; }
      details.append(fields, el('p', task.calendarEvent ? 'This task follows Calendar. Change its time and student in Calendar.' : 'Task times stay in Daily; they do not create Calendar events or reminders.', 'daily-muted')); if (state.studentId) { const link = el('a', 'Open student'); link.href = `?view=student&id=${state.studentId}`; link.onclick = async e => { e.preventDefault(); if (await this.flush()) location.href = link.href; }; details.append(link); }
      details.append(this.formatted('Task notes', state.details, value => this.patch(task, { details: value })));
      const subs = el('div'); subs.append(el('h3', 'Subtasks'));
      for (const sub of state.subtasks) {
        const line = el('div', '', 'daily-subtask'); const box = el('input'); box.type = 'checkbox'; box.checked = sub.done; box.disabled = this.readOnly; box.setAttribute('aria-label', `Complete subtask ${sub.text}`);
        const change = patch => { const current = task.versions.filter(v => v.date <= this.date).at(-1); this.patch(task, { subtasks: current.subtasks.map(s => s.id === sub.id ? { ...s, ...patch } : s) }); };
        box.onchange = () => change({ done: box.checked }); line.append(box, this.field('Subtask', sub.text, value => { if (value.trim()) change({ text: value }); })); subs.append(line);
      }
      const add = el('input', '', 'daily-add'); add.placeholder = 'Add a subtask…'; add.setAttribute('aria-label', 'Add subtask'); add.disabled = this.readOnly;
      add.onkeydown = e => { if (e.key === 'Enter' && add.value.trim()) { e.preventDefault(); const current = task.versions.filter(v => v.date <= this.date).at(-1); this.patch(task, { subtasks: [...current.subtasks, { id: crypto.randomUUID(), text: add.value.trim(), done: false }] }); this.render(); } }; subs.append(add); details.append(subs);
      const actions = el('div', '', 'daily-actions'); let scheduled = '';
      const schedule = this.field('Reschedule to', '', value => { scheduled = value; }, 'date'); actions.append(schedule, this.button('Reschedule', () => { if (!validDate(scheduled) || scheduled < this.date) throw new Error('Choose this day or a later date.'); this.transition(task, { scheduledDate: scheduled, status: 'open' }); }, true), this.button(state.status === 'cancelled' ? 'Reopen task' : 'Cancel task', () => this.transition(task, { status: state.status === 'cancelled' ? 'open' : 'cancelled', scheduledDate: this.date }), true));
      if (state.status === 'completed') actions.append(this.button('Reopen task', () => this.transition(task, { status: 'open', scheduledDate: this.date }), true));
      const history = el('details'); history.append(el('summary', 'Task history'));
      for (const v of task.versions) { const link = el('a', `${v.date} · ${v.status}${v.scheduledDate > v.date ? ` · Scheduled ${v.scheduledDate}` : ''}`); link.href = `?view=daily&date=${v.date}&task=${task.id}`; link.onclick = e => { e.preventDefault(); this.navigate(v.date, task.id); }; history.append(link); }
      details.append(actions, history); row.append(details);
    }
    return row;
  }
  dialog(title) { const dialog = el('dialog', '', 'daily-dialog'); dialog.append(el('h2', title)); const close = this.button('Close', () => dialog.close()); dialog.append(close); this.parent.append(dialog); dialog.addEventListener('close', () => dialog.remove()); dialog.showModal(); return dialog; }
  categories() {
    const dialog = this.dialog('Categories'); const list = el('div');
    const draw = () => {
      list.replaceChildren(); this.data.categories.forEach((c, index) => {
        const row = el('div', '', 'daily-category'); row.append(this.field('Category name', c.name, value => { if (value.trim()) c.name = value.trim(); }));
        row.append(this.button(c.hidden ? 'Show' : 'Hide', () => { c.hidden = !c.hidden; this.changed(); draw(); }, true), this.button('Move up', () => { if (!index) return; [this.data.categories[index - 1], this.data.categories[index]] = [c, this.data.categories[index - 1]]; this.changed(); draw(); }, true), this.button('Move down', () => { if (index === this.data.categories.length - 1) return; [this.data.categories[index + 1], this.data.categories[index]] = [c, this.data.categories[index + 1]]; this.changed(); draw(); }, true)); list.append(row);
      });
    }; draw(); const add = el('input'); add.setAttribute('aria-label', 'New category'); add.placeholder = 'New category'; dialog.append(list, add, this.button('Add category', () => { if (!add.value.trim()) return; this.data.categories.push({ id: crypto.randomUUID(), name: add.value.trim(), hidden: false }); add.value = ''; this.changed(); draw(); }, true)); dialog.addEventListener('close', () => this.render());
  }
  async compare(overwrite = false) {
    const latest = await this.api('/api/daily'); const dialog = this.dialog('Daily disk conflict'); const columns = el('div', '', 'daily-compare');
    for (const [label, value] of [['Your draft', this.data], ['Disk version', latest.document]]) { const section = el('section'); section.append(el('h3', label), el('pre', JSON.stringify(value, null, 2))); columns.append(section); } dialog.append(columns);
    if (overwrite) dialog.append(this.button('Replace reviewed disk version', async () => { if (!confirm('Replace this reviewed disk version with your draft?')) return; this.revision = latest.revision; this.conflict = false; this.blocked = false; dialog.close(); await this.save(); }, true));
  }
  async importLog() {
    if (!await this.flush()) return;
    const dialog = this.dialog('Import from Markdown');
    const tree = await this.api('/api/tree'); let source = tree.dailyImport?.source || tree.notes.find(n => /\.md$/i.test(n.path))?.path || '';
    let from = tree.dailyImport?.from || this.date, to = tree.dailyImport?.to || this.date;
    const sourceField = el('select'); sourceField.setAttribute('aria-label', 'Source Markdown notebook');
    for (const note of tree.notes.filter(n => /\.md$/i.test(n.path))) { const option = el('option', note.path); option.value = note.path; sourceField.append(option); } sourceField.value = source;
    sourceField.onchange = () => { source = sourceField.value; results.replaceChildren(); };
    const results = el('div');
    dialog.append(sourceField, this.field('From date', from, value => { from = value; results.replaceChildren(); }, 'date'), this.field('Through date', to, value => { to = value; results.replaceChildren(); }, 'date'));
    dialog.append(this.button('Review import', async () => {
      results.replaceChildren();
      try {
        const preview = await this.api('/api/daily/import-preview?' + new URLSearchParams({ source, from, to }));
        results.append(el('p', `${preview.dates.join(', ') || 'No new dates'} · ${preview.taskCount} tasks. Plain bullets remain notes. The source is preserved.`));
        const content = el('div', '', 'daily-prose'); renderMarkdown(content, preview.content); results.append(content);
        if (preview.dates.length) results.append(this.button('Apply import', async () => { const result = await this.api('/api/daily/import-apply', 'POST', { source, from, to, revision: preview.revision, sourceRevision: preview.sourceRevision }); dialog.close(); this.load(result); this.undo = null; this.render(); }, true));
      } catch (error) { results.append(el('p', error.message)); }
    }, true), results);

  }
}
