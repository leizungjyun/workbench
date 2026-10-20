import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { newStudent, validateStudent, studentSummary, uuidPattern, profileFields, richText } from './student-model.js';
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export class StudentStore {
  constructor(notebooks, { directory = 'students', versionsDirectory = 'student-versions', validateDocument = validateStudent, createDocument = newStudent, summary = studentSummary, fields = profileFields, label = 'Student' } = {}) { Object.assign(this, { notebooks, root: notebooks.stateDir, directory, versionsDirectory, validateDocument, createDocument, summary, fields, label }); }
  async safe(...parts) {
    let file = this.root;
    for (const part of ['', ...parts]) {
      file = path.join(file, part);
      try { if ((await fs.lstat(file)).isSymbolicLink()) fail(400, `${this.label} storage cannot contain symlinks.`); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return file;
  }
  checkId(id) { if (typeof id !== 'string' || !uuidPattern.test(id)) fail(400, `Invalid ${this.label.toLowerCase()} ID.`); }
  async init() { await fs.mkdir(await this.safe(this.directory), { recursive: true }); await fs.mkdir(await this.safe(this.versionsDirectory), { recursive: true }); return this; }
  async read(id) {
    this.checkId(id); const file = await this.safe(this.directory, `${id}.json`);
    const handle = await fs.open(file); let bytes, stat;
    try { bytes = await handle.readFile(); stat = await handle.stat(); } finally { await handle.close(); }
    let document; try { document = JSON.parse(bytes); } catch { fail(400, `${this.label} data is invalid JSON; the file has been preserved.`); }
    this.validateDocument(document); if (document.id !== id) fail(400, `${this.label} file ID does not match.`);
    return { document, revision: hash(bytes), savedAt: stat.mtime.toISOString() };
  }
  async all() {
    const dir = await this.safe(this.directory);
    const names = await fs.readdir(dir);
    return Promise.all(names.filter(name => name.endsWith('.json') && uuidPattern.test(name.slice(0, -5))).sort().map(name => this.read(name.slice(0, -5))));
  }
  async list() { return { [this.directory]: (await this.all()).map(item => this.summary(item.document)).sort((a, b) => Number(!a.nextMeeting) - Number(!b.nextMeeting) || a.nextMeeting.localeCompare(b.nextMeeting) || a.name.localeCompare(b.name)) }; }
  async search(query) {
    const q = query.toLocaleLowerCase(); if (!q.trim()) return [];
    const results = [];
    for (const { document: d } of await this.all()) {
      let count = 0; const matches = [];
      const match = (value, section, target = {}) => {
        const lower = value.toLocaleLowerCase(); let offset = 0;
        while ((offset = lower.indexOf(q, offset)) !== -1) {
          const original = lower.length === value.length ? offset : [...value].reduce((s, c) => s.lower < offset ? { lower: s.lower + c.toLocaleLowerCase().length, original: s.original + c.length } : s, { lower: 0, original: 0 }).original;
          const start = Math.max(0, original - 45);
          if (matches.length < 12) matches.push({ section, ...target, snippet: value.slice(start, original + query.length + 80), highlight: original - start, length: query.length });
          count++; offset += q.length;
        }
      };
      for (const value of Object.values(d.profile)) if (typeof value === 'string') match(value, 'Profile');
      match(d.preparation.date, 'Next conversation'); match(richText(d.preparation.agenda), 'Next conversation');
      for (const s of d.sessions) {
        const target = { sessionId: s.id };
        for (const value of [s.date, s.title, richText(s.discussion), richText(s.decisions), richText(s.correction), s.nextConversation?.date || '', richText(s.nextConversation?.agenda), ...s.actions.flatMap(a => [a.text, a.owner, a.dueDate])]) match(value, 'Meeting record', target);
      }
      for (const g of d.objectives) {
        for (const value of [g.title, richText(g.description), g.targetDate, g.status, ...g.milestones.map(m => m.text)]) match(value, 'Objective', { goalId: g.id });
      }
      if (count) results.push({ type: 'student', id: d.id, name: d.profile.name, archived: d.archived, count, matches });
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
  }
  async create(input) {
    if (!input || typeof input.name !== 'string') fail(400, `A ${this.label.toLowerCase()} name is required.`);
    const document = this.createDocument(randomUUID(), input.name.trim());
    if (input.profile !== undefined) {
      if (!input.profile || typeof input.profile !== 'object' || Array.isArray(input.profile) || Object.keys(input.profile).some(key => !this.fields.includes(key))) fail(400, `Invalid ${this.label.toLowerCase()} profile.`);
      Object.assign(document.profile, input.profile, { name: input.name.trim() });
    }
    this.validateDocument(document);
    await fs.writeFile(await this.safe(this.directory, `${document.id}.json`), JSON.stringify(document, null, 2), { flag: 'wx', mode: 0o600 });
    return this.read(document.id);
  }
  async save(id, input) {
    this.checkId(id); if (!input || typeof input.revision !== 'string') fail(400, 'A revision is required.');
    const document = this.validateDocument(input.document);
    if (this.timetables) {
      const academic = (await this.timetables.read()).document;
      if (document.profile.schoolId && !academic.schools.some(s => s.id === document.profile.schoolId)) fail(400, 'Unknown student school.');
      for (const timetable of document.timetables || []) {
        const semester = academic.semesters.find(s => s.id === timetable.semesterId);
        if (!semester) fail(400, 'Unknown course semester.');
        for (const course of timetable.courses.filter(c => c.status === 'confirmed')) if (course.periods.some(n => !semester.periods.some(p => p.number === n))) fail(400, 'Configure every confirmed course period in its school calendar.');
      }
    } if (document.id !== id) fail(400, `${this.label} ID cannot change.`);
    const previous = await this.read(id);
    // Even explicit overwrite must use the revision the user reviewed.
    if (input.revision !== previous.revision) fail(409, `This ${this.label.toLowerCase()} changed on disk. Your draft is preserved.`);
    const versions = await this.safe(this.versionsDirectory, id); await fs.mkdir(versions, { recursive: true });
    const version = `${Date.now()}-${randomUUID()}.json`;
    await fs.writeFile(await this.safe(this.versionsDirectory, id, version), JSON.stringify(previous, null, 2), { flag: 'wx', mode: 0o600 });
    await this.notebooks.atomic(await this.safe(this.directory, `${id}.json`), JSON.stringify(document, null, 2), async () => {
      if ((await this.read(id)).revision !== input.revision) fail(409, `This ${this.label.toLowerCase()} changed on disk. Your draft is preserved.`);
    });
    const names = (await fs.readdir(versions)).filter(n => /^\d+-[a-f\d-]+\.json$/.test(n)).sort().reverse();
    for (const name of names.slice(20)) await fs.rm(await this.safe(this.versionsDirectory, id, name));
    return this.read(id);
  }
  async export() { return { schemaVersion: 1, exportedAt: new Date().toISOString(), [this.directory]: (await this.all()).map(item => item.document) }; }
}
