import { newStudent, validateStudent, validateRichText, calendarDate, uuidPattern, richText } from './student-model.js';
export const groupCategoryId = 'category-group';
export const sessionTypes = ['Workshop', 'Roundtable'];
export const markdownNote = (text = '') => ({ type: 'markdown', text });
export const defaultParticipants = (group, type) => type === 'Workshop' ? [...group.memberIds] : [group.leaderId];
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const object = (v, keys) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) fail('Invalid Group document fields.'); };
const text = (v, max = 10000) => { if (typeof v !== 'string' || v.length > max) fail('Invalid Group text.'); };
const ids = values => { if (!Array.isArray(values) || values.length > 10000 || new Set(values).size !== values.length || values.some(id => typeof id !== 'string' || !uuidPattern.test(id))) fail('Invalid or duplicate student IDs.'); };
export function newGroup(id, name, memberIds = [], leaderId) {
  if (!Array.isArray(memberIds)) memberIds = [];
  return { schemaVersion: 1, id, name, archived: false, memberIds, leaderId, preparation: { title: '', date: '', type: 'Workshop', participantIds: [...memberIds], agenda: markdownNote() }, sessions: [], objectives: [] };
}
export function newGroupSession(id, group, date, type = group.preparation.type) {
  return { id, date, title: '', type, participantIds: defaultParticipants(group, type), discussion: markdownNote(), decisions: markdownNote(), correction: markdownNote(), objectiveIds: [], actions: [], attachments: [] };
}
export function validateGroup(d) {
  object(d, ['schemaVersion', 'id', 'name', 'archived', 'memberIds', 'leaderId', 'preparation', 'sessions', 'objectives']);
  text(d.name, 1000); if (!d.name.trim()) fail('A group name is required.');
  ids(d.memberIds); if (!d.memberIds.length || !d.memberIds.includes(d.leaderId)) fail('Select a student leader from the group members.');
  object(d.preparation, ['title', 'date', 'type', 'participantIds', 'agenda']); text(d.preparation.title, 1000); calendarDate(d.preparation.date); validateRichText(d.preparation.agenda); ids(d.preparation.participantIds);
  if (!sessionTypes.includes(d.preparation.type) || !d.preparation.participantIds.length || d.preparation.participantIds.some(id => !d.memberIds.includes(id))) fail('Select preparation participants from current members.');
  if (!Array.isArray(d.sessions) || d.sessions.length > 10000) fail('Invalid group sessions.');
  const portable = newStudent(d.id, d.name); portable.schemaVersion = d.schemaVersion; portable.archived = d.archived; portable.preparation = { date: d.preparation.date, agenda: d.preparation.agenda }; portable.objectives = d.objectives;
  const attachments = new Set();
  portable.sessions = d.sessions.map(s => {
    object(s, ['id', 'date', 'title', 'type', 'participantIds', 'discussion', 'decisions', 'correction', 'objectiveIds', 'actions', 'attachments']);
    ids(s.participantIds); if (!s.participantIds.length || !sessionTypes.includes(s.type)) fail('A session needs a type and at least one participant.');
    validateRichText(s.correction);
    if (!Array.isArray(s.actions) || !Array.isArray(s.attachments) || s.attachments.length > 1000) fail('Invalid session actions or materials.');
    for (const a of s.attachments) {
      object(a, ['id', 'name', 'size']); text(a.name, 255);
      if (!uuidPattern.test(a.id) || attachments.has(a.id) || !/\.(pdf|ppt|pptx|key)$/i.test(a.name) || /[\/\\\x00-\x1f\x7f]/.test(a.name) || !Number.isSafeInteger(a.size) || a.size <= 0 || a.size > 100 * 1024 * 1024) fail('Invalid presentation attachment.');
      attachments.add(a.id);
    }
    return { id: s.id, date: s.date, title: s.title, discussion: s.discussion, decisions: s.decisions, correction: s.correction, objectiveIds: s.objectiveIds, actions: s.actions.map(a => {
      object(a, ['id', 'text', 'owner', 'assigneeIds', 'dueDate', 'done', 'objectiveId']); ids(a.assigneeIds);
      if (!['Students', 'Group', 'Supervisor'].includes(a.owner) || (a.owner === 'Students' ? !a.assigneeIds.length : a.assigneeIds.length)) fail('Choose action owners.');
      return { id: a.id, text: a.text, owner: a.owner === 'Supervisor' ? 'Supervisor' : 'Student', dueDate: a.dueDate, done: a.done, objectiveId: a.objectiveId };
    }) };
  });
  validateStudent(portable); return d;
}
export function groupSummary(d) {
  return { id: d.id, name: d.name, archived: d.archived, memberIds: d.memberIds, leaderId: d.leaderId, lastSession: d.sessions.map(s => s.date).sort().at(-1) || '', nextSession: d.preparation.date, openActions: d.sessions.flatMap(s => s.actions).filter(a => !a.done).length };
}
export function groupSearchFields(d) {
  return [
    { section: 'Group', values: [d.name] },
    { section: 'Next Session', values: [d.preparation.title, d.preparation.date, richText(d.preparation.agenda)] },
    ...d.sessions.map(s => ({ section: 'Session', sessionId: s.id, values: [s.title, s.date, s.type, richText(s.discussion), richText(s.decisions), richText(s.correction), ...s.actions.flatMap(a => [a.text, a.owner, a.dueDate]), ...s.attachments.map(a => a.name)] })),
    ...d.objectives.map(g => ({ section: 'Objective', goalId: g.id, values: [g.title, richText(g.description), g.status, g.targetDate, ...g.milestones.map(m => m.text)] }))
  ];
}
