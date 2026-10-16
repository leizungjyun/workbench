import { newTask, stateAt, updateTask, validateDaily } from './daily-model.js';

function localParts(instant, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant)).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

// Reconcile from saved Calendar data, so a restart or interrupted save can repair
// the link. Stable event IDs and source fingerprints make repeated reads harmless.
export function syncCalendarTasks(doc, calendar, now = new Date()) {
  const before = JSON.stringify(doc);
  const ids = new Set(calendar.events.map(e => e.id));
  const misc = () => {
    let category = doc.categories.find(c => c.id === 'category-5') || doc.categories.find(c => c.name === 'Miscellaneous');
    if (!category) { category = { id: 'category-5', name: 'Miscellaneous', hidden: false }; doc.categories.push(category); }
    return category.id;
  };
  if (calendar.events.some(e => e.groupId) && !doc.categories.some(c => c.id === 'category-group')) doc.categories.push({ id: 'category-group', name: 'Group', hidden: false });
  for (const event of calendar.events) {
    const zone = event.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { date, time } = localParts(event.start, zone), today = localParts(now, zone).date;
    const categoryId = doc.categories.some(c => c.id === event.categoryId) ? event.categoryId : misc();
    const source = [event.title, event.start, zone, categoryId, event.location || '', event.durationMinutes || null, event.studentId || ''];
    if (event.end) source.push(event.end);
    if (event.groupId) source.push(event.groupId, event.groupSessionId, event.participantIds);
    const fingerprint = JSON.stringify(source);
    let task = doc.tasks.find(t => t.id === event.id);
    if (task && !task.calendarEvent) throw Object.assign(new Error('Calendar event ID conflicts with an existing Daily task.'), { status: 409 });
    if (task?.calendarEvent.fingerprint === fingerprint && !task.calendarEvent.deleted) continue;
    const end = event.end ? localParts(event.end, zone) : null;
    const sourceDetails = [event.location, end ? `Ends: ${end.date} ${end.time}` : '', event.durationMinutes ? `Duration: ${event.durationMinutes} minutes` : ''].filter(Boolean).join('\n');
    if (!task) {
      task = newTask(event.id, date, event.title, categoryId); doc.tasks.push(task);
      Object.assign(task.versions[0], { time, details: sourceDetails, studentId: event.studentId || '', groupId: event.groupId || '', groupSessionId: event.groupSessionId || '', participantIds: event.participantIds || [] });
    } else {
      const changeDate = task.originDate > today ? (date < task.originDate ? date : task.originDate) : (date < task.originDate ? date : today);
      const previous = structuredClone(stateAt(task, changeDate) || task.versions[0]);
      const patch = { text: event.title.trim(), time, categoryId, scheduledDate: date, studentId: event.studentId || '', groupId: event.groupId || '', groupSessionId: event.groupSessionId || '', participantIds: event.participantIds || [] };
      if (previous.details === task.calendarEvent.details) patch.details = sourceDetails;
      if (task.calendarEvent.deleted && previous.status === 'cancelled') patch.status = 'open';
      if (changeDate < task.originDate) {
        task.versions.unshift({ ...previous, ...patch, date: changeDate }); task.originDate = changeDate;
      } else updateTask(task, changeDate, patch);
      // Future snapshots must not overwrite the newly saved event's schedule.
      for (const v of task.versions.filter(v => v.date > changeDate)) {
        const details = v.details === task.calendarEvent.details;
        Object.assign(v, { ...patch, ...(details ? { details: sourceDetails } : { details: v.details }) });
      }
      if (!task.appearances.includes(date)) task.appearances.push(date);
      task.appearances.sort();
    }
    task.calendarEvent = { fingerprint, details: sourceDetails, timeZone: zone, deleted: false };
  }
  for (const task of doc.tasks.filter(t => t.calendarEvent && !t.calendarEvent.deleted && !ids.has(t.id))) {
    const today = localParts(now, task.calendarEvent.timeZone).date;
    const date = today < task.originDate ? task.originDate : today;
    updateTask(task, date, { status: 'cancelled' });
    for (const v of task.versions.filter(v => v.date > date)) v.status = 'cancelled';
    task.calendarEvent.deleted = true;
  }
  validateDaily(doc);
  return JSON.stringify(doc) !== before;
}
