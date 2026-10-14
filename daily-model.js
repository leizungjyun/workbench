// Dated task snapshots preserve history without copying carried tasks.
export const defaultCategories = ['Learning', 'Students', 'Projects', 'Papers', 'Development', 'Miscellaneous'];
export const categoryTranslations = { 学习: 'Learning', 学生: 'Students', 学生指导: 'Students', 项目: 'Projects', 论文: 'Papers', 开发: 'Development', 杂事: 'Miscellaneous' };
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const invalid = message => { throw Object.assign(new Error(message), { status: 400 }); };
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`); return !Number.isNaN(+d) && d.toISOString().slice(0, 10) === value;
}
export function localDate(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
export function shiftDate(date, days) { const d = new Date(`${date}T12:00:00`); d.setDate(d.getDate() + days); return localDate(d); }
export function newDaily(id) { return { schemaVersion: 1, id, categories: defaultCategories.map((name, i) => ({ id: `category-${i}`, name, hidden: false })), tasks: [], days: {}, imports: [] }; }
export function newTask(id, date, text, categoryId = 'category-5') {
  return { id, originDate: date, appearances: [date], versions: [{ date, text: text.trim(), categoryId, details: '', subtasks: [], time: '', deadline: '', studentId: '', status: 'open', scheduledDate: date }] };
}
// Empty category IDs from older files belong to the miscellaneous category.
export function normalizeDaily(doc) {
  const legacy = doc.tasks.some(task => task.versions.some(v => v.categoryId === ''));
  if (!legacy) return doc;
  let misc = doc.categories.find(c => c.name === 'Miscellaneous') || doc.categories.find(c => c.id === 'category-5');
  if (!misc) { misc = { id: 'category-5', name: 'Miscellaneous', hidden: false }; doc.categories.push(misc); }
  for (const task of doc.tasks) for (const version of task.versions) if (version.categoryId === '') version.categoryId = misc.id;
  return doc;
}
export function stateAt(task, date) { return task.versions.filter(v => v.date <= date).at(-1) || null; }
export function visibleTasks(doc, date) {
  return doc.tasks.flatMap(task => {
    const state = stateAt(task, date);
    if (!state || (state.scheduledDate > date && (task.calendarEvent || state.date !== date)) || (state.status !== 'open' && state.date !== date && !task.appearances.includes(date))) return [];
    return [{ task, state }];
  });
}
export function updateTask(task, date, patch) {
  const previous = stateAt(task, date); if (!previous) invalid('Task did not exist on this date.');
  const next = { ...structuredClone(previous), ...patch, date };
  const index = task.versions.findIndex(v => v.date === date);
  if (index < 0) task.versions.push(next); else task.versions[index] = next;
  task.versions.sort((a, b) => a.date.localeCompare(b.date));
}
export function validateDaily(doc) {
  const obj = o => { if (!o || typeof o !== 'object' || Array.isArray(o)) invalid('Invalid Daily record.'); };
  const str = (s, max = 1000000) => { if (typeof s !== 'string' || s.length > max) invalid('Invalid Daily text.'); };
  const arr = a => { if (!Array.isArray(a) || a.length > 100000) invalid('Invalid Daily list.'); };
  const date = d => { if (!validDate(d)) invalid('Invalid Daily date.'); };
  const optionalDate = d => { if (d !== '') date(d); };
  if (!doc || doc.schemaVersion !== 1 || !uuid.test(doc.id)) invalid('Unsupported Daily document.');
  arr(doc.categories); arr(doc.tasks); arr(doc.imports);
  const categories = new Set(['']);
  for (const c of doc.categories) { obj(c); str(c.id, 100); str(c.name, 1000); if (!c.id || !c.name.trim() || categories.has(c.id) || typeof c.hidden !== 'boolean') invalid('Invalid Daily category.'); categories.add(c.id); }
  const ids = new Set();
  for (const t of doc.tasks) {
    obj(t); if (!uuid.test(t.id) || ids.has(t.id)) invalid('Invalid or duplicate task ID.'); ids.add(t.id); date(t.originDate); arr(t.appearances); t.appearances.forEach(date); arr(t.versions);
    if (!t.versions.length || t.versions[0].date !== t.originDate || new Set(t.appearances).size !== t.appearances.length || t.appearances.some(d => d < t.originDate)) invalid('Invalid task history.');
    if (t.calendarEvent !== undefined) {
      obj(t.calendarEvent); str(t.calendarEvent.fingerprint); str(t.calendarEvent.details); str(t.calendarEvent.timeZone, 100);
      if (typeof t.calendarEvent.deleted !== 'boolean') invalid('Invalid Calendar task link.');
      try { new Intl.DateTimeFormat('en', { timeZone: t.calendarEvent.timeZone }); } catch { invalid('Invalid Calendar task time zone.'); }
    }
    let previous = '';
    for (const v of t.versions) {
      obj(v); date(v.date); if (v.date <= previous) invalid('Task history must have unique ordered dates.'); previous = v.date;
      str(v.text, 10000); str(v.details); if (!v.text.trim()) invalid('Blank tasks cannot be saved.');
      if (!categories.has(v.categoryId) || !['open', 'completed', 'cancelled'].includes(v.status)) invalid('Invalid task category or status.');
      str(v.time, 5); if (v.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.time)) invalid('Invalid task time.');
      optionalDate(v.deadline); date(v.scheduledDate); str(v.studentId, 100); if (v.studentId && !uuid.test(v.studentId)) invalid('Invalid student link.');
      arr(v.subtasks); const subIds = new Set();
      for (const s of v.subtasks) { obj(s); if (!uuid.test(s.id) || subIds.has(s.id) || typeof s.done !== 'boolean') invalid('Invalid subtask.'); subIds.add(s.id); str(s.text, 10000); if (!s.text.trim()) invalid('Blank subtasks cannot be saved.'); }
    }
  }
  if (!doc.days || typeof doc.days !== 'object' || Array.isArray(doc.days)) invalid('Invalid daily records.');
  for (const [d, entry] of Object.entries(doc.days)) { date(d); obj(entry); str(entry.notes); }
  for (const marker of doc.imports) { obj(marker); str(marker.source, 1000); date(marker.date); }
  return doc;
}
export function markdownExport(doc) {
  const dates = new Set([...Object.keys(doc.days), ...doc.tasks.flatMap(t => [...t.appearances, ...t.versions.map(v => v.date)])]);
  return [...dates].sort().reverse().map(date => {
    const lines = [`# ${date}`, '']; let category;
    for (const { task, state } of visibleTasks(doc, date).sort((a, b) => a.state.categoryId.localeCompare(b.state.categoryId))) {
      if (category !== state.categoryId) { category = state.categoryId; lines.push(`## ${doc.categories.find(c => c.id === category)?.name || 'Miscellaneous'}`, ''); }
      lines.push(`- [${state.status === 'completed' ? 'x' : ' '}] ${state.text}${state.status === 'cancelled' ? ' (cancelled)' : ''}`, `  Origin: ${task.originDate}${state.deadline ? ` · Deadline: ${state.deadline}` : ''}${state.time ? ` · Time: ${state.time}` : ''}`);
      if (state.details) lines.push(...state.details.split('\n').map(l => `  ${l}`));
      for (const s of state.subtasks) lines.push(`  - [${s.done ? 'x' : ' '}] ${s.text}`);
    }
    if (doc.days[date]?.notes) lines.push('', '## Daily notes', '', doc.days[date].notes);
    return lines.join('\n');
  }).join('\n\n');
}
