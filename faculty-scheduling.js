import { blockingCalendarEvents } from './daily-calendar.js';
import { createHash } from 'node:crypto';
import { validateCalendar } from './calendar-model.js';
import { checkCalendarAvailability } from './timetable-model.js';
export class FacultyScheduling {
  constructor({ faculty, calendar, daily, now = Date.now }) { Object.assign(this, { faculty, calendar, daily, now }); }
  async check(facultyId, event, draftEvents = [], proposed = false) {
    const member = await this.faculty.read(facultyId), current = await this.calendar.read();
    validateCalendar({ ...current.document, events: [event] });
    if (event.facultyId !== facultyId) throw Object.assign(new Error('Conversation faculty member does not match.'), { status: 400 });
    validateCalendar({ ...current.document, events: draftEvents });
    const savedIds = new Set(current.document.events.map(e => e.id));
    const completion = await this.daily.readStored();
    const events = blockingCalendarEvents(proposed ? draftEvents : [...current.document.events, ...draftEvents.filter(e => !savedIds.has(e.id))], completion.document);
    const checked = checkCalendarAvailability(event, events, this.now());
    return { ...checked, calendarRevision: current.revision, acknowledgement: createHash('sha256').update(JSON.stringify([event, member.revision, current.revision, completion.revision, checked.conflicts])).digest('hex') };
  }
}
