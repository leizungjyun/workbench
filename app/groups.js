import { StudentWorkspace } from './students.js';
import { validateGroup, defaultParticipants, newGroupSession, markdownNote, groupCategoryId } from '../group-model.js';
import { localDate } from '../daily-model.js';
import { localInput, utcFromLocal } from '../calendar-model.js';
import { richText } from '../student-model.js';
import './groups.css';
const el = (tag, value = '', cls = '') => { const n = document.createElement(tag); n.textContent = value; if (cls) n.className = cls; return n; };
const clone = structuredClone;
const download = (value, name) => { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const a = el('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
export class GroupWorkspace extends StudentWorkspace {
  constructor(options) { super({ ...options, entity: 'group', collection: 'groups', validateDocument: validateGroup }); }
  async flush() { if (this.starting) { this.notice('Wait for the session to finish saving.'); return false; } if (this.uploading) { this.notice('Wait for presentation uploads before leaving.'); return false; } if (this.parent.querySelector('.group-schedule-dialog[open]')) { this.notice('Save or cancel the group booking before leaving.'); return false; } return super.flush(); }
  get url() { return this.data ? `?view=group&id=${this.data.id}` : '?view=groups'; }
  name(id) { return this.studentDocuments.find(s => s.id === id)?.profile.name || 'Unavailable student'; }
  async open(id, push = true, sessionId) {
    try {
      if (!await this.prepare()) return false;
      const [records, calendar, result] = await Promise.all([this.api('/api/students/export'), this.api('/api/calendar'), this.api(id ? `/api/groups/${id}` : '/api/groups')]);
      if (!await this.enter()) return false;
      this.close(); this.studentDocuments = records.students; this.calendar = calendar.document; this.openSessions.clear(); this.historyQuery = '';
      if (id) { this.readOnly = !await this.acquire(id); this.load(await this.api(`/api/groups/${id}`), true); this.renderDetail(); if (sessionId) this.focusSession(sessionId); }
      else { this.roster = result.groups; this.renderRoster(); }
      if (push && location.search !== this.url) history.pushState(null, '', this.url);
      document.title = `${id ? this.data.name : 'Group'} · Workbench`;
      if (id && !this.readOnly) {
        let pending; try { pending = this.data.sessions.find(s => localStorage.getItem(`group-booking:${id}:${s.id}`)); } catch { /* Browser storage is optional. */ }
        if (pending) { this.notice('Recovered an unsaved group booking. Save or cancel it.'); await this.scheduleSession(pending); }
      }
      return true;
    } catch (e) { this.notice(e.message); return false; }
  }
  async checkExternal() {
    if (!this.data || this.checking || this.saving || this.uploading || this.starting || this.parent.querySelector('dialog[open]')) return;
    this.checking = true; const observed = this.data;
    try {
      const [latest, calendar] = await Promise.all([this.api(`/api/groups/${observed.id}`), this.api('/api/calendar')]);
      if (this.data !== observed || this.saving || this.uploading || this.parent.querySelector('dialog[open]')) return;
      const calendarChanged = JSON.stringify(calendar.document) !== JSON.stringify(this.calendar);
      this.calendar = calendar.document;
      if (latest.revision !== this.revision) {
        if (this.dirty) { clearTimeout(this.timer); this.blocked = this.conflict = true; this.cache(); this.updateStatus(); }
        else { this.load(latest); this.renderDetail(); }
      } else if (calendarChanged && !this.dirty) this.renderDetail();
    } catch (e) { this.notice(e.message); } finally { this.checking = false; }
  }
  updateStatus() { super.updateStatus(); if (this.uploading && this.status) this.status.textContent = 'Uploading presentations…'; }
  renderRoster() {
    const head = this.header('Group', 'Shared sessions, supervision, and long-term objectives.');
    head.append(this.button('Add group', () => this.membershipDialog(true)), this.button('Export all groups', async () => download(await this.api('/api/groups/export'), 'workbench-groups.json')));
    const controls = el('div', '', 'student-list-controls'); this.previewing = false;
    controls.append(this.field('Search groups', this.rosterQuery, v => { this.rosterQuery = v; this.drawCards(); }), this.select('Show groups', this.filter, [['active','Active'],['archived','Archived'],['all','All']], v => { this.filter = v; this.drawCards(); }));
    this.cards = el('div', '', 'student-cards'); this.parent.replaceChildren(head, controls, this.cards); this.drawCards();
  }
  drawCards() {
    const q = this.rosterQuery.toLocaleLowerCase();
    const groups = this.roster.filter(g => (this.filter === 'all' || g.archived === (this.filter === 'archived')) && `${g.name} ${g.memberIds.map(id => this.name(id)).join(' ')}`.toLocaleLowerCase().includes(q));
    this.cards.replaceChildren(...groups.map(g => {
      const a = el('a', '', 'student-card'); a.href = `?view=group&id=${g.id}`; a.onclick = e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); this.navigate(g.id); };
      const next = this.calendar.events.filter(e => e.groupId === g.id && Date.parse(e.start) >= Date.now()).sort((a,b) => a.start.localeCompare(b.start))[0];
      a.append(el('h2', g.name), el('p', `Leader: ${this.name(g.leaderId)}`), el('p', `${g.memberIds.length} members · ${g.openActions} open actions`), el('p', `Next session: ${next ? new Date(next.start).toLocaleString() : g.nextSession || 'Unscheduled'}`)); if (g.archived) a.append(el('span', 'Archived', 'student-badge')); return a;
    }));
    if (!groups.length) this.cards.append(el('p', 'No groups here yet. Add a group or change your search.', 'student-empty'));
  }
  membershipDialog(creating = false) {
    if (this.readOnly) return;
    const d = this.data, draft = creating ? { name: '', memberIds: [], leaderId: '' } : { name: d.name, memberIds: [...d.memberIds], leaderId: d.leaderId };
    const dialog = el('dialog', '', 'student-dialog group-members-dialog'); dialog.setAttribute('aria-label', creating ? 'Add group' : 'Edit group');
    const form = el('form'), name = el('input'); name.value = draft.name; name.required = true; name.maxLength = 1000; name.setAttribute('aria-label', 'Group name');
    const leader = el('select'); leader.setAttribute('aria-label', 'Student leader'); leader.required = true;
    const members = el('div', '', 'group-member-options'); members.setAttribute('role', 'group'); members.setAttribute('aria-label', 'Group members');
    const memberHeading = el('div', '', 'group-members-heading'), selectedCount = el('span', '', 'student-muted');
    const updateCount = () => { selectedCount.textContent = `${draft.memberIds.length} selected`; };
    memberHeading.append(el('h3', 'Members'), selectedCount); updateCount();
    const updateLeader = () => { leader.replaceChildren(el('option', 'Choose a leader')); leader.firstChild.value = ''; for (const id of draft.memberIds) { const o = el('option', this.name(id)); o.value = id; leader.append(o); } leader.value = draft.leaderId; };
    for (const s of this.studentDocuments.filter(s => !s.archived || draft.memberIds.includes(s.id))) {
      const label = el('label', '', 'student-check group-member-option'), input = el('input'); input.type = 'checkbox'; input.checked = draft.memberIds.includes(s.id); input.setAttribute('aria-label', `Member: ${s.profile.name}`);
      input.onchange = () => { draft.memberIds = input.checked ? [...draft.memberIds, s.id] : draft.memberIds.filter(id => id !== s.id); updateLeader(); updateCount(); };
      const copy = el('span', '', 'group-member-copy'); copy.append(el('strong', s.profile.name));
      const detail = [s.profile.schoolId, s.profile.program, s.archived ? 'Archived' : ''].filter(Boolean).join(' · ');
      if (detail) copy.append(el('small', detail));
      label.append(input, copy); members.append(label);
    }
    if (!members.childElementCount) members.append(el('p', 'Add a student in Students before creating a group.', 'student-muted'));
    leader.onchange = () => { draft.leaderId = leader.value; };
    updateLeader(); const error = el('p', '', 'form-error'); error.setAttribute('role', 'alert');
    const submit = el('button', creating ? 'Create group' : 'Save group'); submit.type = 'submit';
    const nameField = el('label', '', 'student-field'); nameField.append(el('span', 'Group name'), name);
    const leaderField = el('label', '', 'student-field'); leaderField.append(el('span', 'Student leader'), leader);
    const footer = el('div', '', 'group-members-actions'); submit.className = 'primary'; footer.append(this.button('Cancel', () => dialog.close()), submit);
    form.append(el('h2', creating ? 'Add group' : 'Edit group'), nameField, memberHeading, members, leaderField, error, footer);
    form.onsubmit = async e => { e.preventDefault(); if (submit.disabled) return; submit.disabled = true;
      try {
        draft.name = name.value.trim(); draft.leaderId = leader.value;
        if (!draft.memberIds.includes(draft.leaderId)) throw new Error('Select a student leader from the members.');
        if (creating) { const result = await this.api('/api/groups', 'POST', draft); dialog.close(); await this.navigate(result.document.id); }
        else {
          const followsDefaults = JSON.stringify([...d.preparation.participantIds].sort()) === JSON.stringify(defaultParticipants(d, d.preparation.type).sort());
          const next = clone(d); Object.assign(next, draft); next.preparation.participantIds = followsDefaults ? defaultParticipants(next, next.preparation.type) : next.preparation.participantIds.filter(id => next.memberIds.includes(id));
          if (!next.preparation.participantIds.length) next.preparation.participantIds = defaultParticipants(next, next.preparation.type);
          validateGroup(next); this.data = next; this.changed(); await this.save(); dialog.close(); this.renderDetail();
        }
      } catch (e) { error.textContent = e.message; } finally { submit.disabled = false; }
    };
    dialog.append(form); this.parent.append(dialog); dialog.addEventListener('close', () => dialog.remove()); dialog.showModal(); name.focus();
  }
  renderDetail() {
    const d = this.data, head = this.header(d.name);
    head.append(this.button('All groups', () => this.navigate(), 'student-navigation'), this.button('Edit group', () => this.membershipDialog()), this.button(d.archived ? 'Restore group' : 'Archive group', async () => { d.archived = !d.archived; this.changed(); await this.save(); this.renderDetail(); }));
    const statusRow = el('div', '', 'student-status-row'); this.status = el('span'); this.status.setAttribute('role', 'status'); this.saveButton = this.button('Save', () => this.save());
    statusRow.append(this.status, this.saveButton, this.button('Export group', async () => { if (await this.flush()) download(this.data, `group-${d.id}.json`); }, 'student-navigation'), this.button('Export draft', () => download(this.data, `group-${d.id}-draft.json`), 'student-navigation'));
    this.conflictBar = el('div', '', 'student-conflict'); this.conflictBar.setAttribute('role', 'alert'); this.conflictBar.append(el('p', 'Your draft is preserved.'), this.button('Compare', () => this.compare(), 'student-navigation'), this.button('Reload disk version', async () => { if (!confirm('Discard the Group draft and reload?')) return; const latest = await this.api(`/api/groups/${d.id}`); localStorage.removeItem(this.draftKey()); this.load(latest); this.renderDetail(); }), this.button('Overwrite with draft', async () => { const latest = await this.api(`/api/groups/${d.id}`); await this.compare(latest); if (!confirm('Replace the reviewed group with your draft?')) return; this.revision = latest.revision; this.conflict = false; await this.save(); this.renderDetail(); }));
    const profile = el('section', '', 'student-panel group-profile'); profile.append(el('h2', 'Members'), el('p', `Student leader: ${this.name(d.leaderId)}`));
    for (const id of d.memberIds) { const a = el('a', this.name(id)); a.href = `?view=student&id=${id}`; a.onclick = async e => { if(e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();if(await this.flush())location.href=a.href; }; profile.append(a); }
    const columns = el('div', '', 'student-columns'), main = el('div', '', 'student-main');
    this.preparation = el('section', '', 'student-panel student-preparation'); this.renderPreparation();
    const history = el('section', '', 'student-history'); const historyHead = this.sectionHeading('Session Records', 'history'); if (this.editing('history')) historyHead.append(this.button('Add session', () => { this.addSession(); this.changed(); this.renderDetail(); }));
    const search = el('input'); search.type = 'search'; search.setAttribute('aria-label', 'Search session records'); search.placeholder = 'Search session records…'; search.value = this.historyQuery; search.oninput = () => { this.historyQuery = search.value; this.filterSessions(); };
    this.sessionList = el('div', '', 'student-sessions'); history.append(historyHead, search, this.sessionList);
    for (const s of [...d.sessions].reverse().sort((a,b) => b.date.localeCompare(a.date))) this.sessionList.append(this.sessionCard(s)); this.filterSessions();
    const goals = el('aside', '', 'student-panel student-objectives'), goalHead = this.sectionHeading('Objectives', 'objectives');
    if (this.editing('objectives')) goalHead.append(this.button('Add objective', () => { d.objectives.push({ id: crypto.randomUUID(), title: '', description: markdownNote(), targetDate: '', status: 'Planned', archived: false, milestones: [] }); this.changed(); this.renderDetail(); })); goals.append(goalHead);
    for (const g of d.objectives.filter(g => !g.archived)) goals.append(this.goalCard(g));
    if (!d.objectives.some(g => !g.archived)) goals.append(el('p', 'Add a shared research direction, skill, or milestone.', 'student-muted'));
    const archived = d.objectives.filter(g => g.archived); if (archived.length) { const details = el('details'); details.append(el('summary', `Archived objectives (${archived.length})`)); archived.forEach(g => details.append(this.goalCard(g))); goals.append(details); }
    main.append(this.preparation, history); columns.append(main, goals);
    const undo = el('div', '', 'student-undo'); undo.hidden = !this.undo; undo.append(el('span', 'Item removed. '), this.button('Undo removal', () => { this.undo.array.splice(this.undo.index, 0, this.undo.item); this.undo = null; this.changed(); this.renderDetail(); }));
    this.parent.replaceChildren(head, statusRow, this.conflictBar, undo, profile, columns);
    if (this.readOnly) {
      const banner = el('div', '', 'student-readonly'); banner.append(el('span', 'Already being edited in another tab. This view is read-only. '), this.button('Edit here when available', () => this.reclaim(), 'student-navigation')); this.parent.insertBefore(banner, profile);
      for (const b of this.parent.querySelectorAll('button:not(.student-navigation)')) b.disabled = true;
    }
    this.updateStatus();
  }
  participantsFields(target, editing) {
    const wrap = el('section', '', 'group-participants');
    this.previewing = !editing;
    wrap.append(this.select('Session type', target.type, [['Workshop','Workshop'],['Roundtable','Roundtable']], type => {
      const defaults = defaultParticipants(this.data, target.type);
      if (JSON.stringify([...target.participantIds].sort()) !== JSON.stringify(defaults.sort()) && !confirm('Changing session type resets the manually selected participants. Continue?')) { this.renderDetail(); return; }
      target.type = type; target.participantIds = defaultParticipants(this.data, type); this.renderDetail();
    }));
    const ids = [...new Set([...this.data.memberIds, ...target.participantIds])];
    wrap.append(el('h3', 'Participants'));
    for (const id of ids) {
      const selected = target.participantIds.includes(id);
      if (!editing) { if (selected) wrap.append(el('span', this.name(id), 'group-participant-name')); continue; }
      const b = this.button(this.name(id), () => {
        if (selected && target.participantIds.length === 1) { this.notice('Keep at least one participant.'); return; }
        target.participantIds = selected ? target.participantIds.filter(value => value !== id) : [...target.participantIds, id]; this.changed(); this.renderDetail();
      }); b.setAttribute('aria-pressed', String(selected)); b.setAttribute('aria-label', `Participant: ${this.name(id)}`); wrap.append(b);
    }
    return wrap;
  }
  addSession() {
    const p = this.data.preparation, s = newGroupSession(crypto.randomUUID(), this.data, p.date || localDate(), p.type);
    s.title = p.title; s.participantIds = [...p.participantIds]; s.discussion = clone(p.agenda); this.data.sessions.push(s); this.openSessions.add(s.id); return s;
  }
  renderPreparation() {
    const p = this.data.preparation; this.preparation.append(this.sectionHeading('Next Session', 'preparation')); this.previewing = !this.editing('preparation');
    this.preparation.append(this.field('Session topic', p.title, v => { p.title = v; }), this.field('Next session date', p.date, v => { p.date = v; }, 'date'), this.participantsFields(p, this.editing('preparation')));
    this.previewing = !this.editing('preparation'); this.preparation.append(this.rich('Next session agenda', p.agenda, v => { p.agenda = v; })); this.previewing = false;
    const start = async schedule => {
      if (this.starting || this.readOnly) return;
      this.starting = true; this.parent.inert = true;
      const before = clone(this.data), s = this.addSession();
      this.data.preparation = { title: '', date: '', type: p.type, participantIds: defaultParticipants(this.data, p.type), agenda: markdownNote() }; this.changed();
      try { await this.save(); this.editingSections.add('history'); this.renderDetail(); }
      catch (e) { if (this.saved === JSON.stringify(before)) { this.data = before; this.cache(); } throw e; }
      finally { this.starting = false; this.parent.inert = false; }
      if (schedule) await this.scheduleSession(s);
    };
    this.preparation.append(this.button('Start session', () => start(false)), this.button('Schedule session', () => start(true)));
    for (const event of this.calendar.events.filter(e => e.groupId === this.data.id && Date.parse(e.start) >= Date.now()).sort((a,b) => a.start.localeCompare(b.start))) this.preparation.append(this.button(`${new Date(event.start).toLocaleString()} · ${event.title}`, () => this.focusSession(event.groupSessionId), 'student-navigation'));
    this.pendingActions = el('div', '', 'student-pending-actions'); this.preparation.append(this.pendingActions); this.refreshPreparation();
  }
  refreshPreparation() {
    if (!this.pendingActions || !this.data) return;
    const actions = this.data.sessions.flatMap(s => s.actions.filter(a => !a.done).map(a => [s,a]));
    this.pendingActions.replaceChildren(el('h3', `Unfinished actions (${actions.length})`));
    for (const [s,a] of actions) this.pendingActions.append(this.button(`${a.text || 'Untitled action'} · ${a.owner === 'Students' ? a.assigneeIds.map(id => this.name(id)).join(', ') : a.owner}`, () => this.focusSession(s.id), 'student-navigation'));
  }
  drawGoalHistory(goal, links) { super.drawGoalHistory(goal, links); links.querySelector('h3').textContent = 'Related sessions'; }
  filterSessions() {
    if (!this.sessionList) return; const q = this.historyQuery.toLocaleLowerCase();
    for (const s of this.data.sessions) { const card = this.sessionList.querySelector(`[data-session="${s.id}"]`); if (card) card.hidden = ![s.title,s.date,s.type,...s.participantIds.map(id => this.name(id)),richText(s.discussion),richText(s.decisions),richText(s.correction),...s.actions.map(a => a.text)].join(' ').toLocaleLowerCase().includes(q); }
  }
  focusSession(id) { this.historyQuery = ''; this.openSessions.add(id); this.renderDetail(); const card = this.parent.querySelector(`[data-session="${id}"]`); card?.scrollIntoView({ block: 'start' }); }
  focusMatch(match) { if (match?.sessionId) this.focusSession(match.sessionId); else { const target = match?.goalId ? this.parent.querySelector(`[data-goal="${match.goalId}"]`) : this.preparation; if (target) { for (let p=target.parentElement;p && p!==this.parent;p=p.parentElement) if(p.tagName==='DETAILS')p.open=true; target.scrollIntoView({block:'center'}); } } }
  sessionCard(s) {
    const card = el('details', '', 'student-session student-panel'); card.dataset.session = s.id; card.open = this.openSessions.has(s.id); const event = this.calendar.events.find(e => e.groupId === this.data.id && e.groupSessionId === s.id);
    const summary = el('summary', `${event ? localInput(event.start).slice(0,10) : s.date} · ${s.type} · ${s.title || 'Untitled session'}`); card.append(summary);
    let mounted = false; const mount = () => {
      if (mounted) return; mounted = true; const editing = this.editing('history'); this.previewing = !editing;
      const body = el('div', '', 'student-session-body');
      body.append(this.field('Session date', s.date, v => { s.date = v; }, 'date'), this.field('Session title', s.title, v => { s.title = v; }), this.participantsFields(s, editing)); this.previewing = !editing;
      for (const [key,label] of [['discussion','Discussion'],['decisions','Decisions'],['correction','Correction']]) body.append(this.rich(label, s[key], v => { s[key] = v; }));
      const links = el('section', '', 'student-goal-links'); links.append(el('h3', 'Related objectives'));
      for (const g of this.data.objectives) links.append(this.checkbox(g.title || 'Untitled objective', s.objectiveIds.includes(g.id), checked => { s.objectiveIds = checked ? [...s.objectiveIds, g.id] : s.objectiveIds.filter(id => id !== g.id); this.refreshGoalHistories(); })); body.append(links);
      const actions = el('section', '', 'student-action-list'); actions.append(el('h3','Follow-up actions'));
      for (const a of s.actions) {
        const row = el('div', '', 'group-action'); this.previewing = !editing;
        row.append(this.checkbox('Action completed', a.done, v => { a.done = v; }), this.field('Action', a.text, v => { a.text = v; }), this.select('Owner', a.owner, [['Students','Named students'],['Group','Group'],['Supervisor','Supervisor']], owner => { a.owner = owner; a.assigneeIds = owner === 'Students' ? [s.participantIds[0]] : []; this.renderDetail(); }), this.field('Due date', a.dueDate, v => { a.dueDate = v; }, 'date'), this.select('Linked objective', a.objectiveId, [['','No objective'],...this.data.objectives.map(g => [g.id,g.title || 'Untitled objective'])], v => { a.objectiveId = v; this.refreshGoalHistories(); }));
        if (a.owner === 'Students') for (const id of [...new Set([...this.data.memberIds,...s.participantIds,...a.assigneeIds])]) row.append(this.checkbox(`Assign: ${this.name(id)}`, a.assigneeIds.includes(id), checked => { if (!checked && a.assigneeIds.length === 1) { this.notice('Keep at least one student owner.'); this.renderDetail(); return; } a.assigneeIds = checked ? [...a.assigneeIds,id] : a.assigneeIds.filter(value => value!==id); }));
        if (editing) row.append(this.button('Remove action', () => this.remove(s.actions,a,'action'))); actions.append(row);
      }
      if (editing) actions.append(this.button('Add action', () => { s.actions.push({ id: crypto.randomUUID(), text: '', owner: 'Group', assigneeIds: [], dueDate: '', done: false, objectiveId: '' }); this.changed(); this.renderDetail(); })); body.append(actions); this.previewing = false;
      body.append(this.materials(s,editing));
      if (event) body.append(el('p', `Booked: ${new Date(event.start).toLocaleString()} · ${event.durationMinutes ? `${event.durationMinutes} minutes` : `until ${new Date(event.end).toLocaleString()}`} · ${event.participantIds.map(id => this.name(id)).join(', ')}`));
      body.append(this.button(event ? 'Reschedule session' : 'Schedule this session', () => this.scheduleSession(s)));
      if (event) { const a=el('a','Open in Calendar');a.href=`?view=calendar&date=${localInput(event.start).slice(0,10)}&event=${event.id}`;a.onclick=async e=>{if(e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();if(await this.flush())location.href=a.href;};body.append(a); }
      if (editing) body.append(this.button('Remove session', () => { if (event) throw new Error('Cancel the booking in Calendar before removing this session.'); this.remove(this.data.sessions,s,'session'); }));
      card.append(body); if(this.readOnly)for(const b of body.querySelectorAll('button'))b.disabled=true;
    };
    card.ontoggle=()=>{if(card.open){this.openSessions.add(s.id);mount();}else this.openSessions.delete(s.id);};if(card.open)mount();return card;
  }
  materials(s,editing) {
    const section=el('section','','group-materials');section.append(el('h3','Presentation materials (optional)'));
    for(const a of s.attachments){const row=el('div','','group-material');const href=`/api/groups/${this.data.id}/attachments/${a.id}`;const link=el('a',a.name);link.href=href;row.append(link);
      if(/\.pdf$/i.test(a.name)){const preview=el('a','Preview PDF');preview.href=href+'?preview=true';preview.target='_blank';preview.rel='noopener';row.append(preview);}
      if(editing)row.append(this.button('Detach presentation',()=>{s.attachments=s.attachments.filter(item=>item.id!==a.id);this.changed();this.renderDetail();}));section.append(row);}
    if(editing){const input=el('input');input.type='file';input.accept='.pdf,.ppt,.pptx,.key';input.multiple=true;input.setAttribute('aria-label','Attach presentations');input.disabled=this.readOnly;
      input.onchange=async()=>{if(this.uploading)return;this.uploading=true;this.parent.inert=true;input.disabled=true;this.updateStatus();try{await this.save();for(const file of input.files){if(file.size>100*1024*1024)throw new Error('Presentation files are limited to 100 MB.');const response=await fetch(`/api/groups/${this.data.id}/attachments?name=${encodeURIComponent(file.name)}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});const data=await response.json();if(!response.ok)throw new Error(data.error);s.attachments.push(data);this.changed();await this.save();}this.renderDetail();}catch(e){this.notice(e.message);}finally{this.uploading=false;this.parent.inert=false;input.disabled=false;this.updateStatus();}};section.append(input,el('small','PDF, PPT, PPTX or Keynote · up to 100 MB per file'));}return section;
  }
  async scheduleSession(s) {
    if (this.readOnly) return;
    await this.save();
    if (this.parent.querySelector('.group-schedule-dialog[open]')) return;
    const existing=this.calendar.events.find(e=>e.groupId===this.data.id&&e.groupSessionId===s.id);
    const dialog=el('dialog','','student-dialog group-schedule-dialog');dialog.setAttribute('aria-label','Schedule group session');const form=el('form');const fields={};
    for(const [key,label,type,value]of [['start','Starting time','datetime-local',existing?localInput(existing.start):`${s.date}T10:00`],['duration','Duration in minutes','number',existing?.durationMinutes||(existing?.end?'':s.type==='Workshop'?60:30)],['end','End time (optional)','datetime-local',existing?.end?localInput(existing.end):''],['location','Location','text',existing?.location||'']]){const wrap=el('label','','student-field'),input=el('input');input.type=type;input.value=value;input.setAttribute('aria-label',label);if(key==='start')input.required=true;if(key==='duration'){input.min='1';input.step='1';}fields[key]=input;wrap.append(el('span',label),input);form.append(wrap);}
    const bookingKey = `group-booking:${this.data.id}:${s.id}`;
    try { const cached = JSON.parse(localStorage.getItem(bookingKey)); for (const [key, value] of Object.entries(cached || {})) if (fields[key] && typeof value === 'string' && value.length <= 10000) fields[key].value = value; } catch { /* Keep the saved booking defaults. */ }
    const persist = () => { try { localStorage.setItem(bookingKey, JSON.stringify(Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value])))); } catch { /* Disk notes remain saved. */ } };
    const clearDraft = () => { try { localStorage.removeItem(bookingKey); } catch { /* Browser storage is optional. */ } };
    persist();
    const candidate=()=>{const e={id:s.id,groupId:this.data.id,groupSessionId:s.id,participantIds:[...s.participantIds],title:existing?.title||`${this.data.name} · ${s.type}${s.title?` · ${s.title}`:''}`,categoryId:groupCategoryId,start:utcFromLocal(fields.start.value),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,location:fields.location.value.trim()};if(fields.end.value)e.end=utcFromLocal(fields.end.value);else e.durationMinutes=Number(fields.duration.value);return e;};
    const preview=el('section','','conversation-preview');preview.setAttribute('aria-label','Group availability');const error=el('p','','form-error');error.setAttribute('role','alert');const submit=el('button','Save booking');submit.type='submit';const close=this.button('Cancel',()=>{clearDraft();dialog.close();});let request=0,checkingTimer;
    const show=checked=>{preview.replaceChildren(el('h3','Participant availability'));for(const p of checked.participants)preview.append(el('p',`${p.name}: ${p.incomplete?'availability incomplete':p.conflicts.length?'conflicts':'no conflicts'}`));for(const c of checked.conflicts)preview.append(el('p',c.title,'timetable-warning'));if(checked.past)preview.append(el('p','Selected time is in the past.','timetable-warning'));preview.append(el('h3','Shared available times'));for(const slot of checked.slots){const b=this.button(`${new Date(slot.start).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}–${new Date(slot.end).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`,()=>{fields.start.value=localInput(slot.start);if(fields.end.value)fields.end.value=localInput(slot.end);persist();update();});preview.append(b);}if(!checked.slots.length)preview.append(el('p','No shared available times on this date.'));};
    const update=async()=>{const current=++request;try{const checked=await this.api(`/api/groups/${this.data.id}/check`,'POST',{event:candidate()});if(current===request&&dialog.open)show(checked);}catch(e){if(current===request&&dialog.open)preview.replaceChildren(el('p',`Availability could not be checked: ${e.message}`));}};
    form.oninput=e=>{if(e.target===fields.end&&fields.end.value)fields.duration.value='';if(e.target===fields.duration&&fields.duration.value)fields.end.value='';persist();clearTimeout(checkingTimer);checkingTimer=setTimeout(update,200);};
    form.onsubmit=async e=>{e.preventDefault();if(submit.disabled)return;submit.disabled=true;close.disabled=true;request++;clearTimeout(checkingTimer);Object.values(fields).forEach(f=>f.disabled=true);
      try{const event=candidate(),checked=await this.api(`/api/groups/${this.data.id}/check`,'POST',{event});show(checked);if(checked.conflicts.length&&!confirm(`This group session conflicts with ${checked.conflicts.map(c=>c.title).join(', ')}. Save this conflicting booking?`))return;
        const calendar=await this.api('/api/calendar');if(calendar.revision!==checked.calendarRevision)throw new Error('Calendar changed. Check availability and retry.');const previous=calendar.document.events.find(e=>e.id===event.id);if(previous&&!previous.groupId)throw new Error('This session ID conflicts with an existing event.');calendar.document.events=calendar.document.events.filter(e=>e.id!==event.id);calendar.document.events.push(event);
        const saved=await this.api('/api/calendar','PUT',{document:calendar.document,revision:calendar.revision,acknowledgements:{[event.id]:checked.acknowledgement}});this.calendar=saved.document;clearDraft();dialog.close();this.renderDetail();
      }catch(e){error.textContent=e.message;}finally{submit.disabled=false;close.disabled=false;Object.values(fields).forEach(f=>f.disabled=false);}};
    form.append(preview,error,submit,close);dialog.append(el('h2','Schedule group session'),form);this.parent.append(dialog);dialog.addEventListener('cancel',e=>{if(submit.disabled)e.preventDefault();else clearDraft();});dialog.addEventListener('close',()=>{request++;clearTimeout(checkingTimer);clearInterval(refreshTimer);dialog.remove();});dialog.showModal();const refreshTimer=setInterval(update,15000);update();fields.start.focus();
  }
}
