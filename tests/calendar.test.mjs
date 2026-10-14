import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { NotebookStore, createApp } from '../server.js';
import { CalendarStore } from '../calendar.js';
import { newCalendar, validateCalendar, localInput, utcFromLocal, sortedEvents, dueEvents, reminderKey, eventEnd } from '../calendar-model.js';
const event = (start = '2026-10-10T09:00:00.000Z') => ({ id: randomUUID(), title: 'Meeting 中文', start });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldnotes-calendar-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const notes = await new NotebookStore(root).init(); const calendar = await new CalendarStore(notes).init(); return { root, notes, calendar };
}
test('title and start suffice; optional fields and invalid records', () => {
  const doc = newCalendar(randomUUID()); doc.events.push(event()); validateCalendar(doc);
  doc.events[0].location = 'Room A'; doc.events[0].durationMinutes = 45; validateCalendar(doc);
  for (const mutate of [d => d.schemaVersion = 2, d => d.events.push(d.events[0]), d => d.events[0].title = ' ', d => delete d.events[0].start, d => d.events[0].start = '2026-02-30T09:00:00.000Z', d => d.events[0].start = '2026-10-10T09:00:00+08:00', d => d.events[0].location = 3, ...[0, -1, 1.5, null, '45', 1e20].map(n => d => d.events[0].durationMinutes = n)]) {
    const bad = structuredClone(doc); mutate(bad); assert.throws(() => validateCalendar(bad), { status: 400 });
  }
});
test('local times convert to UTC, reject rolled dates and DST gaps, and retain instants across zones', () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Shanghai'; assert.equal(utcFromLocal('2026-10-10T09:30'), '2026-10-10T01:30:00.000Z');
    assert.equal(localInput('2026-10-10T01:30:00.000Z'), '2026-10-10T09:30');
    for (const value of ['', '2026-02-30T09:30', '2026-10-10T24:01']) assert.throws(() => utcFromLocal(value));
    process.env.TZ = 'America/New_York'; assert.throws(() => utcFromLocal('2026-03-08T02:30'));
    assert.equal(localInput('2026-10-10T01:30:00.000Z'), '2026-10-09T21:30');
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});
test('agenda ordering and reminder window boundaries, rescheduling and deletion', () => {
  const a = event(), b = event('2026-10-10T08:00:00.000Z');
  assert.deepEqual(sortedEvents([a,b]), [b,a]);
  const start = Date.parse(a.start); assert.equal(dueEvents([a], start - 600001).length, 0); assert.equal(dueEvents([a], start - 600000).length, 1);
  assert.equal(dueEvents([a], start - 1).length, 1); assert.equal(dueEvents([a], start).length, 0); assert.equal(dueEvents([a], start + 1).length, 0);
  assert.notEqual(reminderKey(a), reminderKey({ ...a, start: b.start })); assert.deepEqual(dueEvents([], start - 1), []);
});
test('persistence, export, stale revisions, identity, twenty versions and corrupt-file preservation', async t => {
  const { root, notes, calendar } = await fixture(t); let saved = await calendar.read(); const stale = structuredClone(saved);
  saved.document.events.push(event()); saved = await notes.serialize(() => calendar.save(saved));
  await assert.rejects(calendar.save(stale), { status:409 }); await assert.rejects(calendar.save(null), { status:400 });
  const changed = structuredClone(saved); changed.document.id = randomUUID(); await assert.rejects(calendar.save(changed), { status:400 });
  for (let n=0;n<22;n++) { saved.document.events[0].title = `Event ${n}`; saved = await notes.serialize(() => calendar.save(saved)); }
  assert.equal((await fs.readdir(path.join(root,'.notebook/calendar/versions'))).length,20);
  const restart = await new CalendarStore(notes).init(); assert.deepEqual((await restart.export()).document,saved.document);
  const file = path.join(root,'.notebook/calendar/workspace.json'); await fs.writeFile(file,'broken'); await assert.rejects(restart.read(),{status:400}); assert.equal(await fs.readFile(file,'utf8'),'broken');
  await fs.writeFile(file,JSON.stringify({schemaVersion:2})); await assert.rejects(restart.init(),{status:400}); assert.equal(await fs.readFile(file,'utf8'),JSON.stringify({schemaVersion:2}));
});
test('storage rejects symlinks in workspace and directories', async t => {
  const { root, calendar } = await fixture(t); const target = path.join(root,'target.json'); await fs.writeFile(target,'{}');
  const file = path.join(root,'.notebook/calendar/workspace.json'); await fs.rm(file); await fs.symlink(target,file);
  await assert.rejects(calendar.read(),{status:400}); assert.equal(await fs.readFile(target,'utf8'),'{}');
  await fs.rm(path.join(root,'.notebook/calendar'),{recursive:true}); await fs.symlink(root,path.join(root,'.notebook/calendar'));
  await assert.rejects(calendar.init(),{status:400});
});
test('API validates input, enforces origin, persists and returns conflicts', async t => {
  const { root } = await fixture(t); const app = await createApp(root); await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { await app.terminals.close(); await app.kernels.close(); await new Promise(resolve => app.server.close(resolve)); });
  const base = `http://127.0.0.1:${app.server.address().port}`; const saved = await (await fetch(base+'/api/calendar')).json(); saved.document.events.push(event());
  const put = input => fetch(base+'/api/calendar',{method:'PUT',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(input)});
  assert.equal((await put(saved)).status,200); assert.equal((await put(saved)).status,409);
  const bad = await (await fetch(base+'/api/calendar')).json(); bad.document.events[0].durationMinutes = 0; assert.equal((await put(bad)).status,400);
  assert.equal((await fetch(base+'/api/calendar',{method:'PUT',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.deepEqual((await (await fetch(base+'/api/calendar/export')).json()).document,saved.document);
});

test('explicit end and calculated end validate, including overnight and invalid combinations', () => {
  const doc = newCalendar(randomUUID()); const e = event(); doc.events.push(e);
  assert.equal(eventEnd(e), undefined);
  e.durationMinutes = 45; validateCalendar(doc); assert.equal(eventEnd(e), '2026-10-10T09:45:00.000Z');
  delete e.durationMinutes; e.end = '2026-10-11T01:00:00.000Z'; validateCalendar(doc); assert.equal(eventEnd(e), e.end);
  for (const end of [null, 3, '', e.start, '2026-10-10T08:00:00.000Z', '2026-02-30T09:00:00.000Z', '2026-10-11T01:00:00+00:00']) {
    assert.throws(() => validateCalendar({ ...doc, events: [{ ...e, end }] }), { status: 400 });
  }
  e.durationMinutes = 45; assert.throws(() => validateCalendar(doc), { status: 400 });
});
