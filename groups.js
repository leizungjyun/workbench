import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { newGroup, validateGroup, groupSummary, groupSearchFields } from './group-model.js';
import { uuidPattern } from './student-model.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const attachmentLimit = 100 * 1024 * 1024;
export class GroupStore {
  constructor(notebooks, students) { this.notebooks = notebooks; this.students = students; }
  checkId(id) { if (typeof id !== 'string' || !uuidPattern.test(id)) fail(400, 'Invalid group or attachment ID.'); }
  async safe(...parts) {
    let file = this.notebooks.stateDir;
    for (const part of ['', ...parts]) {
      file = path.join(file, part);
      try { if ((await fs.lstat(file)).isSymbolicLink()) fail(400, 'Group storage cannot contain symlinks.'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return file;
  }
  async init() { for (const dir of ['groups', 'group-versions', 'group-attachments']) await fs.mkdir(await this.safe(dir), { recursive: true }); return this; }
  async read(id) {
    this.checkId(id); const handle = await fs.open(await this.safe('groups', `${id}.json`)); let bytes, stat;
    try { bytes = await handle.readFile(); stat = await handle.stat(); } finally { await handle.close(); }
    let document; try { document = JSON.parse(bytes); } catch { fail(400, 'Group data is invalid JSON; the file has been preserved.'); }
    validateGroup(document); if (document.id !== id) fail(400, 'Group file ID does not match.');
    return { document, revision: hash(bytes), savedAt: stat.mtime.toISOString() };
  }
  async all() { return Promise.all((await fs.readdir(await this.safe('groups'))).filter(n => n.endsWith('.json') && uuidPattern.test(n.slice(0, -5))).sort().map(n => this.read(n.slice(0, -5)))); }
  async list() { return { groups: (await this.all()).map(({ document }) => groupSummary(document)).sort((a,b) => a.name.localeCompare(b.name)) }; }
  async validateReferences(document) {
    const studentIds = new Set([...document.memberIds, ...document.sessions.flatMap(s => [...s.participantIds, ...s.actions.flatMap(a => a.assigneeIds)])]);
    for (const id of studentIds) { try { await this.students.read(id); } catch (e) { if (e.code === 'ENOENT') fail(400, 'A referenced student is unavailable.'); throw e; } }
    for (const s of document.sessions) for (const a of s.attachments) {
      const stored = await this.attachment(document.id, a.id);
      if (stored.name !== a.name || stored.size !== a.size) fail(400, 'Presentation metadata does not match the uploaded file.');
    }
  }
  async create(input) {
    const d = newGroup(randomUUID(), typeof input?.name === 'string' ? input.name.trim() : '', input?.memberIds, input?.leaderId);
    validateGroup(d); await this.validateReferences(d);
    await fs.writeFile(await this.safe('groups', `${d.id}.json`), JSON.stringify(d, null, 2), { flag: 'wx', mode: 0o600 }); return this.read(d.id);
  }
  async save(id, input) {
    this.checkId(id); if (!input || typeof input.revision !== 'string') fail(400, 'A Group revision is required.');
    const d = validateGroup(input.document); if (d.id !== id) fail(400, 'Group identity cannot change.');
    const previous = await this.read(id); if (previous.revision !== input.revision) fail(409, 'This group changed on disk. Your draft is preserved.');
    await this.validateReferences(d);
    const versions = await this.safe('group-versions', id); await fs.mkdir(versions, { recursive: true });
    await fs.writeFile(await this.safe('group-versions', id, `${Date.now()}-${randomUUID()}.json`), JSON.stringify(previous, null, 2), { flag: 'wx', mode: 0o600 });
    await this.notebooks.atomic(await this.safe('groups', `${id}.json`), JSON.stringify(d, null, 2), async () => { if ((await this.read(id)).revision !== input.revision) fail(409, 'This group changed on disk. Your draft is preserved.'); });
    const names = (await fs.readdir(versions)).filter(n => /^\d+-[a-f\d-]+\.json$/.test(n)).sort().reverse(); for (const n of names.slice(20)) await fs.rm(await this.safe('group-versions', id, n));
    return this.read(id);
  }
  async export() { return { schemaVersion: 1, exportedAt: new Date().toISOString(), groups: (await this.all()).map(r => r.document) }; }
  async search(query) {
    if (!query.trim()) return []; const q = query.toLocaleLowerCase(), results = [];
    for (const { document: d } of await this.all()) {
      let count = 0; const matches = [];
      for (const { values, ...target } of groupSearchFields(d)) for (const value of values) {
        // Match on original string boundaries so Unicode case changes cannot corrupt highlights.
        const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'); let match;
        while ((match = expression.exec(value))) { const start = Math.max(0, match.index - 45); count++; if (matches.length < 12) matches.push({ ...target, snippet: value.slice(start, match.index + match[0].length + 80), highlight: match.index - start, length: match[0].length }); }
      }
      if (count || d.name.toLocaleLowerCase().includes(q)) results.push({ type: 'group', id: d.id, name: d.name, archived: d.archived, count, matches });
    }
    return results;
  }
  async upload(groupId, request, name) {
    await this.read(groupId);
    if (typeof name !== 'string' || !name.trim() || name.length > 255 || /[\/\\\x00-\x1f\x7f]/.test(name) || !/\.(pdf|ppt|pptx|key)$/i.test(name)) fail(400, 'Choose a PDF, PPT, PPTX, or Keynote file with a safe filename.');
    const length = Number(request.headers['content-length']); if (Number.isFinite(length) && length > attachmentLimit) fail(413, 'Presentation files are limited to 100 MB.');
    const dir = await this.safe('group-attachments', groupId); await fs.mkdir(dir, { recursive: true });
    const id = randomUUID(), file = await this.safe('group-attachments', groupId, id), handle = await fs.open(file, 'wx', 0o600); let size = 0;
    try {
      for await (const chunk of request) { size += chunk.length; if (size > attachmentLimit) fail(413, 'Presentation files are limited to 100 MB.'); await handle.writeFile(chunk); }
      if (!size) fail(400, 'Choose a non-empty presentation file.');
      await handle.close(); const metadata = { id, name, size };
      await fs.writeFile(await this.safe('group-attachments', groupId, `${id}.json`), JSON.stringify(metadata), { flag: 'wx', mode: 0o600 }); return metadata;
    } catch (e) { await handle.close().catch(() => {}); await fs.rm(file, { force: true }); throw e; }
  }
  async attachment(groupId, id) {
    this.checkId(groupId); this.checkId(id);
    const metadata = JSON.parse(await fs.readFile(await this.safe('group-attachments', groupId, `${id}.json`), 'utf8'));
    if (metadata.id !== id || typeof metadata.name !== 'string') fail(400, 'Invalid presentation metadata.');
    const file = await this.safe('group-attachments', groupId, id), stat = await fs.stat(file);
    if (!stat.isFile() || stat.size !== metadata.size) fail(400, 'Presentation file is incomplete.'); return { ...metadata, file };
  }
}
