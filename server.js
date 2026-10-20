import { FacultyStore } from './faculty.js';
import { FacultyScheduling } from './faculty-scheduling.js';
import { GroupStore } from './groups.js';
import { GroupScheduling } from './group-scheduling.js';
import { TimetableStore } from './timetables.js';
import { checkConversation } from './timetable-model.js';
import { validateCalendar } from './calendar-model.js';
import { CalendarStore } from './calendar.js';
import { DailyStore } from './daily.js';
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { describeFile, encodeText, hiddenEntry, TEXT_LIMIT, fileDigest } from './files.js';
import { workspacePath } from './workspace.js';
import { StudentStore } from './students.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TerminalService } from './terminals.js';
import { LifecycleStore, contains } from './lifecycle.js';
import { KernelService, isJupyter, parseNotebook, sourceText } from './notebooks.js';

const digest = data => createHash('sha256').update(data).digest('hex');
const fail = (status, message, extra = {}) => { throw Object.assign(new Error(message), { status, ...extra }); };
const exists = async file => { try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon' };

export class NotebookStore extends LifecycleStore {
  constructor(root) { super(); this.root = root; this.collection = path.join(root, 'collections'); this.stateDir = path.join(root, '.notebook'); this.queue = Promise.resolve(); }
  async init() {
    await fs.mkdir(this.root, { recursive:true });
    if ((await fs.lstat(this.root)).isSymbolicLink()) fail(400, 'Workspace cannot be a symlink.');
    for (const dir of [this.collection, this.stateDir]) {
      if (await exists(dir) && (await fs.lstat(dir)).isSymbolicLink()) fail(400, 'Storage cannot be a symlink.');
      await fs.mkdir(dir, { recursive: true });
    }
    let imported = {}, origins = {};
    let manifestFile = path.join(this.stateDir, 'import-manifest.json');
    if (!await exists(manifestFile)) manifestFile = path.join(this.root, 'notebook-import.json');
    if (await exists(manifestFile) && (await fs.lstat(manifestFile)).isSymbolicLink()) fail(400, 'Import manifests cannot be symlinks.');
    try { const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8')); imported = manifest.attachments || {}; origins = manifest.notebookOrigins || {}; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (await exists(path.join(this.stateDir, 'state.json')) && (await fs.lstat(path.join(this.stateDir, 'state.json'))).isSymbolicLink()) fail(400, 'Storage cannot be a symlink.');
    try { this.state = JSON.parse(await fs.readFile(path.join(this.stateDir, 'state.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; this.state = { pins: [], recent: [], attachments: imported }; await this.persist(); }
    this.state.notebookOrigins ||= {};
    for (const [key, value] of Object.entries(origins)) if (await exists(await this.resolve(key))) this.state.notebookOrigins[key] ??= value;
    await this.initLifecycle();
    return this;
  }
  serialize(fn) { const result = this.queue.then(fn); this.queue = result.catch(() => {}); return result; }
  async persist() { await this.atomic(path.join(this.stateDir, 'state.json'), JSON.stringify(this.state, null, 2)); }
  validate(relative, note = true) {
    if (typeof relative !== 'string' || !relative || relative.length > 1000 || relative.split('/').some(s => !s.trim() || s !== s.trim() || s.startsWith('.') || /[\\\x00-\x1f<>:"|?*]/.test(s)) || (note && !/\.(md|ipynb)$/i.test(relative))) fail(400, 'Use a relative path with valid names and a .md or .ipynb extension for notes.');
    return relative;
  }
  async resolve(relative, note = true, base = this.collection) {
    this.validate(relative, note);
    let current = base;
    if ((await fs.lstat(base)).isSymbolicLink()) fail(400, 'Symlinks are not allowed.');
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      if (await exists(current) && (await fs.lstat(current)).isSymbolicLink()) fail(400, 'Symlinks are not allowed.');
    }
    return current;
  }
  async workingDirectory(relative) {
    await this.read(relative);
    const original = this.state.notebookOrigins?.[relative];
    const cwd = original === '.' ? this.root : original ? path.dirname(await this.resolve(`${original}/working-check`, false, this.root)) : path.dirname(await this.resolve(relative, false));
    if (!(await fs.stat(cwd)).isDirectory()) fail(400, 'The notebook working directory is missing.');
    return cwd;
  }
  async atomic(file, content, beforeRename) {
    const tmp = path.join(path.dirname(file), `.saving-${randomUUID()}`);
    try { await fs.writeFile(tmp, content, { flag: 'wx' }); if (beforeRename) await beforeRename(); await fs.rename(tmp, file); }
    finally { await fs.rm(tmp, { force: true }); }
  }
  async tree() {
    const notes = [], folders = [];
    const visit = async (dir, prefix = '') => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (hiddenEntry(entry.name) || entry.isSymbolicLink()) continue;
        const relative = prefix + entry.name;
        if (entry.isDirectory()) { folders.push(relative); await visit(path.join(dir, entry.name), relative + '/'); }
        else if (entry.isFile()) {
          const stat = await fs.stat(path.join(dir, entry.name)); notes.push({ path: relative, modified: stat.mtimeMs, size: stat.size, type: /\.ipynb$/i.test(relative) ? 'jupyter' : /\.md$/i.test(relative) ? 'markdown' : 'file' });
        }
      }
    };
    await visit(this.collection);
    notes.sort((a, b) => a.path.localeCompare(b.path)); folders.sort((a, b) => a.localeCompare(b));
    const paths = new Set(notes.map(n => n.path));
    return { notes, folders, dailyImport: this.state.dailyImport || null, archive: await this.storedEntries('archive'), trash: await this.storedEntries('trash'), pins: this.state.pins.filter(p => paths.has(p)), recent: this.state.recent.filter(p => paths.has(p)).slice(0, 10) };
  }
  async read(relative, ref = {}) {
    if (ref.scope && ref.scope !== 'active') return this.readStored({ ...ref, path: relative || '' });
    const file = await this.resolve(relative, false);
    const handle = await fs.open(file);
    let data, stat;
    try { stat = await handle.stat(); if (stat.size > TEXT_LIMIT && !isJupyter(relative)) { data = Buffer.alloc(TEXT_LIMIT + 1); await handle.read(data, 0, data.length, 0); } else data = await handle.readFile(); } finally { await handle.close(); }
    const note = this.fileDocument(relative, data, stat, { scope: 'active' });
    if (stat.size > data.length) note.revision = await fileDigest(file);
    for (const match of note.content.matchAll(/!\[[^\]]*\]\(<?([^\s)>]+)>?/g)) {
      const href = match[1]; if (note.attachments[href] || /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) continue;
      try { const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), decodeURIComponent(href))); const resolved = await this.resolve(target, false); if ((await fs.stat(resolved)).isFile() && /\.(png|jpe?g|gif|webp|avif)$/i.test(target)) note.attachments[href] = '/api/file/raw?' + new URLSearchParams({path:target, preview:'true'}); } catch { /* Missing/out-of-workspace images remain unavailable. */ }
    }
    return note;
  }
  fileDocument(relative, data, stat, extra = {}) {
    const info = describeFile(relative, data);
    if (info.type === 'jupyter') parseNotebook(data.toString('utf8'));
    const content = info.content ?? (info.type === 'jupyter' ? data.toString('utf8') : '');
    return { path: relative, savedAt: stat.mtime.toISOString(), kind: info.type, content, viewOnly: !info.editable, size: stat.size, reason: info.reason, revision: digest(data), attachments: Object.fromEntries(Object.entries(this.state.attachments[relative] || {}).map(([href, asset]) => [href, `/api/attachments/${asset.id}`])), ...extra };
  }

  async save({ path: relative, content, revision, force = false, scope = 'active' }) {
    if (scope !== 'active') fail(403, 'Restore this notebook before editing.');
    if (typeof content !== 'string') fail(400, 'Note content must be text.');
    if (isJupyter(relative)) parseNotebook(content);
    const file = await this.resolve(relative, false);
    const check = async () => {
      const current = await this.read(relative);
      if (!force && current.revision !== revision) fail(409, 'This note changed on disk. Your draft is still here.', { revision: current.revision });
    };
    await check();
    const previous = await this.read(relative);
    if (previous.viewOnly) fail(403, 'This file cannot be edited.');
    if (!isJupyter(relative) && Buffer.byteLength(content, 'utf8') > TEXT_LIMIT) fail(413, 'Text editing is limited to 5 MB.');
    const versionDir = await this.resolve(`versions/${digest(relative)}`, false, this.stateDir);
    await fs.mkdir(versionDir, { recursive: true });
    const versionFile = await this.resolve(`versions/${digest(relative)}/${Date.now()}-${randomUUID()}.json`, false, this.stateDir);
    await fs.writeFile(versionFile, JSON.stringify({ path: relative, content: previous.content, revision: previous.revision, savedAt: previous.savedAt }), { flag: 'wx' });
    if (previous.viewOnly) fail(403, 'This file cannot be edited.');
    if (!isJupyter(relative) && Buffer.byteLength(content, 'utf8') > TEXT_LIMIT) fail(413, 'Text editing is limited to 5 MB.');
    const bytes = await fs.readFile(file);
    await this.atomic(file, isJupyter(relative) ? content : encodeText(content, bytes.toString('utf8')), check);
    // Keep the newest twenty disk versions for each notebook path.
    const versions = (await fs.readdir(versionDir)).filter(name => name.endsWith('.json')).sort().reverse();
    for (const name of versions.slice(20)) await fs.rm(await this.resolve(`versions/${digest(relative)}/${name}`, false, this.stateDir));
    return this.read(relative);
  }
  async create({ path: relative, content = '', scope = 'active' }) {
    if (scope !== 'active') fail(403, 'Create notebooks in Collections.');
    if (typeof content !== 'string') fail(400, 'Note content must be text.');
    if (isJupyter(relative)) parseNotebook(content);
    this.validate(relative);
    const file = await this.resolve(relative, false);
    await fs.writeFile(file, content, { flag: 'wx' });
    return this.read(relative);
  }
  async folder({ path: relative, scope = 'active' }) { if (scope !== 'active') fail(403, 'Stored folders are read-only.'); const file = await this.resolve(relative, false); await fs.mkdir(file); return { ok: true }; }
  async move(input) {
    const result = await this.transfer({ ...input, action: 'move' });
    return result.kind === 'note' ? this.read(result.path) : result;
  }
  async remove(input) { return this.transfer({ ...input, action: 'trash' }); }
  async metadata({ path: relative, pin, recent, scope = 'active' }) {
    if (scope !== 'active') fail(403, 'Only active notebooks can be pinned or added to Recent.');
    await this.read(relative);
    if (typeof pin === 'boolean') { this.state.pins = this.state.pins.filter(p => p !== relative); if (pin) this.state.pins.push(relative); }
    if (recent === true) this.state.recent = [relative, ...this.state.recent.filter(p => p !== relative)].slice(0, 10);
    await this.persist(); return this.tree();
  }
  async search(query) {
    const q = query.toLocaleLowerCase();
    if (!q.trim()) return { notes: [], occurrences: 0 };
    const results = []; let total = 0;
    const tree = await this.tree();
    const items = [...tree.notes.map(n => ({ ...n, scope: 'active' })), ...tree.archive.flatMap(entry => entry.notes.map(n => ({ ...n, scope: 'archive', id: entry.id, displayPath: entry.path + (n.path ? '/' + n.path : '') })))];
    for (const item of items) {
      let note; try { note = await this.read(item.path, item); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      let sources;
      try { sources = isJupyter(note.path) ? parseNotebook(note.content).cells.map((cell, index) => ({ text: sourceText(cell.source), cell: index })) : [{ text: note.content }]; }
      catch { continue; }
      const matches = []; let count = 0;
      for (const source of sources) {
        const lower = source.text.toLocaleLowerCase(); let offset = 0;
        while ((offset = lower.indexOf(q, offset)) !== -1) {
          const originalOffset = lower.length === source.text.length ? offset : [...source.text].reduce((s, char) => s.lower < offset ? { lower: s.lower + char.toLocaleLowerCase().length, original: s.original + char.length } : s, { lower: 0, original: 0 }).original;
          const start = Math.max(0, originalOffset - 45), end = Math.min(source.text.length, originalOffset + query.length + 80);
          if (matches.length < 12) matches.push({ offset: originalOffset, length: query.length, snippet: source.text.slice(start, end), highlight: originalOffset - start, ...(source.cell !== undefined ? { cell: source.cell } : {}) });
          count++; offset += q.length;
        }
      }
      if (count || note.path.toLocaleLowerCase().includes(q)) results.push({ path: note.path, scope: item.scope, ...(item.id ? { id: item.id, storedPath: item.path } : {}), count, matches });
      total += count;
    }
    return { notes: results, occurrences: total };
  }
  async indexRelativeImages(location, info) {
    if (location.scope !== 'active') return;
    for (const item of info.notes) {
      const relative = info.kind === 'folder' ? location.path + '/' + item.path : location.path;
      if (!/\.(md|ipynb)$/i.test(relative)) continue;
      const note = await this.read(relative);
      for (const [href, url] of Object.entries(note.attachments)) if (url.startsWith('/api/file/raw?')) {
        const target = new URLSearchParams(url.split('?')[1]).get('path');
        this.state.attachments[relative] ||= {};
        this.state.attachments[relative][href] = { id: digest('collections/' + target).slice(0,24), path:'collections/' + target };
      }
    }
  }
  async attachment(id) {
    const item = [this.state.attachments, ...Object.values(this.state.stored || {}).map(r => r.attachments)].flatMap(map => Object.values(map || {}).flatMap(value => Object.values(value))).find(asset => asset.id === id);
    if (!item || !/\.(png|jpe?g|gif|webp|avif)$/i.test(item.path)) fail(404, 'Image not found.');
    return item.path.startsWith('.notebook/') ? this.safeStorage(item.path) : this.resolve(item.path, false, this.root);
  }
}

async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 25 * 1024 * 1024) fail(413, 'Note is too large (25 MB maximum).'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { fail(400, 'Invalid JSON.'); }
}
export async function createApp(root, { now = Date.now, appRoot = path.dirname(fileURLToPath(import.meta.url)) } = {}) {
  const store = await new NotebookStore(root).init();
  const students = await new StudentStore(store).init();
  const faculty = await new FacultyStore(store).init();
  const groups = await new GroupStore(store, students).init();
  const daily = await new DailyStore(store).init();
  const calendar = await new CalendarStore(store).init();
  daily.calendar = calendar; daily.groups = groups; daily.faculty = faculty;
  const timetables = await new TimetableStore(store).init(); students.timetables = timetables;
  const conversationCheck = async (event, draftEvents = [], proposed = false) => {
    validateCalendar({ schemaVersion: 1, id: randomUUID(), events: [event] });
    if (!event.studentId) fail(400, 'Choose a student.');
    let student; try { student = await students.read(event.studentId); } catch (e) { if (e.code === 'ENOENT') fail(400, 'Conversation student unavailable.'); throw e; }
    const academic = await timetables.read(), current = await calendar.read();
    const savedIds = new Set(current.document.events.map(e => e.id));
    const events = proposed ? draftEvents : [...current.document.events, ...draftEvents.filter(e => !savedIds.has(e.id))];
    const result = checkConversation(event, student.document, academic.document, events, now());
    return { ...result, acknowledgement: digest(JSON.stringify([event, student.revision, academic.revision, current.revision, result.conflicts])) };
  };
  const facultyScheduling = new FacultyScheduling({ faculty, calendar, now });
  const groupScheduling = new GroupScheduling({ groups, students, calendar, timetables, now });
  const kernels = new KernelService(store), terminals = new TerminalService(store);
  store.beforeTransfer = async (input, location) => {
    if (location.scope !== 'active') return;
    const affectedKernels = [...kernels.sessions.values()].filter(session => contains(location.path, session.path));
    if ([...kernels.startingPaths].some(p => contains(location.path, p)) || affectedKernels.some(s => !s.ready || s.busy)) fail(409, 'An affected kernel is starting or busy. Stop or interrupt it first.');
    const affectedTerminals = await terminals.affected(location);
    if (affectedTerminals.length && input.stopTerminals !== true) fail(409, 'Close affected terminals before moving this item.', { code: 'TERMINALS_ACTIVE', terminals: affectedTerminals.map(s => ({ id: s.id, path: s.path })) });
    for (const session of affectedTerminals) await terminals.stop(session.id);
    for (const session of affectedKernels) kernels.stop(session.id);
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: http: data:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('Cache-Control', 'no-store');
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      const port = server.address()?.port;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) fail(403, 'Invalid host.');
      const url = new URL(req.url, `http://${req.headers.host}`), route = url.pathname;
      if (!['GET', 'HEAD'].includes(req.method)) {
        if (req.headers.origin !== `http://${req.headers.host}`) fail(403, 'Requests must originate from this app.');
        if (!/^\/api\/groups\/[a-f\d-]+\/attachments$/.test(route) && !(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'JSON required.');
      }
      if (req.method === 'GET' && route === '/api/faculty/export') return json(200, await store.serialize(() => faculty.export()));
      if (req.method === 'GET' && route === '/api/faculty') return json(200, await store.serialize(() => faculty.list()));
      if (req.method === 'POST' && route === '/api/faculty') { const input = await body(req); return json(201, await store.serialize(() => faculty.create(input))); }
      const facultyRoute = route.match(/^\/api\/faculty\/([^/]+)(?:\/(check))?$/);
      if (facultyRoute) {
        const [, id, action] = facultyRoute;
        if (!action && req.method === 'GET') return json(200, await store.serialize(() => faculty.read(id)));
        if (!action && req.method === 'PUT') { const input = await body(req); return json(200, await store.serialize(() => faculty.save(id, input))); }
        if (action === 'check' && req.method === 'POST') { const input = await body(req); return json(200, await store.serialize(() => facultyScheduling.check(id, input?.event, input?.draftEvents))); }
      }
      if (req.method === 'GET' && route === '/api/groups/export') return json(200, await store.serialize(() => groups.export()));
      if (req.method === 'GET' && route === '/api/groups') return json(200, await store.serialize(() => groups.list()));
      if (req.method === 'POST' && route === '/api/groups') { const input = await body(req); return json(201, await store.serialize(() => groups.create(input))); }
      const groupRoute = route.match(/^\/api\/groups\/([^/]+)(?:\/(check|attachments)(?:\/([^/]+))?)?$/);
      if (groupRoute) {
        const [, id, action, attachmentId] = groupRoute;
        if (action === 'check' && req.method === 'POST') { const input = await body(req); return json(200, await store.serialize(() => groupScheduling.check(id, input.event, input.draftEvents))); }
        if (action === 'attachments' && !attachmentId && req.method === 'POST') return json(201, await groups.upload(id, req, url.searchParams.get('name')));
        if (action === 'attachments' && attachmentId && ['GET', 'HEAD'].includes(req.method)) {
          await groups.read(id); const attachment = await groups.attachment(id, attachmentId);
          const preview = url.searchParams.get('preview') === 'true' && /\.pdf$/i.test(attachment.name);
          res.writeHead(200, { 'Content-Type': preview ? 'application/pdf' : 'application/octet-stream', 'Content-Length': attachment.size, 'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}` });
          if (req.method === 'HEAD') res.end(); else await pipeline(createReadStream(attachment.file), res); return;
        }
        if (!action && req.method === 'GET') return json(200, await store.serialize(() => groups.read(id)));
        if (!action && req.method === 'PUT') { const input = await body(req); return json(200, await store.serialize(async () => {
          const current = await calendar.read();
          if (current.document.events.some(e => e.groupId === id && !input.document?.sessions?.some(s => s.id === e.groupSessionId))) fail(400, 'Cancel the Calendar booking before removing its group session.');
          return groups.save(id, input);
        })); }
      }
      if (req.method === 'GET' && route === '/api/timetables') return json(200, await store.serialize(() => timetables.read()));
      if (req.method === 'GET' && route === '/api/timetables/export') return json(200, await store.serialize(() => timetables.export()));
      if (req.method === 'PUT' && route === '/api/timetables') { const input = await body(req); return json(200, await store.serialize(() => timetables.save(input))); }
      if (req.method === 'POST' && route === '/api/timetables/check') { const input = await body(req); return json(200, await store.serialize(() => {
        if (input.draftEvents !== undefined) validateCalendar({ schemaVersion: 1, id: randomUUID(), events: input.draftEvents });
        return conversationCheck(input.event, input.draftEvents);
      })); }
      if (req.method === 'GET' && route === '/api/calendar') return json(200, await store.serialize(() => calendar.read()));
      if (req.method === 'PUT' && route === '/api/calendar') { const input = await body(req); return json(200, await store.serialize(async () => {
        validateCalendar(input.document); const current = await calendar.read();
        for (const event of input.document.events.filter(e => e.groupId)) {
          if (JSON.stringify(current.document.events.find(e => e.id === event.id)) === JSON.stringify(event)) continue;
          const checked = await groupScheduling.check(event.groupId, event, input.document.events, true);
          if (checked.conflicts.length && input.acknowledgements?.[event.id] !== checked.acknowledgement) fail(409, 'Group availability changed or needs confirmation. Review participant conflicts and confirm this booking.');
        }
        for (const previous of current.document.events.filter(e => e.groupId)) {
          const next = input.document.events.find(e => e.id === previous.id);
          if (next && (next.groupId !== previous.groupId || next.groupSessionId !== previous.groupSessionId)) fail(400, 'A group booking cannot be detached from its session.');
        }
        for (const previous of current.document.events.filter(e => e.facultyId)) {
          const next = input.document.events.find(e => e.id === previous.id);
          if (next && next.facultyId !== previous.facultyId) fail(400, 'A Faculty booking cannot be detached from its member.');
        }
        for (const event of input.document.events.filter(e => e.facultyId)) {
          if (JSON.stringify(current.document.events.find(e => e.id === event.id)) === JSON.stringify(event)) continue;
          const checked = await facultyScheduling.check(event.facultyId, event, input.document.events, true);
          if (checked.conflicts.length && input.acknowledgements?.[event.id] !== checked.acknowledgement) fail(409, 'Faculty availability changed or needs confirmation. Review your Calendar conflicts and confirm this booking.');
        }
        for (const event of input.document.events.filter(e => e.studentId)) {
          if (JSON.stringify(current.document.events.find(e => e.id === event.id)) === JSON.stringify(event)) continue;
          const checked = await conversationCheck(event, input.document.events, true);
          if (checked.conflicts.length && input.acknowledgements?.[event.id] !== checked.acknowledgement) fail(409, 'Schedule conflict changed or needs confirmation. Review the timetable and confirm this booking.');
        }
        const saved = await calendar.save(input);
        await daily.read();
        return saved;
      })); }
      if (req.method === 'GET' && route === '/api/calendar/export') return json(200, await store.serialize(() => calendar.export()));
      if (req.method === 'GET' && route === '/api/daily') return json(200, await store.serialize(() => daily.read()));
      if (req.method === 'PUT' && route === '/api/daily') { const input = await body(req); return json(200, await store.serialize(() => daily.save(input))); }
      if (req.method === 'GET' && route === '/api/daily/export') return json(200, await store.serialize(() => daily.export(url.searchParams.get('format'))));
      if (req.method === 'GET' && route === '/api/daily/import-preview') return json(200, await store.serialize(() => daily.preview(Object.fromEntries(url.searchParams))));
      if (req.method === 'POST' && route === '/api/daily/import-apply') { const input = await body(req); return json(200, await store.serialize(() => daily.apply(input))); }
      if (req.method === 'GET' && route === '/api/students/export') { res.setHeader('Content-Disposition', 'attachment; filename="workbench-students.json"'); return json(200, await store.serialize(() => students.export())); }
      if (req.method === 'GET' && route === '/api/students') return json(200, await store.serialize(() => students.list()));
      if (req.method === 'POST' && route === '/api/students') { const input = await body(req); return json(201, await store.serialize(() => students.create(input))); }
      if (route.startsWith('/api/students/')) {
        const id = route.slice('/api/students/'.length);
        if (req.method === 'GET') return json(200, await store.serialize(() => students.read(id)));
        if (req.method === 'PUT') { const input = await body(req); return json(200, await store.serialize(() => students.save(id, input))); }
      }
      if (['GET', 'HEAD'].includes(req.method) && route === '/api/file/raw') {
        const ref = Object.fromEntries(url.searchParams); const location = await store.locate(ref); const stat = await fs.stat(location.file);
        if (!stat.isFile()) fail(400, 'Choose a file.');
        const extension = path.extname(location.displayPath).toLowerCase();
        const types = { '.pdf': 'application/pdf', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.avif':'image/avif' };
        const inline = ref.preview === 'true' && types[extension];
        res.writeHead(200, { 'Content-Type': inline || 'application/octet-stream', 'Content-Length': stat.size, 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(location.displayPath))}` });
        if (req.method === 'HEAD') res.end(); else await pipeline(createReadStream(location.file), res); return;
      }
      if (req.method === 'GET' && route === '/api/file') return json(200, await store.read(url.searchParams.get('path'), Object.fromEntries(url.searchParams)));
      if (req.method === 'PUT' && route === '/api/file') { const input = await body(req); return json(200, await store.serialize(() => store.save(input))); }
      if (req.method === 'GET' && route === '/api/tree') return json(200, await store.tree());
      if (req.method === 'GET' && route === '/api/note') return json(200, await store.read(url.searchParams.get('path'), { scope: url.searchParams.get('scope') || 'active', id: url.searchParams.get('id') }));
      if (req.method === 'GET' && route === '/api/item') return json(200, await store.item({ scope: url.searchParams.get('scope') || 'active', id: url.searchParams.get('id'), path: url.searchParams.get('path') || '' }));
      if (req.method === 'GET' && route === '/api/search') {
        const query = url.searchParams.get('q') || '';
        const [notebooks, dailyResults, studentResults, groupResults, facultyResults] = await Promise.all([store.search(query), store.serialize(() => daily.search(query)), store.serialize(() => students.search(query)), store.serialize(() => groups.search(query)), store.serialize(() => faculty.search(query))]);
        return json(200, { ...notebooks, daily: dailyResults, students: studentResults, groups: groupResults, faculty: facultyResults, occurrences: notebooks.occurrences + [...dailyResults, ...studentResults, ...groupResults, ...facultyResults].reduce((sum, item) => sum + item.count, 0) });
      }
      if (req.method === 'GET' && route === '/api/terminals') return json(200, { sessions: terminals.list() });
      if (req.method === 'POST' && route === '/api/terminal') { const input = await body(req); return json(200, await store.serialize(() => terminals.start(input))); }
      if (req.method === 'DELETE' && /^\/api\/terminal\/[a-f\d-]+$/.test(route)) return json(200, await store.serialize(() => terminals.stop(route.split('/').at(-1))));
      if (req.method === 'GET' && route === '/api/environments') return json(200, { environments: await kernels.discover(url.searchParams.get('refresh') === 'true'), sessions: kernels.sessionList() });
      if (req.method === 'POST' && route.startsWith('/api/kernel/')) {
        const input = await body(req);
        if (input.scope && input.scope !== 'active') fail(403, 'Restore this notebook before executing it.');
        if (route === '/api/kernel/start') return json(200, await kernels.start(input));
        if (route === '/api/kernel/execute') return json(200, await kernels.execute(input));
        if (route === '/api/kernel/interrupt') return json(200, await kernels.request(input.session, 'interrupt'));
        if (route === '/api/kernel/stop') return json(200, kernels.stop(input.session));
        fail(404, 'Kernel action not found.');
      }
      const mutations = { 'PUT /api/note': 'save', 'POST /api/note': 'create', 'POST /api/folder': 'folder', 'POST /api/move': 'move', 'DELETE /api/note': 'remove', 'POST /api/metadata': 'metadata', 'POST /api/item': 'transfer', 'POST /api/trash/empty': 'emptyTrash' };
      const action = mutations[`${req.method} ${route}`];
      if (action) {
        const input = await body(req); if (!input || typeof input !== 'object') fail(400, 'Invalid request.');
        const result = await store.serialize(async () => {
          return store[action](input);
        });
        return json(200, result);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'Method not allowed.');
      let file;
      if (route.startsWith('/api/attachments/')) file = await store.attachment(route.slice('/api/attachments/'.length));
      else if (route.startsWith('/api/')) fail(404, 'Endpoint not found.');
      else {
        const relative = decodeURIComponent(route === '/' ? '/index.html' : route);
        const dist = path.join(appRoot, 'dist'); file = path.resolve(dist, '.' + relative);
        if (!file.startsWith(dist + path.sep)) fail(403, 'Invalid path.');
      }
      const data = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }); res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      const status = error.status || ({ ENOENT: 404, EEXIST: 409, ENOTDIR: 400, EISDIR: 400, EACCES: 403 })[error.code] || 500;
      json(status, { error: status === 500 ? 'Operation failed. Your draft is preserved; check the server and try again.' : error.message, revision: error.revision, code: error.code, terminals: error.terminals });
      if (status === 500) console.error(error);
    }
  });
  terminals.attach(server);
  server.on('close', () => { kernels.close(); terminals.close(); });
  return { server, store, students, groups, faculty, daily, calendar, timetables, kernels, terminals };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, kernels, terminals } = await createApp(workspacePath());
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await Promise.all([kernels.close(), terminals.close()]); server.close(() => process.exit(0)); });
  server.listen(Number(process.env.PORT || 3210), '127.0.0.1', () => console.log(`Workbench is ready at http://127.0.0.1:${server.address().port}`));
}
