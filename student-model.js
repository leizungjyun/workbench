import { validateStudentTimetables } from './timetable-model.js';
// Portable version 1 supervision documents. Calendar dates are never timezone-converted.
export const emptyText = () => ({ type: 'doc', content: [{ type: 'paragraph' }] });
export const profileFields = ['name', 'dob', 'gkPlace', 'email', 'researchAreas', 'program', 'entryYear', 'schoolId'];
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const richText = node => node?.type === 'text' ? node.text : (node?.content || []).map(richText).join(node?.type === 'doc' ? '\n' : '');
export function newStudent(id, name) {
  return { schemaVersion: 1, id, archived: false, profile: Object.fromEntries(profileFields.map(key => [key, key === 'name' ? name : ''])), preparation: { date: '', agenda: emptyText() }, sessions: [], objectives: [] };
}
const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };
const object = (value, label) => { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`Invalid ${label}.`); };
const keys = (value, allowed, label) => { object(value, label); if (Object.keys(value).some(key => !allowed.includes(key))) invalid(`Unexpected field in ${label}.`); };
const string = (value, label, max = 10000) => { if (typeof value !== 'string' || value.length > max) invalid(`Invalid ${label}.`); };
const bool = (value, label) => { if (typeof value !== 'boolean') invalid(`Invalid ${label}.`); };
const array = (value, label) => { if (!Array.isArray(value) || value.length > 10000) invalid(`Invalid ${label}.`); };
export function calendarDate(value, label = 'date') {
  string(value, label, 10); if (!value) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) invalid(`Invalid ${label}. Use YYYY-MM-DD.`);
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) invalid(`Invalid ${label}.`);
}
export function birthDate(value) {
  if (/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(value)) return;
  calendarDate(value, 'date of birth (YYYY-MM or YYYY-MM-DD)');
}
export function validateRichText(doc) {
  if (doc?.type !== 'doc') invalid('Rich text must be a document.');
  let count = 0;
  const visit = (node, depth = 0) => {
    if (++count > 100000 || depth > 30) invalid('Rich text is too complex.');
    keys(node, ['type', 'content', 'text', 'attrs', 'marks'], 'rich text');
    if (!['doc', 'paragraph', 'text', 'heading', 'bulletList', 'orderedList', 'listItem', 'hardBreak'].includes(node.type)) invalid('Unsupported rich text node.');
    if (depth && node.type === 'doc') invalid('Nested documents are not supported.');
    if (node.type === 'text') { string(node.text, 'text', 1000000); if (!node.text) invalid('Text nodes cannot be empty.'); }
    else if (node.text !== undefined) invalid('Only text nodes may contain text.');
    if (node.attrs !== undefined) {
      keys(node.attrs, node.type === 'heading' ? ['level'] : node.type === 'orderedList' ? ['start', 'type'] : [], 'node attributes');
      if (node.type === 'heading' && ![1, 2, 3].includes(node.attrs.level)) invalid('Invalid heading level.');
      if (node.type === 'orderedList' && node.attrs.type != null && !['1', 'a', 'A', 'i', 'I'].includes(node.attrs.type)) invalid('Invalid list type.');
      if (node.type === 'orderedList' && (!Number.isInteger(node.attrs.start) || node.attrs.start < 1)) invalid('Invalid list start.');
    }
    if (node.type === 'heading' && !node.attrs) invalid('A heading needs a level.');
    if (node.marks !== undefined) {
      array(node.marks, 'marks');
      for (const mark of node.marks) {
        keys(mark, ['type', 'attrs'], 'mark');
        if (!['bold', 'italic', 'link'].includes(mark.type)) invalid('Unsupported text formatting.');
        if (mark.type === 'link') {
          keys(mark.attrs, ['href', 'target', 'rel', 'class', 'title'], 'link'); string(mark.attrs.href, 'link', 4000);
          if (!/^(https?:\/\/|mailto:)/i.test(mark.attrs.href) || /[\x00-\x20]/.test(mark.attrs.href)) invalid('Use an http, https, or mailto link.');
          for (const key of ['target', 'rel', 'class', 'title']) if (mark.attrs[key] != null) string(mark.attrs[key], key, 200);
        } else if (mark.attrs !== undefined) invalid('Unsupported formatting attributes.');
      }
    }
    const children = node.content || [];
    if (node.content !== undefined) array(node.content, 'content');
    const block = ['paragraph', 'heading', 'bulletList', 'orderedList'];
    const allowed = node.type === 'doc' ? block : ['bulletList', 'orderedList'].includes(node.type) ? ['listItem'] : node.type === 'listItem' ? block : ['paragraph', 'heading'].includes(node.type) ? ['text', 'hardBreak'] : [];
    if (children.some(child => !allowed.includes(child?.type))) invalid('Invalid rich text structure.');
    if (node.type === 'listItem' && children[0]?.type !== 'paragraph') invalid('List items need a paragraph.');
    if (['doc', 'listItem', 'bulletList', 'orderedList'].includes(node.type) && !children.length) invalid('Invalid empty rich text structure.');
    children.forEach(child => visit(child, depth + 1));
  };
  visit(doc); return doc;
}
export function validateStudent(doc) {
  keys(doc, ['schemaVersion', 'id', 'archived', 'profile', 'preparation', 'sessions', 'objectives', 'timetables'], 'student');
  if (doc.schemaVersion !== 1 || !uuidPattern.test(doc.id)) invalid('Invalid student version or ID.');
  if (doc.timetables !== undefined) validateStudentTimetables(doc.timetables);
  bool(doc.archived, 'archive status'); keys(doc.profile, [...profileFields, 'nativePlace', 'birthplace', 'stage', 'coursesCompleted'], 'profile');
  for (const key of profileFields) { if (['gkPlace', 'schoolId'].includes(key) && doc.profile[key] === undefined) continue; string(doc.profile[key], key, 1000); }
  for (const key of ['nativePlace', 'birthplace', 'stage']) if (doc.profile[key] !== undefined) string(doc.profile[key], key, 1000);
  if (doc.profile.coursesCompleted !== undefined) bool(doc.profile.coursesCompleted, 'courses completed');
  if (!doc.profile.name.trim()) invalid('A student name is required.');
  birthDate(doc.profile.dob);
  if (doc.profile.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(doc.profile.email)) invalid('Invalid email address.');
  if (doc.profile.entryYear && !/^[1-9]\d{3}$/.test(doc.profile.entryYear)) invalid('Entry year must be four digits.');
  keys(doc.preparation, ['date', 'agenda'], 'meeting preparation'); calendarDate(doc.preparation.date); validateRichText(doc.preparation.agenda);
  array(doc.sessions, 'sessions'); array(doc.objectives, 'objectives');
  const ids = new Set(); const id = value => { if (!uuidPattern.test(value) || ids.has(value)) invalid('Invalid or duplicate record ID.'); ids.add(value); };
  id(doc.id);
  for (const goal of doc.objectives) {
    keys(goal, ['id', 'title', 'description', 'targetDate', 'status', 'archived', 'milestones'], 'objective'); id(goal.id); string(goal.title, 'objective title', 1000);
    validateRichText(goal.description); calendarDate(goal.targetDate); bool(goal.archived, 'objective archive status');
    if (!['Planned', 'In progress', 'Completed', 'Paused'].includes(goal.status)) invalid('Invalid objective status.');
    array(goal.milestones, 'milestones');
    for (const m of goal.milestones) { keys(m, ['id', 'text', 'done'], 'milestone'); id(m.id); string(m.text, 'milestone'); bool(m.done, 'milestone completion'); }
  }
  const goalIds = new Set(doc.objectives.map(goal => goal.id));
  for (const session of doc.sessions) {
    keys(session, ['id', 'date', 'title', 'discussion', 'decisions', 'objectiveIds', 'actions'], 'session'); id(session.id); calendarDate(session.date); if (!session.date) invalid('A meeting date is required.'); string(session.title, 'meeting title', 1000);
    validateRichText(session.discussion); validateRichText(session.decisions); array(session.objectiveIds, 'objective links');
    if (new Set(session.objectiveIds).size !== session.objectiveIds.length || session.objectiveIds.some(value => !goalIds.has(value))) invalid('Invalid objective link.');
    array(session.actions, 'actions');
    for (const action of session.actions) {
      keys(action, ['id', 'text', 'owner', 'dueDate', 'done', 'objectiveId'], 'action'); id(action.id); string(action.text, 'action'); calendarDate(action.dueDate); bool(action.done, 'action completion');
      if (!['Student', 'Supervisor'].includes(action.owner)) invalid('Invalid action owner.');
      if (action.objectiveId !== '' && !goalIds.has(action.objectiveId)) invalid('Invalid action objective.');
    }
  }
  return doc;
}
export function studentSummary(doc) {
  const openActions = doc.sessions.flatMap(s => s.actions).filter(a => !a.done);
  const deadlines = doc.objectives.filter(g => !g.archived && ['Planned', 'In progress'].includes(g.status) && g.targetDate).map(g => g.targetDate).sort();
  return { id: doc.id, name: doc.profile.name, schoolId: doc.profile.schoolId || '', researchAreas: doc.profile.researchAreas, archived: doc.archived, lastMeeting: doc.sessions.map(s => s.date).sort().at(-1) || '', nextMeeting: doc.preparation.date, openActions: openActions.length, nearestDeadline: deadlines[0] || '' };
}

// Entry Year denotes September admission; academic years advance each September.
export function currentStage(entryYear, date = new Date()) {
  if (!/^[1-9]\d{3}$/.test(entryYear)) return '';
  const academicYear = date.getFullYear() - (date.getMonth() < 8 ? 1 : 0);
  return academicYear < Number(entryYear) ? 'Not started' : `Year ${academicYear - Number(entryYear) + 1}`;
}
