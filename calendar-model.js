const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };
export function newCalendar(id) { return { schemaVersion: 1, id, events: [] }; }
export function validateCalendar(doc) {
  if (!doc || doc.schemaVersion !== 1 || typeof doc.id !== 'string' || !uuid.test(doc.id) || !Array.isArray(doc.events) || doc.events.length > 100000) invalid('Unsupported Calendar document.');
  const ids = new Set();
  for (const event of doc.events) {
    if (!event || typeof event.id !== 'string' || !uuid.test(event.id) || ids.has(event.id)) invalid('Invalid or duplicate event ID.');
    ids.add(event.id);
    if (typeof event.title !== 'string' || !event.title.trim() || event.title.length > 10000) invalid('An event title is required.');
    if (typeof event.start !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.start) || !Number.isFinite(Date.parse(event.start)) || new Date(event.start).toISOString() !== event.start) invalid('A valid UTC starting time is required.');
    if (event.end !== undefined && (typeof event.end !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.end) || !Number.isFinite(Date.parse(event.end)) || new Date(event.end).toISOString() !== event.end || event.end <= event.start)) invalid('End time must be a valid UTC time after the starting time.');
    if (event.studentId !== undefined && (typeof event.studentId !== 'string' || !uuid.test(event.studentId))) invalid('Invalid event student.');
    if (event.studentId && !event.end && !event.durationMinutes) invalid('Student conversations require a duration or end time.');
    if (event.end !== undefined && event.durationMinutes !== undefined) invalid('Choose either an end time or a duration.');
    if (event.categoryId !== undefined && (typeof event.categoryId !== 'string' || event.categoryId.length > 100)) invalid('Invalid event category.');
    if (event.timeZone !== undefined) {
      if (typeof event.timeZone !== 'string' || event.timeZone.length > 100) invalid('Invalid event time zone.');
      try { new Intl.DateTimeFormat('en', { timeZone: event.timeZone }); } catch { invalid('Invalid event time zone.'); }
    }
    if (event.location !== undefined && (typeof event.location !== 'string' || event.location.length > 10000)) invalid('Invalid event location.');
    if (event.durationMinutes !== undefined && (!Number.isSafeInteger(event.durationMinutes) || event.durationMinutes <= 0 || !Number.isFinite(+new Date(Date.parse(event.start) + event.durationMinutes * 60000)))) invalid('Duration must be a positive whole number of minutes.');
  }
  return doc;
}
const pad = n => String(n).padStart(2, '0');
export function localInput(instant) {
  const d = new Date(instant);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function utcFromLocal(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) invalid('Choose a valid starting date and time.');
  const d = new Date(value);
  if (!Number.isFinite(+d) || localInput(d) !== value) invalid('This local date or time does not exist. Choose another starting time.');
  return d.toISOString();
}
export function sortedEvents(events) { return [...events].sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id)); }
export function reminderKey(event) { return `${event.id}:${event.start}`; }
export function dueEvents(events, now = Date.now()) { return sortedEvents(events).filter(e => { const start = Date.parse(e.start); return now >= start - 600000 && now < start; }); }

export function eventEnd(event) { return event.end || (event.durationMinutes ? new Date(Date.parse(event.start) + event.durationMinutes * 60000).toISOString() : undefined); }
