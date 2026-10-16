import { StudentMarkdown } from './student-markdown.js';
import { timetablePanel } from './timetables.js';
import { Editor, generateHTML } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { emptyText, richText, profileFields, validateStudent, currentStage } from '../student-model.js';
import './students.css';
const el = (tag, value = '', cls = '') => { const n = document.createElement(tag); n.textContent = value; if (cls) n.className = cls; return n; };
const clone = value => structuredClone(value);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const download = (value, name) => { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const a = el('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
const labels = { name: 'Name', dob: 'Date of birth', gkPlace: 'GK place (高考地)', email: 'Email', researchAreas: 'Research areas', program: 'Degree / program', entryYear: 'Entry year', schoolId: 'School' };
export class StudentWorkspace {
  constructor({ parent, api, notice, prepare, enter, navigate, schedule }) {
    Object.assign(this, { parent, api, notice, prepare, enter, navigate, schedule });
    this.editingSections = new Set(); this.editors = []; this.openSessions = new Set(); this.historyQuery = ''; this.filter = 'active'; this.rosterQuery = ''; this.blocked = false;
    window.addEventListener('pagehide', () => this.release());
    window.addEventListener('pageshow', e => { if (e.persisted && this.data) this.reclaim(); });
    window.addEventListener('focus', () => this.checkExternal());
    this.interval = setInterval(() => { if (!document.hidden) this.checkExternal(); }, 3000);
  }
  get url() { return this.data ? `?view=student&id=${this.data.id}` : '?view=students'; }
  get dirty() { return !!this.data && !this.readOnly && JSON.stringify(this.data) !== this.saved; }
  draftKey() { return `student-draft:${this.data.id}`; }
  cache() { if (!this.data || this.readOnly) return; try { if (this.dirty) localStorage.setItem(this.draftKey(), JSON.stringify({ document: this.data, revision: this.revision })); else localStorage.removeItem(this.draftKey()); } catch { /* Disk saves remain available. */ } }
  destroyEditors() { this.editors.forEach(e => e.destroy()); this.editors = []; }
  release() { this.unlock?.(); this.unlock = null; }
  async acquire(id) {
    this.release(); if (!navigator.locks) return false;
    return new Promise((resolve, reject) => navigator.locks.request(`fieldnotes:student:${id}`, { ifAvailable: true }, async lock => {
      if (!lock) { resolve(false); return; }
      const held = new Promise(done => { this.unlock = done; }); resolve(true); await held;
    }).catch(reject));
  }
  async reclaim() {
    if (!this.data || this.reclaiming) return;
    this.reclaiming = true; this.parent.inert = true;
    try {
      if (this.saving) await this.saving.catch(() => {});
      this.cache(); this.readOnly = !await this.acquire(this.data.id);
      const latest = await this.api(`/api/students/${this.data.id}`); this.load(latest, true); this.renderDetail();
    } catch (e) { this.notice(e.message); }
    finally { this.reclaiming = false; this.parent.inert = false; }
  }
  close() { this.editingSections.clear(); clearTimeout(this.timer); this.release(); this.destroyEditors(); this.data = null; this.saved = ''; this.blocked = false; this.conflict = false; this.readOnly = false; this.undo = null; this.status = null; }
  async flush() { try { await this.save(); return !this.dirty; } catch (e) { this.notice(e.message); return false; } }
  async open(id, push = true) {
    try {
      // Flush before reading summaries or revisiting the same student. Keep the old view if fetching fails.
      if (!await this.prepare()) return false;
      const [academic, records, calendar] = await Promise.all([this.api('/api/timetables'), this.api('/api/students/export'), this.api('/api/calendar')]);
      this.academic = academic; this.studentDocuments = records.students; this.calendar = calendar.document;
      const result = id ? await this.api(`/api/students/${id}`) : await this.api('/api/students');
      if (!await this.enter()) return false;
      this.close(); this.historyQuery = ''; this.openSessions.clear();
      if (id) { this.readOnly = !await this.acquire(id); this.load(result, true); this.renderDetail(); }
      else { this.roster = result.students; this.renderRoster(); }
      if (push && location.search !== this.url) history.pushState(null, '', this.url);
      document.title = `${id ? this.data.profile.name : 'Students'} · Workbench`;
      return true;
    } catch (e) { this.notice(e.message); return false; }
  }
  load(result, recover = false) {
    this.undo = null; this.data = clone(result.document); this.saved = JSON.stringify(this.data); this.revision = result.revision; this.savedAt = result.savedAt; this.blocked = false;
    if (recover && !this.readOnly) {
      try {
        const draft = JSON.parse(localStorage.getItem(this.draftKey()));
        if (draft?.document?.id === this.data.id && JSON.stringify(draft.document) !== this.saved) {
          validateStudent(draft.document); this.data = draft.document; this.blocked = true; this.notice('Recovered an unsaved student draft. Review it and choose Retry save or resolve the disk conflict.');
          this.conflict = draft.revision !== result.revision;
        } else this.conflict = false;
      } catch { this.notice('The browser draft could not be read. Disk data is preserved.'); }
    } else this.conflict = false;
    if (this.data.sessions.length) this.openSessions.add([...this.data.sessions].reverse().sort((a, b) => b.date.localeCompare(a.date))[0].id);
  }
  changed() {
    this.cache(); clearTimeout(this.timer); this.updateStatus();
    if (!this.blocked && this.dirty) this.timer = setTimeout(() => this.save().catch(() => {}), 750);
  }
  async save() {
    clearTimeout(this.timer);
    if (this.saving) { await this.saving; return this.save(); }
    if (!this.dirty) { if (!this.conflict) { this.blocked = false; this.updateStatus(); } return; }
    if (this.conflict) throw new Error('Resolve the student disk conflict before saving or leaving.');
    const document = clone(this.data), revision = this.revision;
    this.saving = (async () => {
      try {
        const result = await this.api(`/api/students/${document.id}`, 'PUT', { document, revision });
        this.saved = JSON.stringify(document); this.revision = result.revision; this.savedAt = result.savedAt; this.blocked = false; this.cache();
      } catch (e) { this.blocked = true; this.conflict = e.status === 409; this.cache(); this.notice(e.message); throw e; }
      finally { this.saving = null; this.updateStatus(); }
    })();
    this.updateStatus(); await this.saving;
    if (this.dirty) this.timer = setTimeout(() => this.save().catch(() => {}), 750);
  }
  async checkExternal() {
    if (!this.data || this.checking || this.saving || this.profileEditor?.open || document.querySelector('.timetable-dialog[open]')) return;
    this.checking = true; const observed = this.data;
    const stage = this.parent.querySelector('[data-current-stage]'); if (stage) stage.textContent = currentStage(observed.profile.entryYear);
    try {
      const latest = await this.api(`/api/students/${observed.id}`);
      if (this.data !== observed || this.saving || latest.revision === this.revision) return;
      if (this.dirty) { clearTimeout(this.timer); this.blocked = this.conflict = true; this.cache(); this.updateStatus(); }
      else { this.load(latest); this.renderDetail(); }
    } catch (e) { if (!this.blocked) this.notice(e.message); }
    finally { this.checking = false; }
  }
  button(label, action, cls = '') {
    const b = el('button', label, cls); b.type = 'button'; b.onclick = () => Promise.resolve(action()).catch(e => this.notice(e.message)); return b;
  }
  fact(label, value) {
    const wrap = el('div', '', 'student-fact'); wrap.append(el('span', label), el('p', value || '—')); return wrap;
  }
  editing(section) { return !this.readOnly && this.editingSections.has(section); }
  sectionHeading(title, section) {
    const head = el('div', '', 'student-section-heading'); const editing = this.editing(section);
    head.append(el('h2', title), this.button(editing ? `Done editing ${title.toLowerCase()}` : `Edit ${title.toLowerCase()}`, async () => {
      if (editing) { await this.save(); this.editingSections.delete(section); } else this.editingSections.add(section);
      this.renderDetail();
    })); return head;
  }
  field(label, value, update, type = 'text') {
    if (this.previewing) return this.fact(label, value);
    const wrap = el('label', '', 'student-field'); wrap.append(el('span', label)); const input = el('input'); input.type = type; input.value = value; input.setAttribute('aria-label', label);
    input.disabled = !!this.readOnly;
    input.oninput = () => { update(input.value); this.changed(); }; wrap.append(input); return wrap;
  }
  select(label, value, options, update) {
    if (this.previewing) return this.fact(label, options.find(([key]) => key === value)?.[1] || value);
    const wrap = el('label', '', 'student-field'); wrap.append(el('span', label)); const select = el('select'); select.setAttribute('aria-label', label); select.disabled = !!this.readOnly;
    for (const [key, text] of options) { const option = el('option', text); option.value = key; select.append(option); } select.value = value;
    select.onchange = () => { update(select.value); this.changed(); }; wrap.append(select); return wrap;
  }
  checkbox(label, checked, update) {
    if (this.previewing) return el('p', `${checked ? '✓' : '○'} ${label}`, 'student-check-preview');
    const wrap = el('label', '', 'student-check'); const c = el('input'); c.type = 'checkbox'; c.checked = checked; c.disabled = !!this.readOnly; c.setAttribute('aria-label', label);
    c.onchange = () => { update(c.checked); this.changed(); this.refreshPreparation(); }; wrap.append(c, el('span', label)); return wrap;
  }
  rich(label, value, update) {
    if (this.previewing) {
      const wrap = el('section', '', 'student-rich-preview'); wrap.append(el('h3', label));
      const content = el('div', '', 'student-rich-content');
      if (richText(value).trim()) content.innerHTML = DOMPurify.sanitize(generateHTML(value, [StarterKit])); else content.textContent = 'No notes yet.';
      wrap.append(content); return wrap;
    }
    const wrap = el('section', '', 'student-rich'); wrap.append(el('label', label), el('small', 'Markdown: headings, **bold**, *italic*, lists and links. Type or paste to format in place.', 'student-markdown-hint')); const toolbar = el('div', '', 'student-toolbar'); toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', `${label} formatting`);
    const host = el('div', '', 'student-rich-host'); host.setAttribute('aria-label', label);
    wrap.append(toolbar, host);
    const editor = new Editor({ element: host, editable: !this.readOnly, extensions: [StudentMarkdown, StarterKit.configure({ heading: { levels: [1, 2, 3] }, code: false, codeBlock: false, blockquote: false, horizontalRule: false, strike: false, underline: false, link: { openOnClick: false, protocols: ['http', 'https', 'mailto'] } })], content: value, editorProps: { attributes: { 'aria-label': label, role: 'textbox', 'aria-multiline': 'true', spellcheck: 'true' }, transformPastedHTML: html => DOMPurify.sanitize(html), handlePaste: (view, event) => {
      const text = event.clipboardData?.getData('text/plain');
      if (!text || event.clipboardData.getData('text/html')) return false;
      event.preventDefault();
      editor.commands.insertContent(DOMPurify.sanitize(marked.parse(text, { breaks: true }), { ALLOWED_TAGS: ['p', 'br', 'h1', 'h2', 'h3', 'strong', 'em', 'ul', 'ol', 'li', 'a'], ALLOWED_ATTR: ['href', 'start'] }));
      return true;
    } }, onUpdate: () => { update(editor.getJSON()); this.changed(); }, onSelectionUpdate: () => sync() });
    const controls = [
      ['Heading', () => editor.chain().focus().toggleHeading({ level: 2 }).run(), () => editor.isActive('heading')],
      ['Bold', () => editor.chain().focus().toggleBold().run(), () => editor.isActive('bold')],
      ['Italic', () => editor.chain().focus().toggleItalic().run(), () => editor.isActive('italic')],
      ['Bullets', () => editor.chain().focus().toggleBulletList().run(), () => editor.isActive('bulletList')],
      ['Numbered list', () => editor.chain().focus().toggleOrderedList().run(), () => editor.isActive('orderedList')],
      ['Link', () => { const href = prompt('Link URL (http, https, or mailto). Leave blank to remove:', editor.getAttributes('link').href || ''); if (href === null) return; if (!href) editor.chain().focus().unsetLink().run(); else if (/^(https?:\/\/|mailto:)/i.test(href) && !/[\x00-\x20]/.test(href)) editor.chain().focus().setLink({ href }).run(); else this.notice('Use an http, https, or mailto link.'); }, () => editor.isActive('link')],
      ['Undo', () => editor.chain().focus().undo().run()], ['Redo', () => editor.chain().focus().redo().run()]
    ];
    const buttons = controls.map(([name, action]) => { const b = this.button(name, () => { action(); sync(); }); b.disabled = !!this.readOnly; toolbar.append(b); return b; });
    const sync = () => controls.forEach((c, i) => { if (c[2]) buttons[i].setAttribute('aria-pressed', String(c[2]())); }); sync();
    if (this.readOnly) { const html = DOMPurify.sanitize(editor.getHTML()); editor.destroy(); host.innerHTML = html; host.classList.add('student-rich-readonly'); host.tabIndex = 0; }
    else this.editors.push(editor); return wrap;
  }
  header(title, subtitle) { const head = el('header', '', 'students-heading'); const copy = el('div'); copy.append(el('h1', title)); if (subtitle) copy.append(el('p', subtitle)); head.append(copy); return head; }
  profileDialog(creating = false) {
    const draft = creating ? Object.fromEntries(profileFields.map(key => [key, ''])) : clone(this.data.profile);
    const dialog = el('dialog', '', 'student-dialog'); const form = el('form');
    form.append(el('h2', creating ? 'Add student' : 'Edit student profile'), el('p', 'Only a name is required.', 'student-muted'));
    const fields = el('div', '', 'student-profile-fields');
    for (const key of profileFields) {
      if (key === 'schoolId') { fields.append(this.select('School', draft.schoolId || '', [['', 'Unassigned'], ...this.academic.document.schools.map(s => [s.id, s.id])], value => { draft.schoolId = value; })); continue; }
      const label = creating && key === 'name' ? 'Student name' : labels[key];
      const field = this.field(label, draft[key] || '', value => { draft[key] = value; }, key === 'email' ? 'email' : 'text');
      const input = field.querySelector('input'); if (key === 'dob') { input.placeholder = 'YYYY-MM or YYYY-MM-DD'; input.pattern = '[0-9]{4}-[0-9]{2}(-[0-9]{2})?'; field.append(el('small', 'Year and month, with an optional day.', 'student-muted')); } input.oninput = () => { draft[key] = input.value; stage.textContent = currentStage(draft.entryYear) || '—'; }; input.required = key === 'name'; fields.append(field);
    }
    fields.append(this.select('Course status', draft.coursesCompleted ? 'completed' : 'ongoing', [['ongoing', 'Courses ongoing / unknown'], ['completed', 'All courses completed']], value => { draft.coursesCompleted = value === 'completed'; }));
    const stage = el('p', currentStage(draft.entryYear) || '—', 'student-muted');
    const stageLabel = el('div', '', 'student-stage'); stageLabel.append(el('span', 'Current stage'), stage, el('small', 'Calculated from Entry year; each academic year starts in September.')); form.append(fields, stageLabel);
    const error = el('p', '', 'form-error'); error.setAttribute('role', 'alert'); form.append(error);
    const actions = el('div', '', 'student-buttons'); actions.append(this.button('Cancel', () => dialog.close()));
    const submit = el('button', creating ? 'Create student' : 'Save profile', 'primary'); submit.type = 'submit'; actions.append(submit); form.append(actions);
    form.onsubmit = async event => {
      event.preventDefault(); submit.disabled = true;
      try {
        draft.name = draft.name.trim();
        if (creating) { const result = await this.api('/api/students', 'POST', { name: draft.name, profile: draft }); dialog.close(); await this.navigate(result.document.id); }
        else {
          const updated = { ...this.data, profile: draft }; validateStudent(updated);
          this.data.profile = draft; this.changed(); dialog.close(); this.renderDetail(); document.title = `${draft.name} · Workbench`; await this.save();
        }
      } catch (e) { if (dialog.open) error.textContent = e.message; else this.notice(e.message); }
      finally { submit.disabled = false; }
    };
    dialog.append(form); document.body.append(dialog); this.profileEditor = dialog; dialog.addEventListener('close', () => { if (this.profileEditor === dialog) this.profileEditor = null; dialog.remove(); }); dialog.showModal(); fields.querySelector('input').focus();
  }
  async createStudent() { this.profileDialog(true); }
  renderRoster() {
    this.destroyEditors(); const head = this.header('Students', 'Prepare the next conversation. Keep the long view.'); const actions = el('div', '', 'student-buttons'); actions.append(this.button('Export all records', async () => download(await this.api('/api/students/export'), 'workbench-students.json')), this.button('Add student', () => this.createStudent(), 'primary')); head.append(actions);
    const controls = el('div', '', 'student-list-controls');
    const search = this.field('Search students', this.rosterQuery, value => { this.rosterQuery = value; this.drawCards(); }, 'search');
    controls.append(search, this.select('Show students', this.filter, [['active', 'Active'], ['archived', 'Archived'], ['all', 'All']], value => { this.filter = value; this.drawCards(); }));
    this.cards = el('div', '', 'student-cards'); this.parent.replaceChildren(head, controls, this.cards); this.drawCards(); this.parent.append(this.makeTimetable());
  }
  makeTimetable() {
    return timetablePanel({ academic: this.academic, students: this.studentDocuments, student: this.data, api: this.api, readOnly: this.readOnly, saveStudent: async timetables => {
      const next = { ...this.data, timetables }; validateStudent(next);
      this.data.timetables = timetables; this.changed(); await this.save();
    }, refresh: async () => { this.academic = await this.api('/api/timetables'); this.studentDocuments = (await this.api('/api/students/export')).students; if (this.data) this.renderDetail(); else this.renderRoster(); } });
  }
  drawCards() {
    const query = this.rosterQuery.toLocaleLowerCase();
    const students = this.roster.filter(s => (this.filter === 'all' || s.archived === (this.filter === 'archived')) && `${s.name} ${s.researchAreas}`.toLocaleLowerCase().includes(query));
    this.cards.replaceChildren(...students.map(s => {
      const card = el('a', '', 'student-card'); card.href = `?view=student&id=${s.id}`;
      card.onclick = e => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); this.navigate(s.id); };
      const upcoming = this.calendar.events.filter(e => e.studentId === s.id && Date.parse(e.start) >= Date.now()).sort((a,b) => a.start.localeCompare(b.start))[0];
      if (upcoming) s = { ...s, nextMeeting: new Date(upcoming.start).toLocaleString() };
      card.append(el('h2', s.name), el('small', s.schoolId || 'School unassigned'), el('p', s.researchAreas || 'Research area not yet set', 'student-muted'));
      const list = el('dl'); for (const [label, value] of [['Last meeting', s.lastMeeting || '—'], ['Next meeting', s.nextMeeting || 'Unscheduled'], ['Open actions', String(s.openActions)], ['Goal deadline', s.nearestDeadline || '—']]) list.append(el('dt', label), el('dd', value)); card.append(list); if (s.archived) card.append(el('span', 'Archived', 'student-badge')); return card;
    }));
    if (!students.length) this.cards.append(el('p', 'No students here yet. Add a student or change your search.', 'student-empty'));
  }
  renderDetail() {
    this.destroyEditors(); const d = this.data;
    const head = this.header(d.profile.name); this.headingName = head.querySelector('h1');
    const actions = el('div', '', 'student-buttons'); actions.append(this.button('All students', () => this.navigate()), this.button(d.archived ? 'Unarchive student' : 'Archive student', async () => { d.archived = !d.archived; this.changed(); this.renderDetail(); await this.save(); })); head.append(actions);
    const statusRow = el('div', '', 'student-status-row'); this.status = el('span'); this.status.setAttribute('role', 'status'); this.saveButton = this.button('Save', () => this.save()); statusRow.append(this.status, this.saveButton, this.button('Export draft', () => download(this.data, `student-${d.id}-draft.json`)));
    this.conflictBar = el('div', '', 'student-conflict'); this.conflictBar.setAttribute('role', 'alert');
    this.conflictBar.append(el('span', 'Your draft is preserved.'), this.button('Compare', () => this.compare()), this.button('Reload disk version', async () => { if (!confirm('Discard your draft and reload the disk version?')) return; const latest = await this.api(`/api/students/${d.id}`); localStorage.removeItem(this.draftKey()); this.load(latest); this.renderDetail(); }), this.button('Overwrite with draft', async () => {
      const latest = await this.api(`/api/students/${d.id}`); await this.compare(latest);
      if (!confirm('Replace the displayed disk version with your current draft?')) return;
      this.revision = latest.revision; this.conflict = false; await this.save();
    }));
    const profile = el('section', '', 'student-profile student-panel');
    const profileHead = el('div', '', 'student-section-heading'); profileHead.append(el('h2', 'Student Profile'), this.button('Edit profile', () => this.profileDialog())); profile.append(profileHead);
    const facts = el('dl', '', 'student-profile-summary');
    for (const key of profileFields) if (d.profile[key]) { const fact = el('div'); fact.append(el('dt', labels[key]), el('dd', d.profile[key])); facts.append(fact); }
    if(d.profile.coursesCompleted){const fact=el('div');fact.append(el('dt','Course status'),el('dd','All courses completed'));facts.append(fact);}
    const stage = currentStage(d.profile.entryYear); if (stage) { const fact = el('div'); fact.append(el('dt', 'Current stage'), el('dd', stage)); fact.lastChild.dataset.currentStage = ''; facts.append(fact); }
    profile.append(facts);
    const columns = el('div', '', 'student-columns'); this.preparation = el('section', '', 'student-preparation student-panel'); this.renderPreparation();
    const history = el('section', '', 'student-history'); const historyHead = this.sectionHeading('Supervision Record', 'history'); if (this.editing('history')) historyHead.append(this.button('Add meeting', () => { this.addSession(); this.changed(); this.renderDetail(); }));
    const search = el('input'); search.type = 'search'; search.placeholder = 'Search meeting records…'; search.setAttribute('aria-label', 'Search meeting records'); search.value = this.historyQuery;
    search.oninput = () => { this.historyQuery = search.value; this.filterSessions(); }; history.append(historyHead, search);
    this.sessionList = el('div', '', 'student-sessions'); history.append(this.sessionList);
    const ordered = [...d.sessions].reverse().sort((a, b) => b.date.localeCompare(a.date)); ordered.forEach(s => this.sessionList.append(this.sessionCard(s))); this.filterSessions();
    const goals = el('aside', '', 'student-objectives student-panel'); const goalHead = this.sectionHeading('Objectives', 'objectives'); if (this.editing('objectives')) goalHead.append(this.button('Add objective', () => { d.objectives.push({ id: crypto.randomUUID(), title: '', description: emptyText(), targetDate: '', status: 'Planned', archived: false, milestones: [] }); this.changed(); this.renderDetail(); })); goals.append(goalHead);
    for (const goal of d.objectives.filter(g => !g.archived)) goals.append(this.goalCard(goal));
    if (!d.objectives.some(g => !g.archived)) goals.append(el('p', 'Start with an objective: a research direction, skill, or milestone.', 'student-muted'));
    const archived = d.objectives.filter(g => g.archived); if (archived.length) { const group = el('details'); group.append(el('summary', `Archived objectives (${archived.length})`)); archived.forEach(g => group.append(this.goalCard(g))); goals.append(group); }
    const main = el('div', '', 'student-main'); main.append(this.preparation, history);
    columns.append(main, goals);
    const undo = el('div', '', 'student-undo'); undo.hidden = !this.undo; undo.append(el('span', 'Item removed. '), this.button('Undo removal', () => { this.undo.array.splice(this.undo.index, 0, this.undo.item); this.undo = null; this.changed(); this.renderDetail(); }));
    this.parent.replaceChildren(head, statusRow, this.conflictBar, undo, profile, this.makeTimetable(), columns);
    if (this.readOnly) { const banner = el('div', '', 'student-readonly'); banner.append(el('span', 'Already being edited in another tab. This view is read-only. '), this.button('Edit here when available', () => this.reclaim())); this.parent.insertBefore(banner, profile); }
    // All document mutations are disabled in a duplicate view; navigation/export remain available.
    if (this.readOnly) for (const b of [...profile.querySelectorAll('button'), ...columns.querySelectorAll('button'), actions.lastChild]) if (!b.classList.contains('student-navigation')) b.disabled = true;
    this.updateStatus();
  }
  updateStatus() {
    if (!this.status) return;
    this.status.textContent = this.readOnly ? 'Read-only' : this.saving ? 'Saving…' : this.conflict ? 'Conflict · draft preserved' : this.blocked ? 'Save failed · draft preserved' : this.dirty ? 'Unsaved changes' : `Saved to disk${this.savedAt ? ` · ${new Date(this.savedAt).toLocaleString()}` : ''}`;
    this.saveButton.textContent = this.blocked && !this.conflict ? 'Retry save' : 'Save'; this.saveButton.disabled = !!this.readOnly || !!this.saving || !!this.conflict;
    this.conflictBar.hidden = !this.conflict;
  }
  async compare(latest) {
    latest ||= await this.api(`/api/students/${this.data.id}`);
    const dialog = el('dialog', '', 'student-compare'); dialog.append(el('h2', 'Compare student records'));
    const columns = el('div', '', 'student-compare-columns'); for (const [label, value] of [['Your draft', this.data], ['Disk version', latest.document]]) { const side = el('section'); side.append(el('h3', label), el('pre', JSON.stringify(value, null, 2))); columns.append(side); } dialog.append(columns, this.button('Close', () => dialog.close())); document.body.append(dialog); dialog.showModal();
    return new Promise(resolve => dialog.addEventListener('close', () => { dialog.remove(); resolve(latest); }, { once: true }));
  }
  remove(array, item, label) { if (!confirm(`Remove this ${label}? You can undo the removal immediately.`)) return; const index = array.indexOf(item); this.undo = { array, index, item }; array.splice(index, 1); this.changed(); this.renderDetail(); }
  addSession(discussion = emptyText(), date = today()) { const s = { id: crypto.randomUUID(), date, title: 'Catch-up', discussion: clone(discussion), decisions: emptyText(), objectiveIds: [], actions: [], correction: emptyText() }; this.data.sessions.push(s); this.openSessions.add(s.id); return s; }
  renderPreparation() {
    const p = this.data.preparation; this.previewing = !this.editing('preparation'); this.preparation.append(this.sectionHeading('Next Conversation', 'preparation'));
    this.preparation.append(this.button('Schedule conversation', () => this.schedule(this.data.id, p.date || today())));
    const planned = this.calendar.events.filter(e => e.studentId === this.data.id && Date.parse(e.start) >= Date.now()).sort((a,b) => a.start.localeCompare(b.start));
    for (const event of planned) this.preparation.append(el('p', `Scheduled: ${new Date(event.start).toLocaleString()} · ${event.title}`));
    this.preparation.append(this.field('Next meeting', p.date, value => { p.date = value; }, 'date'), this.rich('Next meeting agenda', p.agenda, value => { p.agenda = value; }));
    this.previewing = false;
    this.preparation.append(this.button('Start meeting', async () => {
      // Use a single atomic document save for agenda transfer and clearing preparation.
      if (this.starting) return; this.starting = true; this.parent.inert = true;
      const before = clone(this.data); this.addSession(p.agenda, p.date || today()); this.data.preparation = { date: '', agenda: emptyText() }; this.changed();
      try { await this.save(); this.editingSections.add('history'); this.renderDetail(); } catch (e) { this.data = before; this.undo = null; this.cache(); this.updateStatus(); throw e; }
      finally { this.starting = false; this.parent.inert = false; }
    }, 'primary'));
    this.pendingActions = el('div', '', 'student-pending-actions'); this.preparation.append(this.pendingActions); this.refreshPreparation();
  }
  refreshPreparation() {
    if (!this.pendingActions || !this.data) return;
    const pending = this.data.sessions.flatMap(s => s.actions.filter(a => !a.done).map(a => [s, a]));
    this.pendingActions.replaceChildren(el('h3', `Unfinished actions (${pending.length})`));
    pending.forEach(([s, a]) => { const row = el('div', '', 'student-pending-row'); row.append(this.button(a.text || 'Untitled action', () => this.focusSession(s.id), 'student-navigation'), el('small', `${a.owner}${a.dueDate ? ` · Due ${a.dueDate}` : ''}`)); this.pendingActions.append(row); });
  }
  focusMatch(match) {
    if (match.sessionId) { this.focusSession(match.sessionId); return; }
    const target = match.goalId ? this.parent.querySelector(`[data-goal="${match.goalId}"]`) : this.parent.querySelector(match.section === 'Next conversation' ? '.student-preparation' : '.student-profile-summary');
    if (!target) return;
    for (let parent = target.parentElement; parent && parent !== this.parent; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
    target.scrollIntoView({ block: 'center' });
  }
  focusSession(id) { this.historyQuery = ''; const search = this.parent.querySelector('[aria-label="Search meeting records"]'); if (search) search.value = ''; this.filterSessions(); this.openSessions.add(id); const card = this.parent.querySelector(`[data-session="${id}"]`); if (card) { card.open = true; card.scrollIntoView({ block: 'start', behavior: 'smooth' }); card.querySelector('summary').focus(); } }
  filterSessions() {
    if (!this.sessionList) return;
    const q = this.historyQuery.toLocaleLowerCase();
    for (const s of this.data.sessions) { const card = this.sessionList.querySelector(`[data-session="${s.id}"]`); if (card) card.hidden = !`${s.date} ${s.title} ${richText(s.discussion)} ${richText(s.decisions)} ${richText(s.correction)} ${s.nextConversation?.date || ''} ${richText(s.nextConversation?.agenda)} ${s.actions.map(a => a.text).join(' ')}`.toLocaleLowerCase().includes(q); }
    let empty = this.sessionList.querySelector('.student-empty'); if (!empty) { empty = el('p', '', 'student-empty'); this.sessionList.append(empty); }
    empty.textContent = this.data.sessions.length ? 'No records match your search.' : 'Your first conversation starts the record.'; empty.hidden = [...this.sessionList.querySelectorAll('details')].some(card => !card.hidden);
  }
  sessionCard(s) {
    const card = el('details', '', 'student-session student-panel'); card.dataset.session = s.id; card.open = this.openSessions.has(s.id);
    const summary = el('summary', `${s.date} · ${s.title || 'Untitled meeting'}`); card.append(summary);
    // Create rich-text editors only when a record is opened, keeping long histories inexpensive.
    let mounted = false;
    const mount = () => {
    if (mounted) return; mounted = true; this.previewing = !this.editing('history');
    const body = el('div', '', 'student-session-body'); body.append(this.field('Meeting date', s.date, value => { s.date = value; summary.textContent = `${value} · ${s.title}`; this.refreshGoalHistories(); }, 'date'), this.field('Meeting title', s.title, value => { s.title = value; summary.textContent = `${s.date} · ${value}`; this.refreshGoalHistories(); }), this.rich('Discussion', s.discussion, value => { s.discussion = value; }), this.rich('Decisions', s.decisions, value => { s.decisions = value; }), this.rich('Correction', s.correction || emptyText(), value => { s.correction = value; }));
    const links = el('div', '', 'student-goal-links'); links.append(el('h3', 'Related objectives'));
    for (const goal of this.data.objectives) links.append(this.checkbox(goal.title || 'Untitled objective', s.objectiveIds.includes(goal.id), checked => { s.objectiveIds = checked ? [...s.objectiveIds, goal.id] : s.objectiveIds.filter(id => id !== goal.id); this.refreshGoalHistories(); })); body.append(links);
    const list = el('section', '', 'student-action-list'); list.append(el('h3', 'Follow-up actions'));
    s.actions.forEach(a => {
      const row = el('div', '', 'student-action'); row.append(this.checkbox('Action completed', a.done, value => { a.done = value; }), this.field('Action', a.text, value => { a.text = value; this.refreshPreparation(); }), this.select('Owner', a.owner, [['Student', 'Student'], ['Supervisor', 'Supervisor']], value => { a.owner = value; this.refreshPreparation(); }), this.field('Due date', a.dueDate, value => { a.dueDate = value; this.refreshPreparation(); }, 'date'), this.select('Linked objective', a.objectiveId, [['', 'No objective'], ...this.data.objectives.map(g => [g.id, `${g.title || 'Untitled objective'}${g.archived ? ' (archived)' : ''}`])], value => { a.objectiveId = value; this.refreshGoalHistories(); }), ...(this.editing('history') ? [this.button('Remove action', () => this.remove(s.actions, a, 'action'))] : [])); list.append(row);
    });
    if (this.editing('history')) list.append(this.button('Add action', () => { s.actions.push({ id: crypto.randomUUID(), text: '', owner: 'Student', dueDate: '', done: false, objectiveId: '' }); this.changed(); this.renderDetail(); })); body.append(list);
    if (this.editing('history')) body.append(this.button('Remove meeting', () => this.remove(this.data.sessions, s, 'meeting record'))); this.previewing = false; card.append(body); if (this.readOnly) for (const b of body.querySelectorAll('button')) b.disabled = true;
    };
    card.ontoggle = () => { if (card.open) { this.openSessions.add(s.id); mount(); } else this.openSessions.delete(s.id); };
    if (card.open) mount(); return card;
  }
  drawGoalHistory(g, links) {
    links.replaceChildren(el('h3', 'Related conversations'));
    const related = this.data.sessions.filter(s => s.objectiveIds.includes(g.id) || s.actions.some(a => a.objectiveId === g.id));
    related.forEach(s => links.append(this.button(`${s.date} · ${s.title}`, () => this.focusSession(s.id), 'student-navigation')));
    if (!related.length) links.append(el('p', 'Link a meeting or action to build this objective’s history.', 'student-muted'));
  }
  refreshGoalHistories() {
    for (const g of this.data.objectives) { const target = this.parent.querySelector(`[data-goal="${g.id}"] .student-objective-history`); if (target) this.drawGoalHistory(g, target); }
  }
  refreshGoalLabels() {
    for (const select of this.parent.querySelectorAll('select[aria-label="Linked objective"]')) for (const option of select.options) {
      const g = this.data.objectives.find(g => g.id === option.value); if (g) option.textContent = `${g.title || 'Untitled objective'}${g.archived ? ' (archived)' : ''}`;
    }
    for (const card of this.parent.querySelectorAll('[data-session]')) {
      const s = this.data.sessions.find(s => s.id === card.dataset.session);
      const links = card.querySelector('.student-goal-links'); if (!links) continue; this.previewing = !this.editing('history'); links.replaceChildren(el('h3', 'Related objectives'));
      for (const g of this.data.objectives) links.append(this.checkbox(g.title || 'Untitled objective', s.objectiveIds.includes(g.id), checked => { s.objectiveIds = checked ? [...s.objectiveIds, g.id] : s.objectiveIds.filter(id => id !== g.id); this.refreshGoalHistories(); })); this.previewing = false;
    }
  }
  goalCard(g) {
    const card = el('section', '', 'student-goal'); card.dataset.goal = g.id; this.previewing = !this.editing('objectives');
    card.append(this.field('Objective title', g.title, value => { g.title = value; this.refreshGoalLabels(); }), this.rich('Objective description', g.description, value => { g.description = value; }), this.field('Target date', g.targetDate, value => { g.targetDate = value; }, 'date'), this.select('Objective status', g.status, ['Planned', 'In progress', 'Completed', 'Paused'].map(v => [v, v]), value => { g.status = value; }));
    const count = el('p', '', 'student-muted'); const updateCount = () => { count.textContent = `${g.milestones.filter(m => m.done).length} / ${g.milestones.length} milestones completed`; }; updateCount(); card.append(count);
    for (const m of g.milestones) { const row = el('div', '', 'student-milestone'); row.append(this.checkbox('Milestone completed', m.done, value => { m.done = value; updateCount(); }), this.field('Milestone', m.text, value => { m.text = value; }), ...(this.editing('objectives') ? [this.button('Remove milestone', () => this.remove(g.milestones, m, 'milestone'))] : [])); card.append(row); }
    if (this.editing('objectives')) card.append(this.button('Add milestone', () => { g.milestones.push({ id: crypto.randomUUID(), text: '', done: false }); this.changed(); this.renderDetail(); }));
    card.append(el('div', '', 'student-objective-history')); this.drawGoalHistory(g, card.querySelector('.student-objective-history'));
    if (this.editing('objectives')) card.append(this.button(g.archived ? 'Unarchive objective' : 'Archive objective', () => { g.archived = !g.archived; this.changed(); this.renderDetail(); })); this.previewing = false; return card;
  }
}
