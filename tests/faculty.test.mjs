import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';
import { newFaculty, validateFaculty, markdownNote, facultyCategoryId } from '../faculty-model.js';
import { validateCalendar } from '../calendar-model.js';
import { updateTask } from '../daily-model.js';
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-faculty-'));
  const app = await createApp(root, { now: () => Date.parse('2026-10-20T00:00:00Z') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.terminals.close(); await app.kernels.close(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const req = (url, method = 'GET', body, origin = base) => fetch(base + url, { method, headers: { Origin: origin, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const member = await app.faculty.create({ name: 'Dr Ada Example', profile: { institution: 'Synthetic Institute', department: 'Computing', position: 'Professor', email: 'ada@example.test', researchAreas: 'Reproducibility', notes: markdownNote('## Profile notes') } });
  const event = { id: randomUUID(), facultyId: member.document.id, title: 'Dr Ada Example · Conversation', start: '2026-10-20T02:00:00.000Z', durationMinutes: 30, categoryId: facultyCategoryId, timeZone: 'Asia/Shanghai' };
  return { root, app, req, member, event };
}
test('Faculty CRUD, independent records, versions, search, export, and validation', async t => {
  const f = await fixture(t), id = f.member.document.id, original = structuredClone(f.member);
  f.member.document.preparation = { date: '2026-10-21', agenda: markdownNote('**Prepare** collaboration') };
  f.member.document.sessions.push({ id: randomUUID(), date: '2026-10-20', title: 'Synthetic collaboration', discussion: markdownNote('## Evidence'), decisions: markdownNote('- Verify baseline'), correction: markdownNote('Corrected a synthetic assumption'), tasks: [{ id: randomUUID(), text: 'Share reproducibility checklist', owner: 'Me', dueDate: '2026-10-25', done: false }] });
  f.member = await f.app.faculty.save(id, f.member);
  assert.equal((await f.req('/api/faculty/' + id, 'PUT', original)).status, 409);
  assert.equal((await f.req('/api/faculty', 'POST', { name: 'Blocked' }, 'http://untrusted.invalid')).status, 403);
  assert.equal((await f.req('/api/faculty/' + id, 'PUT', { document: f.member.document })).status, 400);
  let found = await (await f.req('/api/search?q=checklist')).json(); assert.equal(found.faculty[0].matches[0].sessionId, f.member.document.sessions[0].id);
  assert.equal((await (await f.req('/api/search?q=Profile%20notes')).json()).faculty.length, 1);
  const listed = await (await f.req('/api/faculty')).json(); assert.equal(listed.faculty[0].openTasks, 1);
  f.member.document.archived = true; f.member = await f.app.faculty.save(id, f.member); assert.equal((await f.app.faculty.list()).faculty[0].archived, true);
  assert.deepEqual((await f.app.faculty.export()).faculty[0], f.member.document);
  assert.equal((await f.app.students.list()).students.length, 0);
  const restarted = await createApp(f.root); t.after(async () => { await restarted.terminals.close(); await restarted.kernels.close(); }); assert.deepEqual((await restarted.faculty.read(id)).document, f.member.document);
  assert.ok((await fs.readdir(path.join(f.app.store.stateDir, 'faculty-versions', id))).length >= 2);
  for (const mutate of [d => d.objectives = [], d => d.timetables = [], d => d.profile.email = 'bad', d => d.sessions[0].tasks[0].owner = 'Supervisor', d => d.sessions[0].tasks[0].id = d.id]) { const d = structuredClone(f.member.document); mutate(d); assert.throws(() => validateFaculty(d), { status: 400 }); }
  assert.throws(() => validateFaculty(newFaculty(randomUUID(), ' ')), { status: 400 });
});
test('Faculty Calendar checks are calendar-only, preserve event identity, and reject stale acknowledgment', async t => {
  const f = await fixture(t); const check = () => f.req(`/api/faculty/${f.member.document.id}/check`, 'POST', { event: f.event });
  let checked = await (await check()).json(); assert.equal(checked.incomplete, false); assert.deepEqual(checked.classes, []); assert.equal(checked.conflicts.length, 0); assert.ok(checked.slots.length);
  const calendar = await f.app.calendar.read(); const busy = { id: randomUUID(), title: 'Supervisor booking', start: f.event.start, durationMinutes: 60 }; calendar.document.events.push(busy); await f.app.calendar.save(calendar);
  checked = await (await check()).json(); assert.equal(checked.conflicts.length, 1); assert.equal(checked.conflicts[0].eventId, busy.id); assert.equal(checked.conflicts[0].title, busy.title);
  let next = await f.app.calendar.read(); next.document.events.push(f.event);
  assert.equal((await f.req('/api/calendar', 'PUT', next)).status, 409);
  f.member.document.profile.department = 'Changed elsewhere'; f.member = await f.app.faculty.save(f.member.document.id, f.member);
  assert.equal((await f.req('/api/calendar', 'PUT', { ...next, acknowledgements: { [f.event.id]: checked.acknowledgement } })).status, 409);
  checked = await (await check()).json(); assert.equal((await f.req('/api/calendar', 'PUT', { ...next, acknowledgements: { [f.event.id]: checked.acknowledgement } })).status, 200);
  next = await f.app.calendar.read(); delete next.document.events.find(e => e.id === f.event.id).facultyId; assert.equal((await f.req('/api/calendar', 'PUT', next)).status, 400);
  for (const patch of [{ studentId: randomUUID() }, { durationMinutes: undefined }, { facultyId: 'bad' }]) assert.throws(() => validateCalendar({ ...calendar.document, events: [{ ...f.event, ...patch }] }), { status: 400 });
  assert.equal((await f.req(`/api/faculty/${randomUUID()}/check`, 'POST', { event: f.event })).status, 404);
});
test('Faculty bookings reconcile once to Daily, reschedule and cancel without changing conversation notes or tasks', async t => {
  const f = await fixture(t); const beforeCategories = (await f.app.daily.read()).document.categories.map(c => c.id);
  f.member.document.sessions.push({ id: randomUUID(), date: '2026-10-20', title: 'Record', discussion: markdownNote('Preserve notes'), decisions: markdownNote(), correction: markdownNote(), tasks: [{ id: randomUUID(), text: 'Keep task open', owner: 'Faculty member', dueDate: '', done: false }] }); await f.app.faculty.save(f.member.document.id, f.member);
  let calendar = await f.app.calendar.read(); calendar.document.events.push(f.event); assert.equal((await f.req('/api/calendar', 'PUT', calendar)).status, 200);
  let daily = await f.app.daily.read(); assert.equal(daily.document.tasks.length, 1); const task = daily.document.tasks[0]; assert.equal(task.id, f.event.id); assert.equal(task.versions.at(-1).facultyId, f.member.document.id); assert.equal(task.versions.at(-1).categoryId, facultyCategoryId); assert.deepEqual(daily.document.categories.slice(0, beforeCategories.length).map(c => c.id), beforeCategories);
  updateTask(task, '2026-10-20', { status: 'completed' }); await f.app.daily.save(daily); assert.equal((await f.app.daily.read()).document.tasks[0].versions.at(-1).status, 'completed');
  calendar = await f.app.calendar.read(); calendar.document.events[0].start = '2026-10-21T03:00:00.000Z'; assert.equal((await f.req('/api/calendar', 'PUT', calendar)).status, 200);
  daily = await f.app.daily.read(); assert.equal(daily.document.tasks.length, 1); assert.equal(daily.document.tasks[0].id, f.event.id); assert.equal(daily.document.tasks[0].versions.at(-1).scheduledDate, '2026-10-21');
  calendar = await f.app.calendar.read(); calendar.document.events = []; assert.equal((await f.req('/api/calendar', 'PUT', calendar)).status, 200); assert.equal((await f.app.daily.read()).document.tasks[0].calendarEvent.deleted, true); assert.deepEqual((await f.app.faculty.read(f.member.document.id)).document.sessions, f.member.document.sessions);
});
test('Faculty availability uses the booking timezone and includes unsaved Calendar events', async t => {
  const f = await fixture(t); const event = { ...f.event, timeZone: 'America/New_York', start: '2026-10-20T14:00:00.000Z' };
  const draft = { id: randomUUID(), title: 'Unsaved booking', start: event.start, durationMinutes: 30 };
  const checked = await (await f.req(`/api/faculty/${event.facultyId}/check`, 'POST', { event, draftEvents: [draft] })).json(); assert.equal(checked.timeZone, 'America/New_York'); assert.equal(checked.conflicts[0].eventId, draft.id); assert.ok(checked.slots.every(s => s.start >= '2026-10-20T12:30:00.000Z'));
});
