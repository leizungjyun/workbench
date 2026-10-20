import { StudentWorkspace } from './students.js';
import { validateFaculty, facultyProfileFields, markdownNote } from '../faculty-model.js';
import { richText } from '../student-model.js';
import { localInput } from '../calendar-model.js';
import { localDate } from '../daily-model.js';
import './faculty.css';
const el = (tag, text = '', cls = '') => { const n = document.createElement(tag); n.textContent = text; if (cls) n.className = cls; return n; };
const labels = { name: 'Name', institution: 'Institution', department: 'Department', position: 'Position / title', email: 'Email', researchAreas: 'Research areas' };
const download = (value, filename) => { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const a = el('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
export class FacultyWorkspace extends StudentWorkspace {
  constructor(options) { super({ ...options, entity: 'faculty', collection: 'faculty', validateDocument: validateFaculty }); }
  get url() { return this.data ? `?view=faculty&id=${this.data.id}` : '?view=faculty'; }
  async flush() { if (this.starting) { this.notice('Wait for the conversation to finish saving.'); return false; } if (this.profileEditor?.open) { this.notice('Save or cancel the faculty profile before leaving.'); return false; } return super.flush(); }
  async open(id, push = true, sessionId) {
    try {
      if (!await this.prepare()) return false;
      const [result, calendar] = await Promise.all([this.api(id ? `/api/faculty/${id}` : '/api/faculty'), this.api('/api/calendar')]);
      if (!await this.enter()) return false;
      this.close(); this.historyQuery = ''; this.openSessions.clear(); this.calendar = calendar.document;
      if (id) { this.readOnly = !await this.acquire(id); this.load(result, true); if (sessionId) this.openSessions.add(sessionId); this.renderDetail(); if (sessionId) this.focusSession(sessionId); }
      else { this.roster = result.faculty; this.renderRoster(); }
      if (push && location.search !== this.url) history.pushState(null, '', this.url);
      document.title = `${id ? this.data.profile.name : 'Faculty'} · Workbench`; return true;
    } catch (e) { this.notice(e.message); return false; }
  }
  profileDialog(creating = false) {
    if (this.readOnly) return;
    const draft = creating ? { ...Object.fromEntries(facultyProfileFields.map(key => [key, ''])), notes: markdownNote() } : structuredClone(this.data.profile);
    const dialog = el('dialog', '', 'student-dialog faculty-profile-dialog'), form = el('form'); dialog.setAttribute('aria-label', creating ? 'Add faculty member' : 'Edit faculty profile');
    form.append(el('h2', creating ? 'Add faculty member' : 'Edit faculty profile'), el('p', 'Only a name is required.', 'student-muted'));
    const fields = el('div', '', 'student-profile-fields');
    for (const key of facultyProfileFields) {
      const wrap = el('label', '', 'student-field'), input = el('input'); input.type = key === 'email' ? 'email' : 'text'; input.value = draft[key]; input.required = key === 'name'; input.maxLength = 1000; input.setAttribute('aria-label', labels[key]); input.oninput = () => { draft[key] = input.value; }; wrap.append(el('span', labels[key]), input); fields.append(wrap);
    }
    const notes = el('label', '', 'student-rich'), source = el('textarea', '', 'student-markdown-source'); source.value = draft.notes.text || richText(draft.notes); source.setAttribute('aria-label', 'Profile notes'); source.oninput = () => { draft.notes = markdownNote(source.value); }; notes.append(el('span', 'Profile notes (Markdown)'), source);
    const error = el('p', '', 'form-error'); error.setAttribute('role', 'alert'); const actions = el('div', '', 'student-buttons');
    const submit = el('button', creating ? 'Create faculty member' : 'Save profile', 'primary'); submit.type = 'submit'; actions.append(this.button('Cancel', () => dialog.close()), submit); form.append(fields, notes, error, actions);
    form.onsubmit = async e => {
      e.preventDefault(); if (submit.disabled) return; submit.disabled = true;
      try {
        draft.name = draft.name.trim();
        if (creating) { const result = await this.api('/api/faculty', 'POST', { name: draft.name, profile: draft }); dialog.close(); await this.navigate(result.document.id); }
        else { const next = { ...this.data, profile: draft }; validateFaculty(next); this.data = next; this.changed(); await this.save(); dialog.close(); this.renderDetail(); document.title = `${draft.name} · Workbench`; }
      } catch (e) { error.textContent = e.message; } finally { submit.disabled = false; }
    };
    dialog.append(form); this.parent.append(dialog); this.profileEditor = dialog;
    dialog.addEventListener('close', () => { this.profileEditor = null; dialog.remove(); }); dialog.showModal(); fields.querySelector('input').focus();
  }
  renderRoster() {
    const head = this.header('Faculty', 'Prepare conversations and keep track of follow-up tasks.'), actions = el('div', '', 'student-buttons');
    actions.append(this.button('Export all records', async () => download(await this.api('/api/faculty/export'), 'workbench-faculty.json')), this.button('Add faculty member', () => this.profileDialog(true), 'primary')); head.append(actions);
    const controls = el('div', '', 'student-list-controls'); controls.append(this.field('Search faculty', this.rosterQuery, value => { this.rosterQuery = value; this.drawCards(); }, 'search'), this.select('Show faculty', this.filter, [['active', 'Active'], ['archived', 'Archived'], ['all', 'All']], value => { this.filter = value; this.drawCards(); }));
    this.cards = el('div', '', 'student-cards'); this.parent.replaceChildren(head, controls, this.cards); this.drawCards();
  }
  drawCards() {
    const q = this.rosterQuery.trim().toLocaleLowerCase();
    const members = this.roster.filter(m => (this.filter === 'all' || m.archived === (this.filter === 'archived')) && facultyProfileFields.map(k => m[k]).join(' ').toLocaleLowerCase().includes(q));
    this.cards.replaceChildren(...members.map(m => {
      const card = el('a', '', 'student-card'); card.href = `?view=faculty&id=${m.id}`;
      card.onclick = e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); this.navigate(m.id); };
      card.append(el('h2', m.name), el('p', [m.position, m.department, m.institution].filter(Boolean).join(' · ')), el('p', `${m.openTasks} unfinished tasks · Last conversation: ${m.lastMeeting || 'None'}`), el('p', `Next conversation: ${m.nextMeeting || 'Unscheduled'}`)); if (m.archived) card.append(el('span', 'Archived', 'student-badge')); return card;
    }));
    if (!members.length) this.cards.append(el('p', 'No faculty members match your search or filters.', 'student-empty'));
  }
  renderDetail() {
    const d = this.data, head = this.header(d.profile.name), actions = el('div', '', 'student-buttons');
    const archive = this.button(d.archived ? 'Restore faculty member' : 'Archive faculty member', async () => { d.archived = !d.archived; this.changed(); this.renderDetail(); await this.save(); });
    actions.append(this.button('All faculty', () => this.navigate(), 'student-navigation'), archive); head.append(actions);
    const statusRow = el('div', '', 'student-status-row'); this.status = el('span'); this.status.setAttribute('role', 'status'); this.saveButton = this.button('Save', () => this.save());
    statusRow.append(this.status, this.saveButton, this.button('Export record', async () => { if (await this.flush()) download(this.data, `faculty-${d.id}.json`); }, 'student-navigation'), this.button('Export draft', () => download(this.data, `faculty-${d.id}-draft.json`), 'student-navigation'));
    this.conflictBar = el('div', '', 'student-conflict'); this.conflictBar.setAttribute('role', 'alert');
    this.conflictBar.append(el('span', 'Your draft is preserved.'), this.button('Compare', () => this.compare(), 'student-navigation'), this.button('Reload disk version', async () => { if (!confirm('Discard the Faculty draft and reload the disk version?')) return; const latest = await this.api(`/api/faculty/${d.id}`); localStorage.removeItem(this.draftKey()); this.load(latest); this.renderDetail(); }), this.button('Overwrite with draft', async () => { const latest = await this.api(`/api/faculty/${d.id}`); await this.compare(latest); if (!confirm('Replace the reviewed disk version with this draft?')) return; this.revision = latest.revision; this.conflict = false; await this.save(); }));
    const profile = el('section', '', 'student-profile student-panel'); const profileHead = el('div', '', 'student-section-heading'); profileHead.append(el('h2', 'Faculty Profile'), this.button('Edit profile', () => this.profileDialog())); profile.append(profileHead);
    const facts = el('dl', '', 'student-profile-summary'); for (const key of facultyProfileFields) if (d.profile[key]) { const fact = el('div'); fact.append(el('dt', labels[key]), el('dd', d.profile[key])); facts.append(fact); } profile.append(facts);
    this.previewing = true; profile.append(this.rich('Profile notes', d.profile.notes, () => {})); this.previewing = false;
    this.preparation = el('section', '', 'student-preparation student-panel'); this.renderPreparation();
    const history = el('section', '', 'student-history'), heading = this.sectionHeading('Conversation Records', 'history'); if (this.editing('history')) heading.append(this.button('Add conversation', () => { this.addSession(); this.changed(); this.renderDetail(); }));
    const search = el('input'); search.type = 'search'; search.placeholder = 'Search conversation records…'; search.setAttribute('aria-label', 'Search meeting records'); search.value = this.historyQuery; search.oninput = () => { this.historyQuery = search.value; this.filterSessions(); };
    this.sessionList = el('div', '', 'student-sessions'); history.append(heading, search, this.sessionList);
    for (const s of [...d.sessions].reverse().sort((a, b) => b.date.localeCompare(a.date))) this.sessionList.append(this.sessionCard(s)); this.filterSessions();
    const main = el('div', '', 'student-main faculty-conversations'); main.append(this.preparation, history);
    const undo = el('div', '', 'student-undo'); undo.hidden = !this.undo; undo.append(el('span', 'Item removed. '), this.button('Undo removal', () => { this.undo.array.splice(this.undo.index, 0, this.undo.item); this.undo = null; this.changed(); this.renderDetail(); }));
    this.parent.replaceChildren(head, statusRow, this.conflictBar, undo, profile, main);
    if (this.readOnly) {
      const banner = el('div', '', 'student-readonly'); banner.append(el('span', 'Already being edited in another tab. This view is read-only. '), this.button('Edit here when available', () => this.reclaim())); this.parent.insertBefore(banner, profile);
      for (const b of [...profile.querySelectorAll('button'), ...main.querySelectorAll('button'), archive]) if (!b.classList.contains('student-navigation')) b.disabled = true;
    }
    this.updateStatus();
  }
  renderPreparation() {
    const p = this.data.preparation; this.previewing = !this.editing('preparation'); this.preparation.append(this.sectionHeading('Next Conversation', 'preparation'));
    this.preparation.append(this.field('Next conversation date', p.date, value => { p.date = value; }, 'date'), this.rich('Next conversation agenda', p.agenda, value => { p.agenda = value; })); this.previewing = false;
    const buttons = el('div', '', 'student-buttons'); buttons.append(this.button('Schedule conversation', () => this.schedule(this.data.id, p.date || localDate())), this.button('Start conversation', async () => {
      if (this.starting) return; this.starting = true; this.parent.inert = true; const before = structuredClone(this.data);
      this.addSession(p.agenda, p.date || localDate()); this.data.preparation = { date: '', agenda: markdownNote() }; this.changed();
      try { await this.save(); this.editingSections.add('history'); this.renderDetail(); } catch (e) { this.data = before; this.undo = null; this.cache(); this.updateStatus(); throw e; } finally { this.starting = false; this.parent.inert = false; }
    }, 'primary')); this.preparation.append(buttons);
    for (const event of this.calendar.events.filter(e => e.facultyId === this.data.id && Date.parse(e.start) >= Date.now()).sort((a, b) => a.start.localeCompare(b.start))) { const link = el('a', `Scheduled: ${new Date(event.start).toLocaleString()} · ${event.title}`); link.href = `?view=calendar&date=${localInput(event.start).slice(0, 10)}&event=${event.id}`; link.onclick = async e => { if(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)return;e.preventDefault(); if (await this.flush()) location.href = link.href; }; this.preparation.append(link); }
    this.pendingActions = el('div', '', 'student-pending-actions'); this.preparation.append(this.pendingActions); this.refreshPreparation();
  }
  refreshPreparation() {
    if (!this.pendingActions || !this.data) return; const tasks = this.data.sessions.flatMap(s => s.tasks.filter(t => !t.done).map(t => [s, t]));
    this.pendingActions.replaceChildren(el('h3', `Unfinished tasks (${tasks.length})`));
    for (const [s, t] of tasks) { const row = el('div', '', 'student-pending-row'); row.append(this.button(t.text || 'Untitled task', () => this.focusSession(s.id), 'student-navigation'), el('small', `${t.owner}${t.dueDate ? ` · Due ${t.dueDate}` : ''}`)); this.pendingActions.append(row); }
  }
  addSession(discussion = markdownNote(), date = localDate()) { const s = { id: crypto.randomUUID(), date, title: 'Conversation', discussion: structuredClone(discussion), decisions: markdownNote(), correction: markdownNote(), tasks: [] }; this.data.sessions.push(s); this.openSessions.add(s.id); return s; }
  filterSessions() {
    if (!this.sessionList) return; const q = this.historyQuery.toLocaleLowerCase();
    for (const s of this.data.sessions) { const card = this.sessionList.querySelector(`[data-session="${s.id}"]`); if (card) card.hidden = ![s.date, s.title, richText(s.discussion), richText(s.decisions), richText(s.correction), ...s.tasks.flatMap(t => [t.text, t.owner, t.dueDate])].join(' ').toLocaleLowerCase().includes(q); }
  }
  focusMatch(match) { if (match?.sessionId) this.focusSession(match.sessionId); else { const target = this.parent.querySelector(match?.section === 'Next conversation' ? '.student-preparation' : '.student-profile'); target?.scrollIntoView({ block: 'center' }); } }
  sessionCard(s) {
    const card = el('details', '', 'student-session student-panel'); card.dataset.session = s.id; card.open = this.openSessions.has(s.id); const summary = el('summary', `${s.date} · ${s.title || 'Untitled conversation'}`); card.append(summary);
    let mounted = false; const mount = () => {
      if (mounted) return; mounted = true; this.previewing = !this.editing('history'); const body = el('div', '', 'student-session-body');
      const updateSummary = () => { summary.textContent = `${s.date} · ${s.title || 'Untitled conversation'}`; };
      body.append(this.field('Conversation date', s.date, v => { s.date = v; updateSummary(); }, 'date'), this.field('Conversation title', s.title, v => { s.title = v; updateSummary(); }));
      for (const [key, label] of [['discussion', 'Discussion'], ['decisions', 'Decisions'], ['correction', 'Correction']]) body.append(this.rich(label, s[key], v => { s[key] = v; }));
      const tasks = el('section', '', 'faculty-tasks'); tasks.append(el('h3', 'Follow-up tasks'));
      for (const task of s.tasks) {
        const row = el('div', '', 'faculty-task'); row.append(this.checkbox('Task completed', task.done, v => { task.done = v; }), this.field('Task', task.text, v => { task.text = v; this.refreshPreparation(); }), this.select('Owner', task.owner, [['Me', 'Me'], ['Faculty member', 'Faculty member']], v => { task.owner = v; this.refreshPreparation(); }), this.field('Due date', task.dueDate, v => { task.dueDate = v; this.refreshPreparation(); }, 'date')); if (this.editing('history')) row.append(this.button('Remove task', () => this.remove(s.tasks, task, 'task'))); tasks.append(row);
      }
      if (this.editing('history')) tasks.append(this.button('Add task', () => { s.tasks.push({ id: crypto.randomUUID(), text: '', owner: 'Me', dueDate: '', done: false }); this.changed(); this.renderDetail(); }));
      body.append(tasks); if (this.editing('history')) body.append(this.button('Remove conversation', () => this.remove(this.data.sessions, s, 'conversation'))); this.previewing = false; card.append(body);
    };
    card.ontoggle = () => { if (card.open) { this.openSessions.add(s.id); mount(); } else this.openSessions.delete(s.id); }; if (card.open) mount(); return card;
  }
}
