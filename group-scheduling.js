import { createHash } from 'node:crypto';
import { validateCalendar, eventEnd } from './calendar-model.js';
import { checkConversation, localParts, schoolInstant } from './timetable-model.js';
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export class GroupScheduling {
  constructor({ groups, students, calendar, timetables, now = Date.now }) { Object.assign(this, { groups, students, calendar, timetables, now }); }
  async check(groupId, event, draftEvents = [], proposed = false) {
    const group = await this.groups.read(groupId), current = await this.calendar.read(), academic = await this.timetables.read();
    validateCalendar({ ...current.document, events: [event] });
    if (event.groupId !== groupId) fail(400, 'Session group does not match.');
    const session = group.document.sessions.find(s => s.id === event.groupSessionId);
    if (!session || event.id !== session.id) fail(400, 'Save the group session before scheduling it.');
    const allowed = new Set([...group.document.memberIds, ...session.participantIds]);
    if (event.participantIds.some(id => !allowed.has(id))) fail(400, 'Choose participants from the group or the historical session.');
    validateCalendar({ ...current.document, events: draftEvents });
    const savedIds = new Set(current.document.events.map(e => e.id));
    const events = proposed ? draftEvents : [...current.document.events, ...draftEvents.filter(e => !savedIds.has(e.id))];
    validateCalendar({ ...current.document, events });
    const participants = [], revisions = [];
    for (const id of event.participantIds) {
      let student; try { student = await this.students.read(id); } catch (e) { if (e.code === 'ENOENT') fail(400, 'Session participant unavailable.'); throw e; }
      revisions.push([id, student.revision]); participants.push({ id, name: student.document.profile.name, ...checkConversation(event, student.document, academic.document, events, this.now()) });
    }
    const zone = event.timeZone || 'Asia/Shanghai', date = localParts(event.start, zone).date;
    const opening = new Date(Math.max(Date.parse(schoolInstant(date, '08:30', zone)), this.now())).toISOString(), closing = schoolInstant(date, '21:30', zone);
    let freeWindows = participants[0].freeWindows.map(w => ({ start: w.start > opening ? w.start : opening, end: w.end < closing ? w.end : closing })).filter(w => w.start < w.end);
    for (const participant of participants.slice(1)) freeWindows = freeWindows.flatMap(a => participant.freeWindows.map(b => ({ start: a.start > b.start ? a.start : b.start, end: a.end < b.end ? a.end : b.end })).filter(w => w.start < w.end));
    const duration = Date.parse(eventEnd(event)) - Date.parse(event.start), slots = [];
    for (const w of freeWindows) {
      const start = Date.parse(w.start), end = Date.parse(w.end), starts = new Set([start]);
      for (let t = Math.ceil(start / 900000) * 900000; t + duration <= end; t += 900000) starts.add(t);
      for (const t of [...starts].sort((a,b) => a-b)) if (t + duration <= end) slots.push({ start: new Date(t).toISOString(), end: new Date(t + duration).toISOString() });
    }
    const conflicts = participants.flatMap(p => p.conflicts.map(c => ({ ...c, participantId: p.id, title: `${p.name}: ${c.title}` })));
    return { participants, conflicts, incomplete: participants.some(p => p.incomplete), past: Date.parse(event.start) < this.now(), classes: participants.flatMap(p => p.classes.map(c => ({ ...c, name: `${p.name}: ${c.name}` }))), slots, freeWindows, durationMinutes: duration / 60000, timeZone: event.timeZone || 'Asia/Shanghai', groupRevision: group.revision, calendarRevision: current.revision,
      acknowledgement: createHash('sha256').update(JSON.stringify([event, group.revision, current.revision, academic.revision, revisions, conflicts])).digest('hex') };
  }
}
