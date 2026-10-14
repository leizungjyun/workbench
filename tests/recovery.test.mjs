import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NotebookStore } from '../server.js';
import { comparisonText } from '../app/notebook-tabs.js';

test('saves preserve previous disk content, including an explicit external overwrite', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notebook-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new NotebookStore(root).init();
  const note = await store.create({ path: 'a.md', content: 'original' });
  await fs.writeFile(path.join(root, 'collections/a.md'), 'external');
  await assert.rejects(store.save({ path: 'a.md', content: 'draft', revision: note.revision }), { status: 409 });
  await store.save({ path: 'a.md', content: 'draft', revision: note.revision, force: true });
  const dir = path.join(root, '.notebook/versions', createHash('sha256').update('a.md').digest('hex'));
  const saved = JSON.parse(await fs.readFile(path.join(dir, (await fs.readdir(dir))[0]), 'utf8'));
  assert.equal(saved.path, 'a.md'); assert.equal(saved.content, 'external');
  for (let i = 0; i < 22; i++) { const latest = await store.read('a.md'); await store.save({ path: 'a.md', content: String(i), revision: latest.revision }); }
  assert.equal((await fs.readdir(dir)).length, 20);
});

test('Jupyter comparison shows cell sources and outputs', () => {
  const result = comparisonText(JSON.stringify({ cells: [{ cell_type: 'code', source: ['print(1)'], outputs: [{ text: '1' }] }] }), 'a.ipynb');
  assert.match(result, /Cell 1 · code\nprint\(1\)/); assert.match(result, /Outputs:/);
});
