import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NotebookStore, createApp } from '../server.js';
import { StudentStore } from '../students.js';
import { validateStudent, validateRichText, emptyText, calendarDate, studentSummary, currentStage } from '../student-model.js';
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldnotes-students-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const notes = await new NotebookStore(root).init(); const students = await new StudentStore(notes).init(); return { root, notes, students };
}
const rich = text => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'bold' }] }] }] });
function populate(doc) {
  const goal = { id: randomUUID(), title: 'Publish paper', description: rich('研究方向'), targetDate: '2027-02-01', status: 'In progress', archived: false, milestones: [{ id: randomUUID(), text: 'Experiment', done: false }] };
  doc.objectives.push(goal);
  doc.sessions.push({ id: randomUUID(), date: '2026-10-09', title: 'Catch-up', discussion: rich('讨论'), decisions: emptyText(), objectiveIds: [goal.id], actions: [{ id: randomUUID(), text: 'Read paper', owner: 'Student', dueDate: '2026-10-15', done: false, objectiveId: goal.id }] });
  return goal;
}
test('student data, stable IDs, archive and export persist across restart', async t => {
  const { root, notes, students } = await fixture(t); const item = await students.create({ name: '李同学' }); const goal = populate(item.document);
  item.document.profile.nativePlace = '广东'; item.document.profile.birthplace = '上海'; item.document.preparation.date = '2026-10-16';
  let saved = await notes.serialize(() => students.save(item.document.id, item));
  assert.notEqual(saved.revision, item.revision);
  saved.document.profile.name = '李同学 renamed'; saved.document.archived = true; saved.document.objectives[0].archived = true;
  saved = await notes.serialize(() => students.save(saved.document.id, saved));
  const restarted = await new StudentStore(await new NotebookStore(root).init()).init();
  assert.deepEqual((await restarted.read(saved.document.id)).document, saved.document);
  assert.equal(saved.document.sessions[0].actions[0].objectiveId, goal.id);
  const exported = await restarted.export(); assert.equal(exported.schemaVersion, 1); assert.deepEqual(exported.students, [saved.document]);
  assert.equal((await restarted.list()).students[0].archived, true);
});
test('optimistic concurrency rejects stale revisions including explicit force; keeps twenty versions', async t => {
  const { students, notes, root } = await fixture(t); let item = await students.create({ name: 'One' }); const old = structuredClone(item);
  item.document.profile.program = 'Writing'; item = await students.save(item.document.id, item);
  await assert.rejects(students.save(old.document.id, { ...old, force: true }), { status: 409 });
  const responses = await Promise.allSettled([1, 2].map(n => notes.serialize(() => students.save(item.document.id, { ...item, document: { ...item.document, profile: { ...item.document.profile, program: String(n) } } }))));
  assert.equal(responses.filter(r => r.status === 'fulfilled').length, 1); assert.equal(responses.find(r => r.status === 'rejected').reason.status, 409);
  item = await students.read(item.document.id);
  for (let n = 0; n < 22; n++) { item.document.profile.program = `Stage ${n}`; item = await students.save(item.document.id, item); }
  assert.equal((await fs.readdir(path.join(root, '.notebook/student-versions', item.document.id))).length, 20);
  assert.equal((await students.read(item.document.id)).document.profile.program, 'Stage 21');
});
test('validates calendar dates, profiles, relationships and rich-text structure', async t => {
  const { students } = await fixture(t); const { document } = await students.create({ name: 'Valid' }); populate(document); validateStudent(document);
  calendarDate('2024-02-29'); assert.throws(() => calendarDate('2025-02-29')); assert.throws(() => calendarDate('2026-13-01')); assert.throws(() => calendarDate('0000-01-01'));
  for (const mutate of [d => d.profile.name = '', d => d.profile.email = 'bad', d => d.profile.entryYear = '20', d => d.sessions[0].date = '', d => d.sessions[0].actions[0].objectiveId = randomUUID(), d => d.sessions[0].objectiveIds.push(randomUUID()), d => d.objectives[0].milestones[0].id = d.sessions[0].id, d => d.extra = true]) {
    const bad = structuredClone(document); mutate(bad); assert.throws(() => validateStudent(bad));
  }
  validateRichText(rich('中文'));
  validateRichText({ type: 'doc', content: [{ type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] }] });
  for (const bad of [{ type: 'doc', content: [{ type: 'image', attrs: { src: 'x' } }] }, { type: 'doc', content: [{ type: 'text', text: 'bad' }] }, rich('link')]) {
    if (bad.content[0].type === 'paragraph') bad.content[0].content[0].marks = [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }];
    assert.throws(() => validateRichText(bad));
  }
  const bad = rich('test'); bad.content[0].content[0].marks = [{ type: 'link', attrs: { href: 'https://example.com', rel: { evil: true } } }]; assert.throws(() => validateRichText(bad));
});
test('summaries count open actions and only active goal deadlines; dates remain calendar strings', async t => {
  const { students } = await fixture(t); const { document } = await students.create({ name: 'Summary' }); populate(document);
  document.preparation.date = '2026-10-10';
  let summary = studentSummary(document); assert.equal(summary.nextMeeting, '2026-10-10'); assert.equal(summary.lastMeeting, '2026-10-09'); assert.equal(summary.openActions, 1); assert.equal(summary.nearestDeadline, '2027-02-01');
  document.objectives[0].status = 'Completed'; document.sessions[0].actions[0].done = true;
  summary = studentSummary(document); assert.equal(summary.nearestDeadline, ''); assert.equal(summary.openActions, 0);
});
test('refuses traversal and symlinks in student and version storage; invalid disk files preserved', async t => {
  const { root, students } = await fixture(t); const item = await students.create({ name: 'Safe' }); const file = path.join(root, '.notebook/students', `${item.document.id}.json`);
  await assert.rejects(students.read('../state'), { status: 400 });
  await fs.rename(file, `${file}.original`); await fs.symlink(`${file}.original`, file); await assert.rejects(students.read(item.document.id), { status: 400 }); await fs.unlink(file); await fs.rename(`${file}.original`, file);
  const versions = path.join(root, '.notebook/student-versions', item.document.id); const outside = path.join(root, 'outside'); await fs.mkdir(outside); await fs.symlink(outside, versions);
  await assert.rejects(students.save(item.document.id, item), { status: 400 }); assert.deepEqual(await fs.readdir(outside), []);
  await fs.writeFile(file, '{broken'); await assert.rejects(students.read(item.document.id), { status: 400 }); assert.equal(await fs.readFile(file, 'utf8'), '{broken');
});
test('student HTTP API requires origin, revisions and immutable IDs; export includes archived records', async t => {
  const { root } = await fixture(t); const app = await createApp(root); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.terminals.close(); await app.kernels.close(); await new Promise(resolve => app.server.close(resolve)); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (url, method = 'GET', body) => fetch(base + url, { method, headers: { Origin: base, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await fetch(base + '/api/students', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Denied' }) })).status, 403);
  let response = await request('/api/students', 'POST', { name: 'HTTP' }); assert.equal(response.status, 201); const item = await response.json();
  assert.equal((await request(`/api/students/${item.document.id}`, 'PUT', { document: item.document })).status, 400);
  assert.equal((await request(`/api/students/${item.document.id}`, 'PUT', { ...item, document: { ...item.document, id: randomUUID() } })).status, 400);
  item.document.archived = true; response = await request(`/api/students/${item.document.id}`, 'PUT', item); assert.equal(response.status, 200);
  assert.equal((await request(`/api/students/${item.document.id}`, 'PUT', item)).status, 409);
  const exported = await (await request('/api/students/export')).json(); assert.equal(exported.students[0].archived, true);
});

test('HTTP profile saves can change a full birth date to month precision', async t => {
  const { root } = await fixture(t); const app = await createApp(root);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.terminals.close(); await app.kernels.close(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (url, method, body) => fetch(base + url, { method, headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const created = await request('/api/students', 'POST', { name: 'Month precision', profile: { dob: '2001-02-03' } });
  assert.equal(created.status, 201); const item = await created.json();
  item.document.profile.dob = '2001-02';
  const response = await request(`/api/students/${item.document.id}`, 'PUT', item);
  assert.equal(response.status, 200); assert.equal((await response.json()).document.profile.dob, '2001-02');
  const reloaded = await (await fetch(`${base}/api/students/${item.document.id}`)).json();
  assert.equal(reloaded.document.profile.dob, '2001-02');
});

test('stage follows September academic years, including future and missing entry years', () => {
  assert.equal(currentStage('2026', new Date(2026, 9, 10)), 'Year 1');
  assert.equal(currentStage('2026', new Date(2027, 7, 31)), 'Year 1');
  assert.equal(currentStage('2026', new Date(2027, 8, 1)), 'Year 2');
  assert.equal(currentStage('2027', new Date(2026, 9, 10)), 'Not started');
  assert.equal(currentStage('', new Date(2026, 9, 10)), '');
});
test('new students accept optional profile fields; legacy places and stage remain readable', async t => {
  const { students } = await fixture(t);
  const item = await students.create({ name: 'Optional', profile: { gkPlace: '广东', entryYear: '2026', email: 'student@example.com' } });
  assert.equal(item.document.profile.gkPlace, '广东'); assert.equal(item.document.profile.entryYear, '2026');
  assert.equal(item.document.profile.stage, undefined);
  item.document.profile.nativePlace = 'Old native place'; item.document.profile.birthplace = 'Old birthplace'; item.document.profile.stage = 'Old stage'; delete item.document.profile.gkPlace;
  await students.save(item.document.id, item);
  assert.equal((await students.read(item.document.id)).document.profile.birthplace, 'Old birthplace');
  await assert.rejects(students.create({ name: 'Bad', profile: { entryYear: 'abc' } }), { status: 400 });
});


test('birth dates preserve month or day precision through storage and export', async t => {
  const { students } = await fixture(t);
  let item = await students.create({ name: 'Birthday precision' });
  for (const value of ['2001-02', '2000-02-29', '']) {
    item.document.profile.dob = value;
    item = await students.save(item.document.id, item);
    assert.equal((await students.read(item.document.id)).document.profile.dob, value);
    assert.equal((await students.export()).students[0].profile.dob, value);
  }
  for (const value of ['2001-00', '2001-13', '2001-2', '2001-02-29', '2001', '2001/02']) {
    const bad = structuredClone(item.document); bad.profile.dob = value; assert.throws(() => validateStudent(bad));
  }
  const bad = structuredClone(item.document); bad.preparation.date = '2026-10'; assert.throws(() => validateStudent(bad));
});


test('full-text student search covers profile, preparation, meetings, actions and archived objectives', async t => {
  const { students } = await fixture(t); let item = await students.create({ name: 'Needle student' });
  const d = item.document, goal = populate(d), session = d.sessions[0];
  d.profile.researchAreas = 'Needle research'; d.profile.nativePlace = 'Needle hometown';
  d.preparation.agenda = rich('Needle agenda'); session.title = 'Needle meeting';
  session.discussion = rich('Needle discussion'); session.decisions = rich('Needle decision'); session.actions[0].text = 'Needle action'; session.actions[0].done = true;
  goal.title = 'Needle objective'; goal.description = rich('Needle description'); goal.milestones[0].text = 'Needle milestone'; goal.archived = true; d.archived = true;
  item = await students.save(d.id, item);
  const [result] = await students.search('NEEDLE');
  assert.equal(result.id, d.id); assert.equal(result.archived, true); assert.equal(result.count, 11);
  assert.equal(result.matches.filter(m => m.sessionId === session.id).length, 4);
  assert.equal(result.matches.filter(m => m.goalId === goal.id).length, 3);
  for (const m of result.matches) assert.equal(m.snippet.slice(m.highlight, m.highlight + m.length).toLowerCase(), 'needle');
  assert.deepEqual(await students.search('  '), []); assert.deepEqual(await students.search(d.id), []); assert.deepEqual(await students.search('schemaVersion'), []);
  item.document.preparation.agenda = rich('中文关键词 a+b ' + 'needle '.repeat(20));
  await students.save(d.id, item);
  assert.equal((await students.search('中文关键词'))[0].count, 1); assert.equal((await students.search('a+b'))[0].count, 1);
  const capped = (await students.search('needle'))[0]; assert.equal(capped.count, 30); assert.equal(capped.matches.length, 12);
});

test('global search API combines notebook, Daily and student match counts', async t => {
  const { root } = await fixture(t); await fs.writeFile(path.join(root, 'collections/Search.md'), '# Shared phrase');
  const app = await createApp(root); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.terminals.close(); await app.kernels.close(); await new Promise(resolve => app.server.close(resolve)); });
  let student = await app.students.create({ name: 'Shared phrase student' });
  const daily = await app.daily.read(); daily.document.days['2026-10-10'] = { notes: 'Shared phrase daily' };
  await app.daily.save(daily);
  for (const coursesCompleted of [false, true]) {
    student.document.profile.coursesCompleted = coursesCompleted;
    student = await app.students.save(student.document.id, student);
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/search?q=shared%20phrase`);
    assert.equal(response.status, 200); const result = await response.json();
    assert.equal(result.notes.length, 1); assert.equal(result.daily.length, 1); assert.equal(result.students.length, 1); assert.equal(result.occurrences, 3);
    assert.deepEqual(await app.students.search(String(coursesCompleted)), []);
  }
});

test('legacy supervision records accept optional correction and next conversation notes, preserve and search them', async t => {
  const { students } = await fixture(t); let item = await students.create({ name: 'Synthetic follow-up' }); populate(item.document);
  validateStudent(item.document);
  const session = item.document.sessions[0]; session.correction = rich('Corrected baseline');
  session.nextConversation = { date: '2026-10-23', agenda: rich('Review corrected experiments') };
  item = await students.save(item.document.id, item);
  assert.deepEqual((await students.read(item.document.id)).document.sessions[0].nextConversation, session.nextConversation);
  const [result] = await students.search('corrected'); assert.equal(result.count, 2); assert.equal(result.matches[0].sessionId, session.id);
  for (const mutate of [s => s.correction = 'plain text', s => s.nextConversation.date = '2026-13-01', s => s.nextConversation.agenda = null, s => s.nextConversation.extra = true]) {
    const bad = structuredClone(item.document); mutate(bad.sessions[0]); assert.throws(() => validateStudent(bad), { status: 400 });
  }
});

test('Markdown notes preserve source through saves, search and export alongside legacy rich text', async t => {
  const { students } = await fixture(t); let item = await students.create({ name: 'Synthetic Markdown' });
  const source = '## Progress\n\n**Evidence**\n\n```python\nprint(1)\n```\n';
  item.document.preparation.agenda = { type: 'markdown', text: source };
  validateStudent(item.document); item = await students.save(item.document.id, item);
  assert.equal((await students.read(item.document.id)).document.preparation.agenda.text, source);
  assert.equal((await students.export()).students[0].preparation.agenda.text, source);
  assert.equal((await students.search('Evidence'))[0].count, 1);
  validateRichText({ type: 'markdown', text: '' });
  for (const bad of [{ type: 'markdown', text: 1 }, { type: 'markdown', text: '', extra: true }, { type: 'markdown', text: 'x'.repeat(1000001) }]) assert.throws(() => validateRichText(bad));
});

test('legacy source conversion preserves formatting, nested lists, hard breaks and literal Markdown', async () => {
  const { markdownSource } = await import('../app/student-markdown.js');
  assert.equal(markdownSource(rich('Existing notes')), '**Existing notes**');
  const paragraph = text => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const doc = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Progress' }] },
    { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [paragraph('Parent'), { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('Child')] }] }] }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Link', marks: [{ type: 'italic' }, { type: 'link', attrs: { href: 'https://example.com/a(b)' } }] }, { type: 'hardBreak' }, { type: 'text', text: '**literal**' }] }
  ] };
  validateRichText(doc);
  assert.equal(markdownSource(doc), '## Progress\n\n3. Parent\n   \n   - Child\n\n[*Link*](https://example.com/a%28b%29)  \n\\*\\*literal\\*\\*');
  const source = '## Raw\n\n**text**\n'; assert.equal(markdownSource({ type: 'markdown', text: source }), source);
});
