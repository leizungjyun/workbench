import { uuidPattern, calendarDate, validateRichText, richText } from './student-model.js';
export const facultyCategoryId = 'category-faculty';
export const facultyProfileFields = ['name', 'institution', 'department', 'position', 'email', 'researchAreas'];
export const markdownNote = (text = '') => ({ type: 'markdown', text });
export function newFaculty(id, name) {
  return { schemaVersion: 1, id, archived: false, profile: { ...Object.fromEntries(facultyProfileFields.map(key => [key, key === 'name' ? name : ''])), notes: markdownNote() }, preparation: { date: '', agenda: markdownNote() }, sessions: [] };
}
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const keys = (value, allowed, label) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`Invalid ${label}.`); };
const text = (value, label, max = 10000) => { if (typeof value !== 'string' || value.length > max) fail(`Invalid ${label}.`); };
const array = value => { if (!Array.isArray(value) || value.length > 10000) fail('Invalid Faculty records.'); };
export function validateFaculty(doc) {
  keys(doc, ['schemaVersion', 'id', 'archived', 'profile', 'preparation', 'sessions'], 'Faculty document');
  if (doc.schemaVersion !== 1 || typeof doc.archived !== 'boolean') fail('Invalid Faculty version or archive status.');
  const ids = new Set(); const id = value => { if (typeof value !== 'string' || !uuidPattern.test(value) || ids.has(value)) fail('Invalid or duplicate Faculty record ID.'); ids.add(value); }; id(doc.id);
  keys(doc.profile, [...facultyProfileFields, 'notes'], 'Faculty profile');
  for (const key of facultyProfileFields) text(doc.profile[key], key, 1000);
  if (!doc.profile.name.trim()) fail('A faculty member name is required.');
  if (doc.profile.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(doc.profile.email)) fail('Invalid email address.');
  validateRichText(doc.profile.notes);
  keys(doc.preparation, ['date', 'agenda'], 'conversation preparation'); calendarDate(doc.preparation.date); validateRichText(doc.preparation.agenda);
  array(doc.sessions);
  for (const session of doc.sessions) {
    keys(session, ['id', 'date', 'title', 'discussion', 'decisions', 'correction', 'tasks'], 'conversation record'); id(session.id); calendarDate(session.date); if (!session.date) fail('A conversation date is required.'); text(session.title, 'conversation title', 1000);
    for (const field of ['discussion', 'decisions', 'correction']) validateRichText(session[field]);
    array(session.tasks);
    for (const task of session.tasks) {
      keys(task, ['id', 'text', 'owner', 'dueDate', 'done'], 'follow-up task'); id(task.id); text(task.text, 'task'); calendarDate(task.dueDate);
      if (!['Me', 'Faculty member'].includes(task.owner) || typeof task.done !== 'boolean') fail('Invalid task owner or completion.');
    }
  }
  return doc;
}
export function facultySummary(doc) {
  return { id: doc.id, ...Object.fromEntries(facultyProfileFields.map(key => [key, doc.profile[key]])), archived: doc.archived, nextMeeting: doc.preparation.date, lastMeeting: doc.sessions.map(s => s.date).sort().at(-1) || '', openTasks: doc.sessions.flatMap(s => s.tasks).filter(t => !t.done).length };
}
export function facultySearch(doc, query) {
  const q = query.toLocaleLowerCase(); if (!q.trim()) return null;
  let count = 0; const matches = [];
  const match = (value, section, target = {}) => {
    const lower = value.toLocaleLowerCase(); let offset = 0;
    while ((offset = lower.indexOf(q, offset)) !== -1) {
      const original = lower.length === value.length ? offset : [...value].reduce((s, c) => s.lower < offset ? { lower: s.lower + c.toLocaleLowerCase().length, original: s.original + c.length } : s, { lower: 0, original: 0 }).original;
      const start = Math.max(0, original - 45); if (matches.length < 12) matches.push({ section, ...target, snippet: value.slice(start, original + query.length + 80), highlight: original - start, length: query.length });
      count++; offset += q.length;
    }
  };
  for (const field of facultyProfileFields) match(doc.profile[field], 'Profile'); match(richText(doc.profile.notes), 'Profile notes');
  match(doc.preparation.date, 'Next conversation'); match(richText(doc.preparation.agenda), 'Next conversation');
  for (const s of doc.sessions) for (const value of [s.date, s.title, richText(s.discussion), richText(s.decisions), richText(s.correction), ...s.tasks.flatMap(t => [t.text, t.owner, t.dueDate])]) match(value, 'Conversation record', { sessionId: s.id });
  return count ? { type: 'faculty', id: doc.id, name: doc.profile.name, archived: doc.archived, count, matches } : null;
}
