import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NotebookStore, createApp } from '../server.js';
import { newNotebook } from '../notebooks.js';
const fixture = async t => { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldnotes-lifecycle-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; };
const change = async (store, ref, action, destination) => store.transfer({ ...ref, action, revision: (await store.item(ref)).revision, ...(destination ? { destination } : {}) });
const active = path => ({ scope: 'active', path });

test('archive, search, read-only reads, trash and restore preserve bytes, pins, images and origins across restarts', async t => {
  const root = await fixture(t); let store = await new NotebookStore(root).init();
  const content = '# Hello\r\n\r\nneedle needle'; await store.create({ path: '你好.md', content });
  await fs.writeFile(path.join(root, 'image.png'), 'image');
  store.state.attachments['你好.md'] = { 'image.png': { id: 'image-id', path: 'image.png' } };
  store.state.notebookOrigins['你好.md'] = '.'; await store.metadata({ path: '你好.md', pin: true, recent: true });
  const archived = await change(store, active('你好.md'), 'archive');
  assert.equal((await store.tree()).notes.length, 0); assert.equal((await store.tree()).archive.length, 1);
  assert.deepEqual((await store.tree()).pins, []); assert.deepEqual((await store.tree()).recent, []);
  assert.equal((await store.read('', archived)).content, content); assert.equal((await store.read('', archived)).readOnly, true);
  assert.equal((await store.search('needle')).occurrences, 2); assert.equal((await store.search('needle')).notes[0].scope, 'archive');
  store = await new NotebookStore(root).init(); assert.equal((await store.read('', archived)).attachments['image.png'], '/api/attachments/image-id');
  const trashed = await change(store, archived, 'trash'); assert.equal((await store.search('needle')).occurrences, 0);
  assert.equal(trashed.id, archived.id);
  const restoredArchive = await change(store, trashed, 'restore'); assert.equal(restoredArchive.id, archived.id); assert.equal(restoredArchive.scope, 'archive');
  const restored = await change(store, restoredArchive, 'restore'); assert.equal(restored.scope, 'active');
  assert.equal((await store.read(restored.path)).content, content); assert.deepEqual(store.state.pins, ['你好.md']); assert.equal(store.state.notebookOrigins['你好.md'], '.');
  assert.equal(await fs.readFile(await store.attachment('image-id'), 'utf8'), 'image');
});

test('nested folders move as units, including hidden and unrelated files; descendants restore separately and collisions never overwrite', async t => {
  const root = await fixture(t); const store = await new NotebookStore(root).init();
  await store.folder({ path: '研究 notes' }); await store.folder({ path: '研究 notes/子 folder' });
  await store.create({ path: '研究 notes/子 folder/a.md', content: 'a' }); await store.create({ path: '研究 notes/b.md', content: 'b' });
  await fs.writeFile(path.join(store.collection, '研究 notes/.private'), 'hidden'); await fs.writeFile(path.join(store.collection, '研究 notes/image.png'), 'image');
  store.state.attachments['研究 notes/b.md'] = { 'image.png': { id: 'local-image', path: 'collections/研究 notes/image.png' } }; await store.metadata({ path: '研究 notes/b.md', pin: true });
  await change(store, active('研究 notes'), 'move', 'renamed');
  assert.equal((await store.read('renamed/b.md')).content, 'b'); assert.deepEqual(store.state.pins, ['renamed/b.md']);
  assert.equal(await fs.readFile(await store.attachment('local-image'), 'utf8'), 'image');
  const archived = await change(store, active('renamed'), 'archive'); assert.equal((await store.item(archived)).fileCount, 4);
  assert.equal(await fs.readFile(await store.attachment('local-image'), 'utf8'), 'image');
  const child = { ...archived, path: '子 folder/a.md' };
  await change(store, child, 'restore', 'restored/deep/a.md'); assert.equal((await store.read('restored/deep/a.md')).content, 'a');
  assert.equal((await store.item(archived)).noteCount, 2);
  await store.folder({ path: 'renamed' }); await store.create({ path: 'renamed/kept.md', content: 'existing' });
  await assert.rejects(change(store, archived, 'restore'), { status: 409 });
  assert.equal((await store.read('renamed/kept.md')).content, 'existing');
  const restored = await change(store, archived, 'restore', 'another');
  assert.equal(await fs.readFile(path.join(store.collection, restored.path, '.private'), 'utf8'), 'hidden');
  assert.equal(await fs.readFile(await store.attachment('local-image'), 'utf8'), 'image');
  assert.deepEqual(store.state.pins, ['another/b.md']);
});

test('legacy trash discovery is repeatable, leaves files untouched, and restores with explicit collision handling', async t => {
  const root = await fixture(t); await fs.mkdir(path.join(root, '.notebook/trash'), { recursive: true });
  const names = ['1791351790373-aff5bf15-086b-4310-a82a-e3e4b22bfacb-test.md', '1791352143334-d4f38ee4-2f20-410d-b4f4-0b3d16b7c0f0-test.md'];
  for (const [i, name] of names.entries()) await fs.writeFile(path.join(root, '.notebook/trash', name), `copy ${i}`);
  let store = await new NotebookStore(root).init(); let entries = (await store.tree()).trash;
  assert.equal(entries.length, 2); assert.equal(entries[0].originalPath, null); assert.equal(entries[0].displayPath, 'test.md');
  store = await new NotebookStore(root).init(); assert.equal((await store.tree()).trash.length, 2);
  assert.equal(await fs.readFile(path.join(root, '.notebook/trash', names[0]), 'utf8'), 'copy 0');
  await change(store, entries[0], 'restore');
  await assert.rejects(change(store, entries[1], 'restore'), { status: 409 });
  await change(store, entries[1], 'restore', 'Recovered/test.md');
  assert.equal((await store.tree()).trash.length, 0); assert.equal((await store.tree()).notes.length, 2);
});

test('duplicate archived paths, empty folders, folder trash and permanent cleanup have independent identities', async t => {
  const store = await new NotebookStore(await fixture(t)).init();
  await store.create({ path: 'a.md', content: 'one' }); const first = await change(store, active('a.md'), 'archive');
  await store.create({ path: 'a.md', content: 'two' }); const second = await change(store, active('a.md'), 'archive');
  assert.notEqual(first.id, second.id); assert.equal((await store.read('', first)).content, 'one');
  await store.folder({ path: 'empty' }); const empty = await change(store, active('empty'), 'trash'); await change(store, empty, 'restore');
  assert.ok((await store.tree()).folders.includes('empty'));
  const trash1 = await change(store, first, 'trash'); await change(store, trash1, 'purge');
  assert.equal((await store.tree()).archive.length, 1);
  await change(store, second, 'trash'); await change(store, active('empty'), 'trash'); await store.emptyTrash();
  assert.equal((await store.tree()).trash.length, 0); assert.equal((await store.tree()).archive.length, 0);
});

test('revision and path checks protect external edits, folder descendants, traversal and symlinks', async t => {
  const root = await fixture(t); const store = await new NotebookStore(root).init();
  await store.folder({ path: 'folder' }); await store.create({ path: 'folder/a.md', content: 'one' });
  const before = await store.item(active('folder')); await fs.writeFile(path.join(store.collection, 'folder/a.md'), 'external');
  await assert.rejects(store.transfer({ ...active('folder'), action: 'trash', revision: before.revision }), { status: 409 });
  await assert.rejects(change(store, active('folder'), 'move', 'folder/child'), { status: 400 });
  for (const destination of ['../bad', '.hidden', '/bad']) await assert.rejects(change(store, active('folder'), 'move', destination), { status: 400 });
  const archive = await change(store, active('folder'), 'archive');
  await assert.rejects(store.item({ ...archive, path: '../secret' }), { status: 400 });
  await assert.rejects(store.save({ path: 'folder/a.md', scope: 'archive', content: 'bad' }), { status: 403 });
  await change(store, archive, 'restore'); await fs.symlink(os.tmpdir(), path.join(store.collection, 'folder/escape'));
  await assert.rejects(change(store, active('folder'), 'trash'), { status: 400 });
  assert.equal((await store.read('folder/a.md')).content, 'external');
});

test('interrupted move recovers its metadata and payload on restart without duplicating data', async t => {
  const root = await fixture(t); const store = await new NotebookStore(root).init(); await store.create({ path: 'a.md', content: 'recover' });
  await store.metadata({ path: 'a.md', pin: true });
  const persist = store.persist.bind(store); store.persist = async () => { throw new Error('simulated interrupted metadata write'); };
  await assert.rejects(change(store, active('a.md'), 'archive'), /interrupted/); store.persist = persist;
  assert.ok(await fs.stat(path.join(root, '.notebook/operation.json')));
  const restarted = await new NotebookStore(root).init(); const archive = (await restarted.tree()).archive[0];
  assert.equal((await restarted.read('', archive)).content, 'recover'); assert.equal((await restarted.tree()).notes.length, 0);
  await assert.rejects(fs.stat(path.join(root, '.notebook/operation.json')), { code: 'ENOENT' });
  await change(restarted, archive, 'restore'); assert.deepEqual(restarted.state.pins, ['a.md']);
});

test('shared indexed images survive permanent deletion of their containing folder', async t => {
  const root = await fixture(t); const store = await new NotebookStore(root).init();
  await store.folder({ path: 'assets' }); await fs.writeFile(path.join(store.collection, 'assets/image.png'), 'shared'); await store.create({ path: 'a.md', content: 'image' });
  store.state.attachments['a.md'] = { image: { id: 'shared', path: 'collections/assets/image.png' } }; await store.persist();
  const trash = await change(store, active('assets'), 'trash'); await change(store, trash, 'purge');
  assert.equal(await fs.readFile(await store.attachment('shared'), 'utf8'), 'shared');
});

test('HTTP lifecycle endpoints reject archived writes and busy/starting affected kernels', async t => {
  const root = await fixture(t); const { server, store, kernels } = await createApp(root); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await kernels.close(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, value, method = 'POST') => fetch(base + route, { method, headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  await store.create({ path: 'a.md', content: 'needle' }); const info = await store.item(active('a.md'));
  kernels.sessions.set('test', { id: 'test', path: 'a.md', ready: false });
  assert.equal((await post('/api/item', { ...active('a.md'), action: 'archive', revision: info.revision })).status, 409); kernels.sessions.delete('test');
  kernels.sessions.set('test', { id: 'test', path: 'a.md', ready: true, busy: true });
  assert.equal((await post('/api/item', { ...active('a.md'), action: 'trash', revision: info.revision })).status, 409); kernels.sessions.delete('test');
  await store.create({ path: 'b.ipynb', content: JSON.stringify(newNotebook()) });
  const discover = kernels.discover.bind(kernels); let release; kernels.discover = () => new Promise(resolve => { release = resolve; });
  const starting = kernels.start({ path: 'b.ipynb', environment: 'missing' }).catch(e => e);
  await new Promise(resolve => setTimeout(resolve, 10));
  const b = await store.item(active('b.ipynb'));
  assert.equal((await post('/api/item', { ...active('b.ipynb'), action: 'archive', revision: b.revision })).status, 409);
  release([]); assert.equal((await starting).status, 400); kernels.discover = discover;
  let stopped = false; const stop = kernels.stop.bind(kernels); kernels.stop = id => { stopped = true; kernels.sessions.delete(id); };
  kernels.sessions.set('test', { id: 'test', path: 'a.md', ready: true, busy: false });
  const archive = await (await post('/api/item', { ...active('a.md'), action: 'archive', revision: info.revision })).json();
  assert.equal(stopped, true); kernels.stop = stop;
  assert.equal((await post('/api/folder', { scope: 'trash', path: 'bad' })).status, 403);
  assert.equal((await post('/api/note', { scope: 'archive', path: 'a.md', content: 'bad' }, 'PUT')).status, 403);
  assert.equal((await post('/api/kernel/start', { scope: 'archive', path: 'a.md' })).status, 403);
  assert.equal((await (await fetch(base + '/api/search?q=needle')).json()).notes[0].scope, 'archive');
  const note = await (await fetch(base + '/api/note?' + new URLSearchParams({ scope: 'archive', id: archive.id, path: '' }))).json(); assert.equal(note.readOnly, true);
});

test('Jupyter lifecycle preserves serialized outputs, embedded images and working directory through folder moves and restores', async t => {
  const root = await fixture(t); let store = await new NotebookStore(root).init();
  await store.folder({ path: '实验 folder' });
  const notebook = newNotebook(); notebook.cells[0].source = ['print("hello")\n']; notebook.cells[0].execution_count = 7; notebook.cells[0].outputs = [{ output_type: 'stream', name: 'stdout', text: ['hello\n'] }];
  notebook.cells.push({ cell_type: 'markdown', metadata: {}, source: ['![embedded](attachment:a.png)'], attachments: { 'a.png': { 'image/png': 'aGVsbG8=' } } });
  const raw = JSON.stringify(notebook, null, 2) + '\r\n'; await store.create({ path: '实验 folder/笔记.ipynb', content: raw });
  store.state.notebookOrigins['实验 folder/笔记.ipynb'] = 'original helpers'; await store.metadata({ path: '实验 folder/笔记.ipynb', pin: true });
  await change(store, active('实验 folder'), 'move', 'Moved folder');
  const archived = await change(store, active('Moved folder'), 'archive'); const child = { ...archived, path: '笔记.ipynb' };
  assert.equal((await store.read(child.path, child)).content, raw); assert.equal((await store.read(child.path, child)).kind, 'jupyter');
  const trash = await change(store, archived, 'trash'); store = await new NotebookStore(root).init();
  const archive = await change(store, trash, 'restore'); await change(store, archive, 'restore', 'Recovered folder');
  assert.equal((await store.read('Recovered folder/笔记.ipynb')).content, raw);
  assert.equal(store.state.notebookOrigins['Recovered folder/笔记.ipynb'], 'original helpers'); assert.deepEqual(store.state.pins, ['Recovered folder/笔记.ipynb']);
});

test('a prepared journal preserves collision copies and finishes a multi-item deletion after restart', async t => {
  const root = await fixture(t); let store = await new NotebookStore(root).init();
  await store.create({ path: 'a.md', content: 'first' }); await store.create({ path: 'b.md', content: 'second' });
  await change(store, active('a.md'), 'trash'); await change(store, active('b.md'), 'trash');
  store.recoverOperation = async () => { throw new Error('interrupted before rename'); };
  await assert.rejects(store.emptyTrash(), /interrupted/);
  const operation = JSON.parse(await fs.readFile(path.join(root, '.notebook/operation.json')));
  const target = path.join(root, operation.moves[0].target); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, 'unexpected copy');
  await assert.rejects(new NotebookStore(root).init(), { status: 409 });
  assert.equal(await fs.readFile(target, 'utf8'), 'unexpected copy'); assert.equal(await fs.readFile(path.join(root, operation.moves[0].source), 'utf8'), 'first');
  await fs.unlink(target); store = await new NotebookStore(root).init(); assert.equal((await store.tree()).trash.length, 0);
  await assert.rejects(fs.access(path.join(root, '.notebook/operation.json'))); assert.deepEqual(await fs.readdir(path.join(root, '.notebook/purging')), []);
});
