import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { NotebookStore, createApp } from '../server.js';
import { migrate, hash } from '../scripts/migrate.mjs';
async function fixture(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldnotes-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }

test('migration preserves bytes, hierarchy, attachments and unrelated files; reruns are safe', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, '研究 notes/nested'), { recursive: true });
  await fs.mkdir(path.join(root, '.venv'), { recursive: true });
  const content = '# 本子\r\n\r\n![diagram](image.png)\nunsaved git content';
  await fs.writeFile(path.join(root, '研究 notes/a.md'), content);
  await fs.writeFile(path.join(root, '研究 notes/image.png'), 'image bytes');
  await fs.writeFile(path.join(root, '研究 notes/nested/b.MD'), '# B');
  await fs.writeFile(path.join(root, 'README.md'), '# root');
  await fs.writeFile(path.join(root, '.venv/dependency.md'), 'leave alone');
  assert.deepEqual(await migrate(root), { moved: 3, verified: 3, imported: 3 });
  assert.equal(await fs.readFile(path.join(root, 'collections/研究 notes/a.md'), 'utf8'), content);
  assert.equal(await fs.readFile(path.join(root, '.venv/dependency.md'), 'utf8'), 'leave alone');
  assert.equal(await fs.readFile(path.join(root, '研究 notes/image.png'), 'utf8'), 'image bytes');
  await assert.rejects(fs.stat(path.join(root, '研究 notes/a.md')), { code: 'ENOENT' });
  const appReadme = '<!-- fieldnotes: app-documentation -->\n# Workbench';
  await fs.writeFile(path.join(root, 'README.md'), appReadme);
  assert.deepEqual(await migrate(root), { moved: 0, verified: 0, imported: 3 });
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), appReadme);
  assert.equal(await fs.readFile(path.join(root, 'collections/README.md'), 'utf8'), '# root');
  const manifest = JSON.parse(await fs.readFile(path.join(root, '.notebook/import-manifest.json')));
  assert.equal(manifest.notes.find(n => n.path === '研究 notes/a.md').sha256, hash(content));
  const store = await new NotebookStore(root).init();
  const note = await store.read('研究 notes/a.md');
  assert.match(note.attachments['image.png'], /^\/api\/attachments\//);
});

test('migration collision stops before any note moves; symlink destinations are refused', async t => {
  const root = await fixture(t); await fs.mkdir(path.join(root, 'collections'));
  await fs.writeFile(path.join(root, 'a.md'), 'source a'); await fs.writeFile(path.join(root, 'z.md'), 'source z');
  await fs.writeFile(path.join(root, 'collections/z.md'), 'existing');
  await assert.rejects(migrate(root), /collision/);
  assert.equal(await fs.readFile(path.join(root, 'a.md'), 'utf8'), 'source a');
  assert.equal(await fs.readFile(path.join(root, 'collections/z.md'), 'utf8'), 'existing');
  await fs.rm(path.join(root, 'collections'), { recursive: true });
  await fs.symlink(os.tmpdir(), path.join(root, 'collections'));
  await assert.rejects(migrate(root), /Unsafe directory/);
});

test('CRUD, pins and recents survive restart; move updates attachment and metadata paths; delete is recoverable', async t => {
  const root = await fixture(t); let store = await new NotebookStore(root).init();
  await store.folder({ path: 'nested' });
  const note = await store.create({ path: 'nested/你好.md', content: '# Hello\nhello HELLO' });
  const saved = await store.save({ path: note.path, content: '# Updated', revision: note.revision });
  assert.equal(saved.content, '# Updated'); assert.notEqual(saved.revision, note.revision);
  await store.metadata({ path: note.path, pin: true, recent: true });
  store.state.attachments[note.path] = { 'image.png': { id: 'x', path: 'image.png' } };
  const moved = await store.move({ path: note.path, destination: 'Moved.md', revision: saved.revision });
  assert.deepEqual(store.state.pins, ['Moved.md']); assert.deepEqual(store.state.recent, ['Moved.md']); assert.ok(moved.attachments['image.png']);
  store = await new NotebookStore(root).init(); assert.deepEqual((await store.tree()).pins, ['Moved.md']);
  await store.remove({ path: moved.path, revision: moved.revision });
  assert.equal((await store.tree()).notes.length, 0); assert.equal(store.state.pins.length, 0);
  const trash = await fs.readdir(path.join(root, '.notebook/trash')); assert.equal(trash.length, 1);
  assert.equal(await fs.readFile(path.join(root, '.notebook/trash', trash[0], 'payload'), 'utf8'), '# Updated');
});

test('revision conflicts retain disk content and forced save is explicit; missing files are not recreated', async t => {
  const store = await new NotebookStore(await fixture(t)).init();
  const note = await store.create({ path: 'a.md', content: 'one' });
  await fs.writeFile(path.join(store.collection, 'a.md'), 'external');
  await assert.rejects(store.save({ path: note.path, content: 'draft', revision: note.revision }), { status: 409 });
  assert.equal((await store.read('a.md')).content, 'external');
  const saved = await store.save({ path: note.path, content: 'draft', revision: note.revision, force: true }); assert.equal(saved.content, 'draft');
  await fs.rm(path.join(store.collection, 'a.md'));
  await assert.rejects(store.save({ path: note.path, content: 'draft2', revision: saved.revision }), { code: 'ENOENT' });
});

test('search counts literal case-insensitive occurrences, filenames, nested content, and offsets', async t => {
  const store = await new NotebookStore(await fixture(t)).init();
  await store.create({ path: 'alpha.md', content: 'Hello hello HELLO\n[a+b] a+b' });
  await store.create({ path: 'HELLO title.md', content: 'No content matches' });
  const results = await store.search('hello'); assert.equal(results.notes.length, 2); assert.equal(results.occurrences, 3);
  assert.deepEqual(results.notes.find(n => n.path === 'alpha.md').matches.map(m => m.offset), [0, 6, 12]);
  assert.equal((await store.search('a+b')).occurrences, 2);
  assert.equal((await store.search('nothing')).notes.length, 0);
  assert.equal((await store.search('')).notes.length, 0);
});

test('invalid paths, collisions, symlinks, arbitrary attachments, and non-Markdown writes are refused', async t => {
  const store = await new NotebookStore(await fixture(t)).init();
  for (const p of ['../secret.md', '/a.md', 'a/../b.md', '.hidden/a.md', 'a\\b.md', 'x.txt', 'a//b.md']) await assert.rejects(store.create({ path: p }), { status: 400 });
  await store.create({ path: 'a.md', content: 'kept' }); await assert.rejects(store.create({ path: 'a.md' }), { code: 'EEXIST' });
  await fs.symlink(os.tmpdir(), path.join(store.collection, 'outside'));
  await assert.rejects(store.create({ path: 'outside/a.md' }), { status: 400 });
  await assert.rejects(store.attachment('unknown'), { status: 404 });
  assert.equal((await store.read('a.md')).content, 'kept');
});

test('recents are unique, limited to 10, and tree ignores symlinks and includes regular files', async t => {
  const store = await new NotebookStore(await fixture(t)).init();
  for (let i = 0; i < 12; i++) { await store.create({ path: `${i}.md` }); await store.metadata({ path: `${i}.md`, recent: true }); }
  await store.metadata({ path: '4.md', recent: true }); await fs.writeFile(path.join(store.collection, 'ignore.txt'), 'no');
  const tree = await store.tree(); assert.equal(tree.notes.length, 13); assert.equal(tree.recent.length, 10); assert.equal(tree.recent[0], '4.md'); assert.equal(new Set(tree.recent).size, 10);
});

test('HTTP restricts hosts, origins, file exposure and methods; supports CRUD and errors', async t => {
  const root = await fixture(t); const { server } = await createApp(root);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (data, headers = {}) => fetch(`${base}/api/note`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
  assert.equal((await post({ path: 'note.md', content: 'Hello' })).status, 200);
  assert.equal((await post({ path: 'evil.md' }, { Origin: 'http://evil.example' })).status, 403);
  const badHost = await new Promise((resolve, reject) => { http.get(`${base}/api/tree`, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject); });
  assert.equal(badHost, 403);
  assert.equal((await fetch(`${base}/password/password`)).status, 404);
  assert.equal((await fetch(`${base}/api/note?path=..%2FREADME.md`)).status, 400);
  assert.equal((await post({ path: 'note.md' })).status, 409);
  assert.equal((await (await fetch(`${base}/api/search?q=hello`)).json()).occurrences, 1);
});
