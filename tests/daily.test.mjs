import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { NotebookStore, createApp } from '../server.js';
import { DailyStore } from '../daily.js';
import { newDaily, newTask, normalizeDaily, updateTask, stateAt, visibleTasks, validateDaily, validDate, localDate, shiftDate, markdownExport } from '../daily-model.js';
const task = (date = '2026-10-09', text = 'Read paper') => newTask(randomUUID(), date, text, 'category-0');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldnotes-daily-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const notes = await new NotebookStore(root).init(), daily = await new DailyStore(notes).init(); return { root, notes, daily };
}
test('dated snapshots carry tasks once across missed days and preserve completion history', () => {
  const doc = newDaily(randomUUID()), item = task(); doc.tasks.push(item);
  updateTask(item, '2026-10-09', { details: '**important**', deadline: '2026-10-11', subtasks: [{ id: randomUUID(), text: 'Baseline', done: false }] });
  assert.equal(visibleTasks(doc, '2026-10-08').length, 0);
  for (const date of ['2026-10-09', '2026-10-10', '2026-10-15', '2027-01-01']) { assert.equal(visibleTasks(doc, date).length, 1); assert.equal(visibleTasks(doc, date)[0].task.id, item.id); }
  updateTask(item, '2026-10-10', { status: 'completed' });
  assert.equal(stateAt(item, '2026-10-09').status, 'open'); assert.equal(visibleTasks(doc, '2026-10-10')[0].state.status, 'completed'); assert.equal(visibleTasks(doc, '2026-10-11').length, 0);
  updateTask(item, '2026-10-12', { status: 'open', scheduledDate: '2026-10-12' });
  assert.equal(visibleTasks(doc, '2026-10-13')[0].state.deadline, '2026-10-11'); assert.equal(stateAt(item, '2026-10-09').subtasks[0].done, false);
  updateTask(item, '2026-10-13', { subtasks: [{ ...stateAt(item, '2026-10-13').subtasks[0], done: true }] });
  assert.equal(stateAt(item, '2026-10-12').subtasks[0].done, false); validateDaily(doc);
});
test('scheduling, cancellation, optional fields, category changes, and daily notes', () => {
  const doc = newDaily(randomUUID()), item = task(); doc.tasks.push(item); doc.days['2026-10-09'] = { notes: 'Reflection' };
  updateTask(item, '2026-10-10', { scheduledDate: '2026-10-15' });
  assert.equal(visibleTasks(doc, '2026-10-10').length, 1); // rescheduling record remains accessible
  assert.equal(visibleTasks(doc, '2026-10-11').length, 0); assert.equal(visibleTasks(doc, '2026-10-15').length, 1);
  doc.categories[0].hidden = true; doc.categories[0].name = 'Reading'; doc.categories.reverse(); validateDaily(doc);
  assert.equal(visibleTasks(doc, '2026-10-15')[0].state.categoryId, 'category-0'); assert.equal(doc.days['2026-10-10'], undefined);
  updateTask(item, '2026-10-15', { status: 'cancelled' }); assert.equal(visibleTasks(doc, '2026-10-16').length, 0);
  const uncat = newTask(randomUUID(), '2026-10-15', 'No metadata'); doc.tasks.push(uncat); validateDaily(doc);
  const output = markdownExport(doc); assert.match(output, /Reading/); assert.match(output, /Reflection/); assert.match(output, /cancelled/); assert.match(output, /Miscellaneous/);
});
test('validates malformed records, blanks, date boundaries and local dates', () => {
  assert.equal(validDate('2024-02-29'), true); assert.equal(validDate('2026-02-29'), false); assert.equal(validDate('2026-13-01'), false);
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01'); assert.equal(shiftDate('2026-03-01', -1), '2026-02-28'); assert.equal(localDate(new Date(2026, 9, 10, 23, 59)), '2026-10-10');
  const doc = newDaily(randomUUID()); doc.tasks.push(task());
  for (const mutate of [d => d.tasks[0].versions[0].text = ' ', d => d.tasks[0].versions[0].time = '24:01', d => d.tasks[0].versions[0].deadline = '2026-02-29', d => d.tasks[0].versions[0].categoryId = 'missing', d => d.tasks.push(d.tasks[0]), d => d.tasks[0].versions.push(d.tasks[0].versions[0]), d => d.categories.push(null), d => d.days['bad'] = { notes: '' }, d => d.tasks[0].versions[0].subtasks.push({ id: randomUUID(), text: '', done: false })]) {
    const bad = structuredClone(doc); mutate(bad); assert.throws(() => validateDaily(bad), { status: 400 });
  }
});
test('disk persistence, revision conflicts, twenty versions, exports, and invalid file preservation', async t => {
  const { root, notes, daily } = await fixture(t); let saved = await daily.read(); const old = structuredClone(saved);
  saved.document.tasks.push(task()); saved = await notes.serialize(() => daily.save(saved));
  await assert.rejects(daily.save(old), { status: 409 }); await assert.rejects(daily.save(null), { status: 400 });
  for (let n = 0; n < 22; n++) { updateTask(saved.document.tasks[0], '2026-10-10', { text: `Step ${n}` }); saved = await notes.serialize(() => daily.save(saved)); }
  assert.equal((await fs.readdir(path.join(root, '.notebook/daily/versions'))).length, 20);
  const restart = await new DailyStore(await new NotebookStore(root).init()).init(); assert.deepEqual((await restart.read()).document, saved.document);
  assert.deepEqual((await restart.export()).document, saved.document); assert.match((await restart.export('markdown')).content, /Step 21/);
  const file = path.join(root, '.notebook/daily/workspace.json'); await fs.writeFile(file, 'broken'); await assert.rejects(restart.read(), { status: 400 }); assert.equal(await fs.readFile(file, 'utf8'), 'broken');
});
const log = `# 2026-10-14\n- [ ] Never import future\n# 2026-10-10\n- 学习\n  - [ ] git github\n- 学生\n  - [ ] Example research question\n- 杂事\n  - Example review\n# 2026-10-09\n- 学生指导\n  - [x] Example Student 17:10\n- 学习\n  - [ ] git github\n  - [x] Example lecture\n- 开发\n  - [ ] Build daily\n    - [x] Choose categories\n    - preserve this nested note\n- 杂事\n  - 打球\n\nA reflection with https://example.com\n# 2026-10-08\n- [ ] Never import older\n`;
test('import preview restricts dates, maps English groups, deduplicates, preserves notes and is repeat-safe', async t => {
  const { root, daily } = await fixture(t); await fs.mkdir(path.join(root, 'collections/schedule')); const file = path.join(root, 'collections/schedule/2026.md'); await fs.writeFile(file, log);
  const before = await daily.read(), preview = await daily.preview({ source: 'schedule/2026.md', from: '2026-10-09', to: '2026-10-10' }); assert.deepEqual((await daily.read()).document, before.document);
  assert.deepEqual(preview.dates, ['2026-10-09', '2026-10-10']); assert.equal(preview.taskCount, 5);
  const git = preview.document.tasks.find(t => t.versions[0].text === 'git github'); assert.deepEqual(git.appearances, ['2026-10-09', '2026-10-10']); assert.equal(git.originDate, '2026-10-09');
  const build = preview.document.tasks.find(t => t.versions[0].text === 'Build daily'); assert.equal(build.versions[0].subtasks[0].done, true); assert.match(build.versions[0].details, /nested note/);
  assert.match(preview.document.days['2026-10-10'].notes, /Example review/); assert.match(preview.document.days['2026-10-09'].notes, /https:\/\/example.com/);
  assert.equal(visibleTasks(preview.document, '2026-10-11').length, 3);
  const applied = await daily.apply(preview); assert.deepEqual(applied.document, preview.document); assert.equal(await fs.readFile(file, 'utf8'), log);
  assert.equal((await daily.preview({ source: 'schedule/2026.md', from: '2026-10-09', to: '2026-10-10' })).dates.length, 0); await assert.rejects(daily.apply(await daily.preview({ source: 'schedule/2026.md', from: '2026-10-09', to: '2026-10-10' })), { status: 409 });
});
test('import rejects stale source or Daily revision and keeps unrelated Daily data', async t => {
  const { root, daily } = await fixture(t); await fs.mkdir(path.join(root, 'collections/schedule')); const file = path.join(root, 'collections/schedule/2026.md'); await fs.writeFile(file, log);
  let saved = await daily.read(); saved.document.days['2026-10-09'] = { notes: 'Existing note' }; saved = await daily.save(saved);
  let preview = await daily.preview({ source: 'schedule/2026.md', from: '2026-10-09', to: '2026-10-10' }); assert.match(preview.document.days['2026-10-09'].notes, /Existing note/);
  await fs.writeFile(file, log + '\nChanged'); await assert.rejects(daily.apply(preview), { status: 409 });
  preview = await daily.preview({ source: 'schedule/2026.md', from: '2026-10-09', to: '2026-10-10' }); saved.document.categories[0].name = 'Reading'; await daily.save(saved); await assert.rejects(daily.apply(preview), { status: 409 });
});
test('full text search covers formatted details, historical edits, subtasks, completed/cancelled and notes without carried duplicates', async t => {
  const { daily } = await fixture(t); let saved = await daily.read(); const item = task('2026-10-09', 'Needle report'); saved.document.tasks.push(item);
  updateTask(item, '2026-10-09', { details: '**中文关键词** needle', subtasks: [{ id: randomUUID(), text: 'a+b Needle', done: true }] });
  updateTask(item, '2026-10-10', { text: 'Changed title', details: 'New notes', status: 'completed' });
  saved.document.days['2026-10-10'] = { notes: 'Needle reflection' }; await daily.save(saved);
  const results = await daily.search('NEEDLE'); assert.equal(results.length, 2); assert.equal(results[0].count, 3); assert.equal(results[0].date, '2026-10-10'); assert.equal(results[0].matches.find(m => m.snippet === 'Needle report').date, '2026-10-09'); assert.equal(results[0].status, 'completed');
  for (const match of results[0].matches) assert.equal(match.snippet.slice(match.highlight, match.highlight + match.length).toLowerCase(), 'needle');
  assert.equal((await daily.search('中文关键词')).length, 1); assert.equal((await daily.search('a+b')).length, 1); assert.equal((await daily.search('Learning')).length, 1); assert.equal((await daily.search('')).length, 0);
});
test('API search includes Daily and notebooks; API saves enforce origin and conflicts', async t => {
  const { root } = await fixture(t); const app = await createApp(root); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.terminals.close(); await app.kernels.close(); await new Promise(resolve => app.server.close(resolve)); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  await fs.writeFile(path.join(root, 'collections/needle.md'), '# needle');
  const saved = await (await fetch(base + '/api/daily')).json(); saved.document.tasks.push(task('2026-10-09', 'needle'));
  const put = input => fetch(base + '/api/daily', { method: 'PUT', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal((await put(saved)).status, 200); assert.equal((await put(saved)).status, 409);
  const result = await (await fetch(base + '/api/search?q=needle')).json(); assert.equal(result.notes.length, 1); assert.equal(result.daily.length, 1); assert.equal(result.occurrences, 2);
  assert.equal((await fetch(base + '/api/daily', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.match((await (await fetch(base + '/api/daily/export?format=markdown')).json()).content, /needle/);
});
test('rejects symlink storage without changing target', async t => {
  const { root, daily } = await fixture(t); const target = path.join(root, 'target.json'); await fs.writeFile(target, '{}'); const file = path.join(root, '.notebook/daily/workspace.json'); await fs.rm(file); await fs.symlink(target, file);
  await assert.rejects(daily.read(), { status: 400 }); assert.equal(await fs.readFile(target, 'utf8'), '{}');
});

test('legacy uncategorized tasks merge into Miscellaneous without losing versions or changing disk on read', async t => {
  const { root, daily } = await fixture(t); const original = await daily.read();
  const legacy = newTask(randomUUID(), '2026-10-09', 'Legacy task', '');
  updateTask(legacy, '2026-10-10', { details: 'Preserved details' }); original.document.tasks.push(legacy);
  const file = path.join(root, '.notebook/daily/workspace.json'), bytes = JSON.stringify(original.document);
  await fs.writeFile(file, bytes); const read = await daily.read();
  assert.deepEqual(read.document.tasks[0].versions.map(v => v.categoryId), ['category-5', 'category-5']);
  assert.equal(read.document.tasks[0].versions[1].details, 'Preserved details'); assert.equal(await fs.readFile(file, 'utf8'), bytes);
  assert.equal((await daily.search('Miscellaneous')).length, 1); assert.match((await daily.export('markdown')).content, /Miscellaneous/);
  const saved = await daily.save(read); assert.deepEqual(saved.document, read.document);
  const renamed = newDaily(randomUUID()); renamed.categories[5].name = 'Personal'; renamed.tasks.push(newTask(randomUUID(), '2026-10-09', 'Legacy', ''));
  normalizeDaily(renamed); assert.equal(renamed.tasks[0].versions[0].categoryId, 'category-5'); assert.equal(renamed.categories.length, 6);
});
