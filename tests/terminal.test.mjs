import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import { createApp } from '../server.js';
import { newNotebook } from '../notebooks.js';
async function fixture(t) {
  const shell = process.env.SHELL; process.env.SHELL = '/bin/sh'; t.after(() => { if(shell === undefined) delete process.env.SHELL; else process.env.SHELL = shell; });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldnotes-terminal-'));
  const app = await createApp(root); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.terminals.close(); await app.kernels.close(); await new Promise(resolve => app.server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const request = (route, data, method = 'POST', origin = base) => fetch(base + route, { method, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  return { root, base, request, ...app };
}
async function connect(base, id, origin = base) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + `/api/terminal/${id}`, { origin }); const events = [];
  ws.on('message', value => events.push(JSON.parse(value.toString())));
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await until(() => events.some(e => (e.data || '').trim()));
  ws.send(JSON.stringify({type:'input', data:"case \"$BASH_VERSION\" in ?*) set +H ;; esac; printf 'SHELL_READY\\n'\r"}));
  await until(() => events.map(e=>e.data || '').join('').includes('SHELL_READY\r\n'));
  return { ws, events, write: data => ws.send(JSON.stringify({ type: 'input', data })), output: () => events.map(e => e.data || '').join('') };
}
async function until(check) { const until = Date.now() + 6000; while (!check()) { if (Date.now() > until) throw new Error('Terminal condition timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } }

test('real PTY input, ANSI output, resize, interruption and reconnect preserve per-note shell state', async t => {
  const { store, terminals, base, request } = await fixture(t); await store.create({ path: 'first.md' }); await store.create({ path: 'second.md' });
  const session = await (await request('/api/terminal', { path: 'first.md' })).json(); assert.ok(session.id); assert.equal(session.cwd, store.collection);
  assert.equal((await terminals.start({ path: 'first.md' })).id, session.id);
  const first = await connect(base, session.id); t.after(() => first.ws.terminate());
  first.ws.send(JSON.stringify({ type: 'resize', cols: 99, rows: 17 })); first.write("export NOTEBOOK_VALUE=42; printf '\\033[32mANSI_OK\\033[0m'; stty size; printf 'VALUE=%s\\n' \"$NOTEBOOK_VALUE\"\r");
  await until(() => first.output().includes('VALUE=42') && first.output().includes('17 99')); assert.ok(first.output().includes('\x1b[32m'));
  first.write('sleep 30\r'); await new Promise(resolve => setTimeout(resolve, 100)); first.write('\x03'); await new Promise(resolve => setTimeout(resolve, 200)); first.write("printf 'INTERRUPTED_OK\\n'\r"); await until(() => first.output().includes('INTERRUPTED_OK\r\n'));
  first.ws.close(); const again = await connect(base, session.id); t.after(() => again.ws.terminate()); await until(() => again.events.some(e => e.type === 'replay'));
  again.write("printf 'RECONNECTED_%s\\n' \"$NOTEBOOK_VALUE\"\r"); await until(() => again.output().includes('RECONNECTED_42'));
  const second = await terminals.start({ path: 'second.md' }); assert.notEqual(second.id, session.id); const other = await connect(base, second.id); t.after(() => other.ws.terminate());
  other.write("printf 'ISOLATED_%s\\n' \"${NOTEBOOK_VALUE-unset}\"\r"); await until(() => other.output().includes('ISOLATED_unset'));
  again.write('exit\r'); await until(() => !terminals.sessions.get(session.id).alive); const replacement = await terminals.start({ path: 'first.md' }); assert.notEqual(replacement.id, session.id);
});

test('terminal APIs restrict origins, paths, dimensions and stored notebooks; mapped working directories are preserved', async t => {
  const { store, request, terminals, base, root } = await fixture(t); await store.create({ path: 'a.md' });
  assert.equal((await request('/api/terminal', { path: 'a.md' }, 'POST', 'https://other.test')).status, 403);
  for (const input of [{ path: '../a.md' }, { path: 'a.md', rows: 0 }, { path: 'a.md', scope: 'archive' }, { path: 'a.md', scope: 'trash' }]) assert.ok((await request('/api/terminal', input)).status >= 400);
  await store.create({ path: 'a.ipynb', content: JSON.stringify(newNotebook()) }); await fs.mkdir(path.join(root, 'helpers')); store.state.notebookOrigins['a.ipynb'] = 'helpers';
  const notebook = await terminals.start({ path: 'a.ipynb' }); assert.equal(notebook.cwd, path.join(root, 'helpers'));
  await assert.rejects(connect(base, notebook.id, 'https://other.test'));
  await fs.symlink(os.tmpdir(), path.join(store.collection, 'escape')); await assert.rejects(terminals.start({ path: 'escape/a.md' }), { status: 400 });
  store.state.notebookOrigins['a.ipynb'] = '../escape'; await assert.rejects(terminals.start({ path: 'a.ipynb' }), { status: 400 });
});

test('lifecycle preflight protects live terminals on collisions and conflicts; explicit closure allows the move', async t => {
  const { store, request, terminals } = await fixture(t); await store.folder({ path: 'folder' }); await store.create({ path: 'folder/a.md', content: 'original' }); await store.create({ path: 'occupied.md' });
  const session = await terminals.start({ path: 'folder/a.md' }), info = await store.item({ path: 'folder/a.md' });
  const transfer = data => request('/api/item', { path: 'folder/a.md', scope: 'active', action: 'move', revision: info.revision, ...data });
  assert.equal((await transfer({ destination: 'occupied.md', stopTerminals: true })).status, 409); assert.equal(terminals.sessions.get(session.id).alive, true);
  const blocked = await transfer({ destination: 'renamed.md' }); assert.equal(blocked.status, 409); assert.equal((await blocked.json()).code, 'TERMINALS_ACTIVE');
  await fs.writeFile(path.join(store.collection, 'folder/a.md'), 'external'); assert.equal((await transfer({ destination: 'renamed.md', stopTerminals: true })).status, 409); assert.equal(terminals.sessions.get(session.id).alive, true);
  await fs.writeFile(path.join(store.collection, 'folder/a.md'), 'original'); assert.equal((await transfer({ destination: 'renamed.md', stopTerminals: true })).status, 200); assert.equal(terminals.sessions.has(session.id), false);
  assert.equal((await store.read('renamed.md')).content, 'original');
});

test('terminal output is bounded, eight-session limit is explicit, and closing sessions terminates background children', async t => {
  const { store, terminals, base } = await fixture(t);
  for (let i = 0; i < 9; i++) await store.create({ path: `${i}.md` });
  const sessions = []; for (let i = 0; i < 8; i++) sessions.push(await terminals.start({ path: `${i}.md` }));
  await assert.rejects(terminals.start({ path: '8.md' }), { status: 409 }); assert.equal(terminals.list().filter(s => s.alive).length, 8);
  const io = await connect(base, sessions[0].id); t.after(() => io.ws.terminate());
  io.write("sleep 60 & printf 'CHILD_PID_%s\\n' $!; head -c 300000 /dev/zero | tr '\\0' 'x'; printf '\\nOUTPUT_DONE\\n'\r");
  await until(() => io.output().includes('OUTPUT_DONE\r\n')).catch(e => { throw new Error(e.message + JSON.stringify(io.output().slice(-500))); }); const pid = Number(/CHILD_PID_(\d+)/.exec(io.output())[1]); assert.ok(pid > 0);
  assert.ok(terminals.sessions.get(sessions[0].id).output.length <= 262144);
  await terminals.stop(sessions[0].id); await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  await terminals.close(); assert.equal(terminals.list().length, 0);
});

test('folder operations detect a terminal that changed working directory; startup errors leave no session', async t => {
  const { store, terminals, base, request } = await fixture(t);
  await store.create({ path: 'outside.md' }); await store.folder({ path: 'nested space' });
  const session = await terminals.start({ path: 'outside.md' }); const io = await connect(base, session.id); t.after(() => io.ws.terminate());
  io.write("cd 'nested space'; printf 'DIRECTORY_READY\\n'\r"); await until(() => io.output().includes('DIRECTORY_READY\r\n'));
  assert.equal(await terminals.currentDirectory(terminals.sessions.get(session.id)), await fs.realpath(path.join(store.collection, 'nested space')));
  const info = await store.item({ path: 'nested space' });
  const input = { path: 'nested space', scope: 'active', action: 'move', destination: 'moved', revision: info.revision };
  const blocked = await request('/api/item', input); assert.equal(blocked.status, 409); assert.equal((await blocked.json()).code, 'TERMINALS_ACTIVE');
  assert.equal(terminals.sessions.get(session.id).alive, true);
  assert.equal((await request('/api/item', { ...input, stopTerminals: true })).status, 200); assert.equal(terminals.list().length, 0);
  const shell = process.env.SHELL; process.env.SHELL = '/missing/notebook-shell';
  try { const failed = await request('/api/terminal', { path: 'outside.md' }); assert.equal(failed.status, 503); assert.match((await failed.json()).error, /shell is unavailable/); assert.equal(terminals.list().length, 0); }
  finally { if (shell === undefined) delete process.env.SHELL; else process.env.SHELL = shell; }
});
