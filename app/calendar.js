import { SchedulingConflicts, participantAvailability } from './scheduling-conflicts.js';
import { classesOnDate } from '../timetable-model.js';
import './timetables.css';
import { validateCalendar, localInput, utcFromLocal, sortedEvents, eventEnd } from '../calendar-model.js';
import { localDate, validDate } from '../daily-model.js';
import './calendar.css';
const el = (tag, text = '', cls = '') => { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; };
const clone = value => structuredClone(value);
function download(value, name) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const a = el('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
export class CalendarWorkspace {
  constructor({ parent, api, notice, prepare, enter, navigate, reminders }) {
    Object.assign(this, { parent, api, notice, prepare, enter, navigate, reminders });
    window.addEventListener('pagehide', () => { this.cache(); this.release(); });
    window.addEventListener('pageshow', e => { if (e.persisted && this.data) this.claim(); });
    window.addEventListener('focus', () => this.checkExternal());
    this.interval = setInterval(() => { if (!document.hidden) this.checkExternal(); }, 3000);
  }
  get url() { return `?view=calendar&date=${this.date}`; }
  get dirty() { return !!this.data && !this.readOnly && JSON.stringify(this.data) !== this.saved; }
  draftKey() { return 'fieldnotes-calendar-draft'; }
  cache() { if (!this.data || this.readOnly) return; try { if (this.dirty) localStorage.setItem(this.draftKey(), JSON.stringify({ document: this.data, revision: this.revision })); else localStorage.removeItem(this.draftKey()); } catch { /* Disk saving remains available. */ } }
  release() { this.unlock?.(); this.unlock = null; }
  async acquire() {
    if (this.unlock) return true;
    if (!navigator.locks) return false;
    return new Promise((resolve, reject) => navigator.locks.request('fieldnotes:calendar', { ifAvailable: true }, async lock => { if (!lock) { resolve(false); return; } const held = new Promise(done => { this.unlock = done; }); resolve(true); await held; }).catch(reject));
  }
  close() { clearTimeout(this.timer); this.cache(); this.release(); this.data = null; this.saved = ''; this.status = null; this.blocked = this.conflict = this.formDirty = false; }
  load(result, recover = false) {
    this.data = clone(result.document); this.saved = JSON.stringify(this.data); this.revision = result.revision; this.savedAt = result.savedAt; this.blocked = this.conflict = false;
    if (recover && !this.readOnly) try {
      const draft = JSON.parse(localStorage.getItem(this.draftKey()));
      if (draft?.document?.id === this.data.id && JSON.stringify(draft.document) !== this.saved) { validateCalendar(draft.document); this.data = draft.document; this.blocked = true; this.conflict = draft.revision !== result.revision; this.notice('Recovered your Calendar draft. Review it and retry save or resolve the conflict.'); }
    } catch { this.notice('The Calendar browser draft could not be read. Disk data is preserved.'); }
  }
  async flush() { try { await this.save(); return !this.dirty && !this.conflict; } catch (e) { this.notice(e.message); return false; } }
  async save() {
    clearTimeout(this.timer); if (this.saving) { await this.saving; return this.save(); }
    if (this.conflict) throw new Error('Resolve the Calendar disk conflict before saving or leaving.');
    if (this.formDirty) throw new Error('Save or cancel the event form before leaving.');
    if (!this.dirty) { this.blocked = false; this.updateStatus(); return; }
    const document = clone(this.data), revision = this.revision;
    this.saving = (async () => {
      try { const result = await this.api('/api/calendar', 'PUT', { document, revision, acknowledgements: this.acknowledgements || {} }); this.saved = JSON.stringify(document); this.revision = result.revision; this.savedAt = result.savedAt; this.blocked = false; this.cache(); this.reminders.check(); }
      catch (e) { this.blocked = true; this.conflict = e.status === 409; this.cache(); this.notice(e.message); throw e; }
      finally { this.saving = null; this.updateStatus(); }
    })(); this.updateStatus(); await this.saving;
    if (this.dirty) this.timer = setTimeout(() => this.save().catch(() => {}), 750);
  }
  loadDaily(result) {
    const completed = new Set(result.document.tasks.filter(task => task.calendarEvent && !task.calendarEvent.deleted && task.versions.at(-1)?.status === 'completed').map(task => task.id));
    const changed = completed.size !== this.completedEventIds?.size || [...completed].some(id => !this.completedEventIds.has(id));
    this.completedEventIds = completed; this.categories = result.document.categories;
    return changed;
  }
  async checkExternal() {
    if (!this.data || this.parent.inert || this.checking || this.saving || this.parent.querySelector('dialog[open]')) return;
    this.checking = true; const observed = this.data;
    try {
      const [latest, daily] = await Promise.all([this.api('/api/calendar'), this.api('/api/daily')]);
      if (this.data !== observed || this.saving || this.parent.querySelector('dialog[open]')) return;
      const completionChanged = this.loadDaily(daily);
      if (latest.revision !== this.revision) {
        if (this.dirty) { clearTimeout(this.timer); this.blocked = this.conflict = true; this.cache(); this.updateStatus(); }
        else { this.load(latest); this.render(); }
      }
      if (completionChanged || this.renderMinute !== Math.floor(Date.now() / 60000)) this.render();
    } catch (e) { this.notice(e.message); } finally { this.checking = false; }
  }
  async claim() {
    if (this.claiming) return; this.claiming = true; this.parent.inert = true;
    try { if (this.saving) await this.saving.catch(() => {}); this.cache(); this.readOnly = !await this.acquire(); this.load(await this.api('/api/calendar'), true); this.render(); }
    finally { this.claiming = false; this.parent.inert = false; }
  }
  button(label, action, mutation = false) { const b = el('button', label); b.type = 'button'; b.disabled = mutation && this.readOnly; b.onclick = () => Promise.resolve().then(action).catch(e => this.notice(e.message)); return b; }
  updateStatus() {
    if (!this.status) return;
    this.status.textContent = this.readOnly ? 'Read-only · another tab may be editing Calendar' : this.conflict ? 'Conflict · draft preserved' : this.saving ? 'Saving…' : this.blocked ? 'Save failed · draft preserved' : this.dirty ? 'Unsaved changes' : `Saved to disk · ${new Date(this.savedAt).toLocaleString()}`;
    this.conflictBar.hidden = !this.conflict;
  }
  async compare(overwrite = false) {
    const latest = await this.api('/api/calendar'); const dialog = this.dialog('Calendar disk conflict'); const columns = el('div', '', 'calendar-compare');
    for (const [label, value] of [['Your draft', this.data], ['Disk version', latest.document]]) { const section = el('section'); section.append(el('h3', label), el('pre', JSON.stringify(value, null, 2))); columns.append(section); } dialog.append(columns);
    if (overwrite) dialog.append(this.button('Replace reviewed disk version', async () => { if (!confirm('Replace this reviewed disk version with your draft?')) return; this.revision = latest.revision; this.conflict = false; this.blocked = false; dialog.close(); await this.save(); this.render(); }, true));
  }
  async open(date = localDate(), push = true) {
    if (!validDate(date)) { this.notice('Choose a valid calendar date.'); return false; }
    if (!await this.prepare()) return false;
    this.parent.inert = true;
    try {
      await this.api('/api/calendar');
      const [daily, academic, records] = await Promise.all([this.api('/api/daily'), this.api('/api/timetables'), this.api('/api/students/export')]);
      this.loadDaily(daily); this.academic = academic.document; this.students = records.students; this.overlayIds ||= new Set(); await this.enter();
      this.readOnly = !await this.acquire(); this.load(await this.api('/api/calendar'), true);
      this.date = date; this.render();
      if (push && location.search !== this.url) history.pushState(null, '', this.url);
      document.title = 'Calendar · Workbench';
      if (!this.readOnly) {
        let form; try { form = JSON.parse(localStorage.getItem('fieldnotes-calendar-form')); } catch { /* invalid cache */ }
        if (form?.calendarId === this.data.id) this.edit(this.data.events.find(e => e.id === form.id), form);
      }
      return true;
    } catch (e) { this.notice(e.message); return false; }
    finally { this.parent.inert = false; }
  }
  dialog(title) {
    const dialog = el('dialog', '', 'calendar-dialog'); dialog.setAttribute('aria-label', title); dialog.append(el('h2', title));
    dialog.append(this.button('Close', () => dialog.close())); this.parent.append(dialog);
    dialog.addEventListener('close', () => dialog.remove()); dialog.showModal(); return dialog;
  }
  render() {
    this.renderMinute = Math.floor(Date.now() / 60000);
    const heading = el('header'); heading.append(el('h1', 'Calendar'));
    const actions = el('div', '', 'calendar-actions');
    const move = amount => { const d = new Date(`${this.date.slice(0, 7)}-01T12:00:00`); d.setMonth(d.getMonth() + amount); return this.navigate(localDate(d)); };
    actions.append(this.button('Previous month', () => move(-1)), this.button('Today', () => this.navigate(localDate())), this.button('Next month', () => move(1)), Object.assign(this.button('Add event', () => this.edit(), true), { id: 'calendar-add-event' }));
    const picker = el('input'); picker.type = 'date'; picker.value = this.date; picker.setAttribute('aria-label', 'Calendar date'); picker.onchange = async () => { if (!await this.navigate(picker.value)) picker.value = this.date; }; actions.append(picker);
    actions.append(this.button('Export JSON', async () => { if (await this.flush()) download(await this.api('/api/calendar/export'), 'workbench-calendar.json'); }));
    const enable = this.button('Enable system notifications', async () => { await this.reminders.enable(); this.render(); }); actions.append(enable);
    actions.append(this.button(this.reminders.sound.enabled ? 'Mute reminder sound' : 'Enable reminder sound', () => { this.reminders.sound.toggle(); this.render(); }), this.button('Test reminder sound', async () => { if (!await this.reminders.sound.test()) this.notice(this.reminders.sound.enabled ? 'Audio playback is unavailable or blocked. Check your browser and device sound settings.' : 'Enable reminder sound before testing.'); }));
    const overlays = el('details'); overlays.append(el('summary', 'Student class overlays'));
    for (const student of this.students || []) { const label = el('label'), box = el('input'); box.type = 'checkbox'; box.checked = this.overlayIds.has(student.id); box.setAttribute('aria-label', `Show classes: ${student.profile.name}`); box.onchange = () => { if (box.checked) this.overlayIds.add(student.id); else this.overlayIds.delete(student.id); this.render(); }; label.append(box, el('span', student.profile.name)); overlays.append(label); }
    heading.append(overlays);
    heading.append(actions, el('p', `Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Reminders appear 10 minutes before events while Workbench is open. ${this.reminders.permissionText()} ${this.reminders.sound.text()}`, 'calendar-muted'));
    this.status = el('span'); this.status.setAttribute('role', 'status'); const statusRow = el('div', '', 'calendar-actions calendar-status');
    statusRow.append(this.status, this.button('Retry save', async () => { await this.save(); this.render(); }, true), this.button('Export draft', () => download({ document: this.data, revision: this.revision }, 'workbench-calendar-draft.json')));
    if (this.readOnly) statusRow.append(this.button('Claim editing', () => this.claim()));
    this.conflictBar = el('div', '', 'calendar-conflict'); this.conflictBar.append(el('p', 'Your draft is preserved. Review the disk version before resolving the conflict.'), this.button('Compare', () => this.compare()), this.button('Reload disk version', async () => { if (!confirm('Discard the Calendar draft and load the disk version?')) return; this.load(await this.api('/api/calendar')); this.cache(); this.render(); }, true), this.button('Overwrite with draft', () => this.compare(true), true));
    const layout = el('div', '', 'calendar-layout'), month = el('section', '', 'calendar-panel');
    const first = new Date(`${this.date.slice(0, 7)}-01T12:00:00`);
    month.append(el('h2', first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })));
    const grid = el('div', '', 'calendar-grid'); grid.setAttribute('aria-label', 'Month calendar');
    for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) grid.append(el('span', day, 'calendar-weekday'));
    const offset = (first.getDay() + 6) % 7, count = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    for (let i = 0; i < offset; i++) grid.append(el('span'));
    for (let day = 1; day <= count; day++) {
      const date = `${this.date.slice(0, 7)}-${String(day).padStart(2, '0')}`, events = this.data.events.filter(e => localInput(e.start).slice(0, 10) === date);
      const button = this.button(String(day), () => this.navigate(date)); button.className = 'calendar-day'; button.setAttribute('aria-label', `${date}, ${events.length} events`); button.setAttribute('aria-pressed', String(date === this.date));
      if (date === localDate()) button.classList.add('calendar-today');
      const classCount = (this.students || []).filter(s => this.overlayIds.has(s.id)).reduce((n,s) => n + classesOnDate(s,this.academic,date).classes.length,0);
      if (classCount) button.append(el('small', `${classCount} classes`));
      if (events.length) button.append(el('small', `${events.length} ${events.length === 1 ? 'event' : 'events'}`)); grid.append(button);
    }
    month.append(grid);
    const dayPanel = el('section', '', 'calendar-panel'); dayPanel.append(el('h2', `Events · ${this.date}`));
    const selected = sortedEvents(this.data.events).filter(e => localInput(e.start).slice(0, 10) === this.date);
    if (!selected.length) dayPanel.append(el('p', 'No events on this date.', 'calendar-muted')); selected.forEach(e => dayPanel.append(this.eventRow(e)));
    for (const student of (this.students || []).filter(s => this.overlayIds.has(s.id))) { const result = classesOnDate(student, this.academic, this.date);
      if (result.incomplete) dayPanel.append(el('p', `${student.profile.name}: availability incomplete`, 'timetable-warning'));
      for (const c of result.classes) dayPanel.append(el('p', `${c.localStart}–${c.localEnd} ${student.profile.name} · ${c.name} · ${c.location}`, 'timetable-course'));
    }
    const agenda = el('section', '', 'calendar-panel calendar-agenda'); agenda.append(el('h2', 'Upcoming agenda'));
    const upcoming = sortedEvents(this.data.events).filter(e => Date.parse(e.start) >= Date.now());
    if (!upcoming.length) agenda.append(el('p', 'No upcoming events. Add one to get a reminder.', 'calendar-muted')); upcoming.forEach(e => agenda.append(this.eventRow(e)));
    layout.append(month, dayPanel); this.parent.replaceChildren(heading, statusRow, this.conflictBar, layout, agenda); this.updateStatus();
  }
  eventRow(event) {
    const row = el('article', '', 'calendar-event'); row.dataset.event = event.id;
    row.classList.toggle('completed', this.completedEventIds?.has(event.id) || false);
    row.append(el('h3', event.title));
    if (row.classList.contains('completed')) row.append(el('span', 'Completed in Daily', 'calendar-completed-label'));
    row.append(el('p', new Date(event.start).toLocaleString()));
    if (event.groupId) { const link = el('a', 'Open group session'); link.href = `?view=group&id=${event.groupId}&session=${event.groupSessionId}`; link.onclick = async e => { if(e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();if(await this.flush())location.href=link.href; }; row.append(link); }
    if (event.studentId) row.append(el('p', `Student: ${this.students?.find(s => s.id === event.studentId)?.profile.name || 'Unavailable student'}`));
    if (event.location) row.append(el('p', event.location));
    const end = eventEnd(event);
    if (end) row.append(el('p', `Ends ${new Date(end).toLocaleString()}`));
    const actions = el('div', '', 'calendar-actions'); actions.append(this.button('Edit event', () => this.edit(event), true), this.button('Delete event', async () => {
      if (!confirm(`Delete “${event.title}”?`)) return; this.data.events = this.data.events.filter(e => e.id !== event.id); this.cache(); await this.save(); this.render();
    }, true)); row.append(actions); return row;
  }
  edit(event, recovered, defaults = {}) {
    if (this.readOnly) { this.notice('Calendar is read-only in this tab. Claim editing before scheduling.'); return; }
    if (this.parent.querySelector('dialog[open]')) return;
    const dialog = this.dialog(event ? 'Edit event' : 'Add event');
    const form = el('form'), fields = {};
    const startingTime = recovered?.start ?? (event ? localInput(event.start) : `${this.date}T${localInput(new Date()).slice(11)}`);
    const endingTime = recovered?.end ?? (event?.end ? localInput(event.end) : '');
    let startingDate = startingTime.slice(0, 10);
    for (const [name, label, type, value] of [['title', 'Title', 'text', event?.title || defaults.title || ''], ['start', 'Starting time', 'datetime-local', startingTime], ['location', 'Location (optional)', 'text', event?.location || ''], ['duration', 'Duration in minutes (optional)', 'number', event?.durationMinutes || defaults.duration || ''], ['endDate', 'End date (optional)', 'date', recovered?.endDate ?? (endingTime.includes('T') ? endingTime.slice(0, 10) : startingDate)], ['end', 'End time (optional)', 'time', endingTime.includes('T') ? endingTime.slice(11) : endingTime]]) {
      const wrap = el('label', '', 'calendar-field'), input = el('input'); wrap.append(el('span', label)); input.type = type; input.value = name === 'end' ? value : recovered?.[name] ?? value; input.setAttribute('aria-label', label);
      if (name === 'title' || name === 'start') input.required = true;
      if (name === 'title' || name === 'location') input.maxLength = 10000;
      if (name === 'duration') { input.min = '1'; input.step = '1'; } fields[name] = input; wrap.append(input); form.append(wrap);
    }
    const categoryWrap = el('label', '', 'calendar-field'), category = el('select');
    category.setAttribute('aria-label', 'Category (optional)');
    const automatic = el('option', 'Miscellaneous (default)'); automatic.value = ''; category.append(automatic);
    for (const item of this.categories || []) {
      if (item.hidden && item.id !== event?.categoryId) continue;
      const option = el('option', item.name); option.value = item.id; category.append(option);
    }
    category.value = recovered?.categoryId ?? event?.categoryId ?? defaults.categoryId ?? ''; fields.categoryId = category;
    categoryWrap.append(el('span', 'Category (optional)'), category); form.append(categoryWrap);
    const studentWrap = el('label', '', 'calendar-field'), studentSelect = el('select'); studentSelect.setAttribute('aria-label', 'Conversation student');
    for (const [id, name] of [['', 'No student'], ...(this.students || []).map(s => [s.id, s.profile.name])]) { const option = el('option', name); option.value = id; studentSelect.append(option); }
    studentSelect.value = recovered?.studentId ?? event?.studentId ?? defaults.studentId ?? ''; fields.studentId = studentSelect;
    studentWrap.append(el('span', 'Conversation student'), studentSelect); if (!event?.groupId) form.append(studentWrap);
    const preview = el('section', '', 'conversation-preview'); preview.setAttribute('aria-label', 'Conversation timetable'); form.append(preview);
    const makeCandidate = () => {
      const candidate = { id: event?.id || (this.formEventId ||= crypto.randomUUID()), title: fields.title.value.trim() || 'Conversation', start: utcFromLocal(fields.start.value), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
      if (event?.groupId) Object.assign(candidate, { groupId: event.groupId, groupSessionId: event.groupSessionId, participantIds: [...event.participantIds] });
      if (fields.studentId.value && !event?.groupId) candidate.studentId = fields.studentId.value;
      if (fields.categoryId.value) candidate.categoryId = fields.categoryId.value;
      if (fields.location.value.trim()) candidate.location = fields.location.value.trim();
      if (fields.end.value !== '') candidate.end = utcFromLocal(`${fields.endDate.value}T${fields.end.value}`);
      if (fields.duration.value !== '') candidate.durationMinutes = Number(fields.duration.value);
      if (candidate.studentId) {
        const name = this.students.find(s => s.id === candidate.studentId)?.profile.name;
        if (name && !candidate.title.includes(name)) candidate.title = `${name} · ${candidate.title}`;
        candidate.categoryId = this.categories.find(c => c.name === 'Students')?.id || 'category-1';
      }
      return candidate;
    };
    const conflicts = new SchedulingConflicts(() => this.students.find(s => s.id === fields.studentId.value)?.profile.name || 'Student');
    let expiryTimer;
    const showCheck = checked => {
      clearTimeout(expiryTimer);
      preview.replaceChildren(el('h3', event?.groupId ? 'Group availability' : 'Student timetable'));
      preview.append(participantAvailability(checked));
      if (checked.past) preview.append(el('p', 'The selected starting time is in the past.', 'timetable-warning'));
      if (checked.incomplete) preview.append(el('p', 'Availability incomplete: missing timetable or pending course details.', 'timetable-warning'));
      for (const c of checked.classes) preview.append(el('p', `${c.localStart}–${c.localEnd} ${c.name} · ${c.location}`));
      if (!checked.classes.length) preview.append(el('p', 'No confirmed classes on this date.'));
      preview.append(conflicts.render(checked));
      preview.append(el('h4', checked.incomplete ? 'Possible slots (availability incomplete)' : 'Free slots on this date'));
      const schoolTime = instant => new Date(instant).toLocaleTimeString('en-GB', { timeZone: checked.timeZone, hour: '2-digit', minute: '2-digit' });
      preview.append(el('p', `08:30–21:30 · ${checked.timeZone} · ${checked.durationMinutes}-minute conversations`, 'calendar-muted'));
      const windows = el('div', '', 'conversation-free-windows'); windows.setAttribute('aria-label', 'Free time windows');
      for (const window of checked.freeWindows) windows.append(el('span', `${schoolTime(window.start)}–${schoolTime(window.end)}`));
      if (!checked.freeWindows.length) windows.append(el('p', 'No future free time within this window.'));
      preview.append(windows);
      const options = el('div', '', 'conversation-slot-options'); options.setAttribute('aria-label', 'Available conversation times');
      for (const slot of checked.slots) {
        const suggestion = this.button(`${schoolTime(slot.start)}–${schoolTime(slot.end)}`, () => {
          if (Date.parse(slot.start) < Date.now()) { this.notice('This slot has passed. Choose a future time.'); updatePreview(); return; }
          fields.start.value = localInput(slot.start); fields.endDate.value = localInput(slot.end).slice(0,10);
          if (fields.end.value) fields.end.value = localInput(slot.end).slice(11);
          else if (!fields.duration.value) fields.duration.value = String(checked.durationMinutes);
          persistForm(); updatePreview();
        });
        suggestion.disabled = submit.disabled; options.append(suggestion);
      }
      if (!checked.slots.length && checked.freeWindows.length) options.append(el('p', 'No free window is long enough for this duration.'));
      preview.append(options);
      const futureStarts = [...checked.freeWindows, ...checked.slots].map(slot => Date.parse(slot.start)).filter(start => start >= Date.now());
      if (futureStarts.length) expiryTimer = setTimeout(() => refreshAvailability(), Math.min(2147483647, Math.max(1, Math.min(...futureStarts) - Date.now() + 1)));
      const checkStatus = el('p', '', 'conversation-check-status'); checkStatus.setAttribute('role', 'status'); preview.append(checkStatus);
    };
    let previewRequest = 0;
    const updatePreview = async () => {
      const request = ++previewRequest;
      preview.hidden = !fields.studentId.value && !event?.groupId; if (preview.hidden) return;
      try {
        if (event?.groupId) {
          const checked = await this.api(`/api/groups/${event.groupId}/check`, 'POST', { event: makeCandidate(), draftEvents: this.data.events });
          if (request === previewRequest && dialog.open && !submit.disabled) showCheck(checked);
          return;
        }
        const student = this.students.find(s => s.id === fields.studentId.value); if (!student) throw new Error('Student unavailable.');
        const candidate = makeCandidate(); if (!candidate.end && candidate.durationMinutes === undefined) candidate.durationMinutes = 30;
        validateCalendar({ ...this.data, events: [candidate] });
        const status = preview.querySelector('.conversation-check-status'); if (status) status.textContent = 'Checking the latest schedule…';
        const checked = await this.api('/api/timetables/check', 'POST', { event: candidate, draftEvents: this.data.events });
        if (request !== previewRequest || !dialog.open || submit.disabled) return;
        showCheck(checked);
      } catch (e) {
        if (request !== previewRequest || !dialog.open || submit.disabled) return;
        conflicts.reset(); preview.replaceChildren();
        preview.append(el('p', `Availability could not be checked: ${e.message}`, 'timetable-warning'));
      }
    };
    const error = el('p', '', 'form-error'); error.setAttribute('role', 'alert'); const submit = el('button', 'Save event', 'primary'); submit.type = 'submit';
    const persistForm = () => { this.formDirty = true; const value = { calendarId: this.data.id, id: event?.id || this.formEventId, ...Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value])) }; try { localStorage.setItem('fieldnotes-calendar-form', JSON.stringify(value)); } catch { /* disk saves still work */ } };
    if (recovered) this.formDirty = true;
    form.append(el('p', 'Choose a duration or an end time. Student conversations require one; other events may leave both blank.', 'calendar-muted'));
    const setStudentDuration = () => { if (fields.studentId.value && !fields.duration.value && !fields.end.value) fields.duration.value = '30'; };
    if (fields.studentId.value && !recovered) setStudentDuration();
    form.oninput = e => {
      if (e.target.closest('.scheduling-conflicts')) return;
      conflicts.reset();
      if (e.target === fields.studentId) setStudentDuration();
      if (e.target === fields.start && fields.start.value) {
        const date = fields.start.value.slice(0, 10);
        if (!fields.endDate.value || fields.endDate.value === startingDate) fields.endDate.value = date;
        startingDate = date;
      }
      if (e.target === fields.end && fields.end.value) fields.duration.value = '';
      if (e.target === fields.duration && fields.duration.value) fields.end.value = '';
      persistForm(); updatePreview();
    };
    const refreshAvailability = () => { if (dialog.open && !submit.disabled && !document.hidden) updatePreview(); };
    const availabilityTimer = setInterval(refreshAvailability, 15000);
    window.addEventListener('focus', refreshAvailability); document.addEventListener('visibilitychange', refreshAvailability);
    dialog.addEventListener('close', () => { clearInterval(availabilityTimer); clearTimeout(expiryTimer); window.removeEventListener('focus', refreshAvailability); document.removeEventListener('visibilitychange', refreshAvailability); ++previewRequest; this.formDirty = false; this.formEventId = null; try { localStorage.removeItem('fieldnotes-calendar-form'); } catch { /* optional cache */ } });
    dialog.addEventListener('cancel', e => { if (submit.disabled) e.preventDefault(); });
    form.onsubmit = async e => {
      e.preventDefault(); if (submit.disabled) return; ++previewRequest; submit.disabled = true;
      Object.values(fields).forEach(input => { input.disabled = true; }); dialog.querySelector('button').disabled = true; preview.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try {
        const candidate = makeCandidate();
        if ((candidate.studentId || candidate.groupId) && !this.dirty && !this.conflict) {
          const latest = await this.api('/api/calendar');
          if (latest.revision !== this.revision) {
            if (event && JSON.stringify(latest.document.events.find(item => item.id === event.id)) !== JSON.stringify(event)) throw new Error('This event changed elsewhere. Your form is preserved; close it and reopen the latest event before saving.');
            this.load(latest);
          }
        }
        if (candidate.studentId || candidate.groupId) {
          const checked = await this.api(candidate.groupId ? `/api/groups/${candidate.groupId}/check` : '/api/timetables/check', 'POST', { event: candidate, draftEvents: this.data.events }); showCheck(checked);
          if (!conflicts.accepted(checked)) { error.textContent = 'Review the conflicts and select “Save despite these conflicts” to continue.'; conflicts.checkbox?.focus(); return; }
          this.acknowledgements ||= {}; this.acknowledgements[candidate.id] = checked.acknowledgement;
        }
        const next = clone(this.data); const index = next.events.findIndex(item => item.id === candidate.id);
        if (index < 0) next.events.push(candidate); else next.events[index] = candidate; validateCalendar(next);
        this.data = next; persistForm(); this.formDirty = false; this.cache(); await this.save(); this.formEventId = null; try { localStorage.removeItem('fieldnotes-calendar-form'); } catch { /* optional cache */ } dialog.close(); this.render(); this.parent.querySelector('#calendar-add-event')?.focus();
      } catch (e) { conflicts.reset(); error.textContent = e.message; this.updateStatus(); }
      finally { submit.disabled = false; Object.values(fields).forEach(input => { input.disabled = false; }); dialog.querySelector('button').disabled = false; preview.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
    };
    form.append(error, submit); dialog.append(form); updatePreview(); fields.title.focus();
  }
}
