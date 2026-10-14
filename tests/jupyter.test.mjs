import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NotebookStore } from '../server.js';
import { KernelService, newNotebook, parseNotebook } from '../notebooks.js';
import { migrate, hash } from '../scripts/migrate.mjs';
async function fixture(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldnotes-jupyter-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }

test('Jupyter migration preserves attachments, outputs and metadata byte-for-byte; helpers stay in place', async t => {
  const root = await fixture(t); await fs.mkdir(path.join(root, 'physics'));
  const notebook = newNotebook(); notebook.metadata.custom = { keep: true }; notebook.cells.push({ cell_type: 'markdown', metadata: {}, source: ['![plot](attachment:plot.png)'], attachments: { 'plot.png': { 'image/png': 'aGVsbG8=' } } });
  notebook.cells[0].outputs.push({ output_type: 'stream', name: 'stdout', text: ['prior output'] });
  const content = JSON.stringify(notebook, null, 2);
  await fs.writeFile(path.join(root, 'physics/example.ipynb'), content); await fs.writeFile(path.join(root, 'physics/helper.py'), 'value = 42');
  assert.equal((await migrate(root)).moved, 1);
  assert.equal(hash(await fs.readFile(path.join(root, 'collections/physics/example.ipynb'))), hash(content));
  assert.equal(await fs.readFile(path.join(root, 'physics/helper.py'), 'utf8'), 'value = 42');
  assert.equal((await migrate(root)).moved, 0);
  const store = await new NotebookStore(root).init(); assert.equal(store.state.notebookOrigins['physics/example.ipynb'], 'physics');
  const note = await store.read('physics/example.ipynb'); assert.equal(note.kind, 'jupyter');
  assert.equal((await store.tree()).notes.length, 1);
  await store.move({ path: note.path, destination: 'moved.ipynb', revision: note.revision }); assert.equal(store.state.notebookOrigins['moved.ipynb'], 'physics');
});

test('Jupyter validation, search cell offsets, metadata round-trip and extension protection', async t => {
  const store = await new NotebookStore(await fixture(t)).init(); const notebook = newNotebook();
  notebook.cells[0].source = ['value = "needle"\n', 'print(value)']; notebook.cells[0].outputs = [{ output_type: 'stream', name: 'stdout', text: 'needle output should not be searched' }];
  notebook.cells.push({ cell_type: 'markdown', metadata: {}, source: 'Needle text' });
  const note = await store.create({ path: 'a.ipynb', content: JSON.stringify(notebook) });
  const result = await store.search('needle'); assert.equal(result.occurrences, 2); assert.deepEqual(result.notes[0].matches.map(m => m.cell), [0, 1]);
  await assert.rejects(store.save({ path: note.path, content: '{bad', revision: note.revision }), { status: 400 });
  assert.equal((await store.read(note.path)).revision, note.revision);
  await assert.rejects(store.move({ path: note.path, destination: 'a.md', revision: note.revision }), { status: 400 });
  notebook.cells[1].source = 'Updated'; const saved = await store.save({ path: note.path, content: JSON.stringify(notebook), revision: note.revision });
  assert.deepEqual(parseNotebook(saved.content).cells[0].outputs, notebook.cells[0].outputs);
});

test('real discovered environment executes a persistent kernel, returns errors and interrupts safely', { timeout: 90000 }, async t => {
  const store = await new NotebookStore(await fixture(t)).init(); const kernels = new KernelService(store); t.after(() => kernels.close());
  if (!process.env.WORKBENCH_TEST_PYTHON) return t.skip('Set WORKBENCH_TEST_PYTHON for Python execution checks.');
  const environments = await kernels.discover(); const env = environments.find(e => e.kind === 'Configured' && e.available) || environments.find(e => e.available);
  if (!env) return t.skip('No local environment with ipykernel and jupyter_client.');
  await store.create({ path: 'run.ipynb', content: JSON.stringify(newNotebook()) });
  await assert.rejects(kernels.start({ path: 'run.ipynb', environment: '/arbitrary/python' }), { status: 400 });
  const session = await kernels.start({ path: 'run.ipynb', environment: env.id });
  await kernels.execute({ session: session.id, code: 'answer = 40' });
  const result = await kernels.execute({ session: session.id, code: 'print("hello")\nanswer + 2' });
  assert.equal(result.execution_count, 2); assert.ok(result.outputs.some(o => o.data?.['text/plain'] === '42')); assert.ok(result.outputs.some(o => o.text === 'hello\n'));
  const failure = await kernels.execute({ session: session.id, code: '1 / 0' }); assert.equal(failure.outputs.at(-1).ename, 'ZeroDivisionError');
  const executing = kernels.execute({ session: session.id, code: 'import time\ntime.sleep(30)' });
  await new Promise(resolve => setTimeout(resolve, 500)); await kernels.request(session.id, 'interrupt');
  assert.ok((await executing).outputs.some(o => o.ename === 'KeyboardInterrupt'));
  await kernels.close(); assert.equal(kernels.sessions.size, 0);
});
