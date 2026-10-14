import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { newDaily, newTask, validateDaily, normalizeDaily, validDate, categoryTranslations, markdownExport } from './daily-model.js';
import { syncCalendarTasks } from './daily-calendar.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

export class DailyStore {
  constructor(notebooks) { this.notebooks = notebooks; }
  async safe(...parts) {
    let file = this.notebooks.stateDir;
    for (const part of ['', 'daily', ...parts]) { file = path.join(file, part); try { if ((await fs.lstat(file)).isSymbolicLink()) fail(400, 'Daily storage cannot contain symlinks.'); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    return file;
  }
  async init() {
    await fs.mkdir(await this.safe(), { recursive: true }); await fs.mkdir(await this.safe('versions'), { recursive: true });
    try { await fs.writeFile(await this.safe('workspace.json'), JSON.stringify(newDaily(randomUUID()), null, 2), { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    await this.read(); return this;
  }
  async readStored() {
    const handle = await fs.open(await this.safe('workspace.json')); let bytes, stat;
    try { bytes = await handle.readFile(); stat = await handle.stat(); } finally { await handle.close(); }
    let document; try { document = JSON.parse(bytes); } catch { fail(400, 'Daily data is invalid JSON; the file has been preserved.'); }
    validateDaily(document); normalizeDaily(document); return { document, revision: hash(bytes), savedAt: stat.mtime.toISOString() };
  }
  async read() {
    const previous = await this.readStored();
    const document = structuredClone(previous.document);
    if (this.calendar && syncCalendarTasks(document, (await this.calendar.read()).document)) {
      return this.write(previous, document);
    }
    return previous;
  }
  async save(input) {
    if (!input || typeof input.revision !== 'string') fail(400, 'A Daily revision is required.');
    const { document, revision } = input;
    validateDaily(document); const normalized = normalizeDaily(structuredClone(document)); const previous = await this.read();
    if (document.id !== previous.document.id) fail(400, 'Daily identity cannot change.');
    if (revision !== previous.revision) fail(409, 'Daily changed on disk. Your draft is preserved.');
    return this.write(previous, normalized);
  }
  async write(previous, normalized) {
    const revision = previous.revision;
    await fs.writeFile(await this.safe('versions', `${Date.now()}-${randomUUID()}.json`), JSON.stringify(previous, null, 2), { flag: 'wx', mode: 0o600 });
    await this.notebooks.atomic(await this.safe('workspace.json'), JSON.stringify(normalized, null, 2), async () => { if ((await this.readStored()).revision !== revision) fail(409, 'Daily changed on disk. Your draft is preserved.'); });
    const versions = (await fs.readdir(await this.safe('versions'))).filter(n => /^\d+-[a-f\d-]+\.json$/.test(n)).sort().reverse();
    for (const name of versions.slice(20)) await fs.rm(await this.safe('versions', name));
    return this.readStored();
  }
  async export(format) { const { document } = await this.read(); return format === 'markdown' ? { content: markdownExport(document) } : { schemaVersion: 1, exportedAt: new Date().toISOString(), document }; }
  async preview(options = {}) {
    const preferences = this.notebooks.state.dailyImport || {};
    const { source, from, to } = { ...preferences, ...options };
    if (!source || !/\.md$/i.test(source) || !validDate(from) || !validDate(to) || from > to) fail(400, 'Choose a Markdown source and a valid inclusive date range.');
    const saved = await this.read(); const note = await this.notebooks.read(source);
    const document = structuredClone(saved.document); const imported = [], tasks = [];
    const importId = seed => { const value = hash(`${document.id}:${note.revision}:${seed}`); return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`; };
    const blocks = [...note.content.matchAll(/^\s*#\s+(\d{4}-\d{2}-\d{2})([^\n]*)\n?/gm)];
    for (const i of blocks.map((_, i) => i).sort((a, b) => blocks[a][1].localeCompare(blocks[b][1]))) {
      const date = blocks[i][1]; if ((date < from || date > to) || document.imports.some(m => m.source === source && m.date === date)) continue;
      if (imported.includes(date)) fail(400, 'The source has duplicate date headings. Resolve them before importing.');
      imported.push(date); let categoryId = '', activeTask = null, taskIndent = -1; const notes = [];
      if (blocks[i][2].trim()) notes.push(blocks[i][2].trim());
      const lines = note.content.slice(blocks[i].index + blocks[i][0].length, blocks[i + 1]?.index ?? note.content.length).split('\n');
      for (const [lineNumber, line] of lines.entries()) {
        const category = line.match(/^\s*-\s+([^\[\n]+?)\s*$/); const english = Object.hasOwn(categoryTranslations, category?.[1]) ? categoryTranslations[category[1]] : null;
        if (english) {
          let c = document.categories.find(c => c.name === english); if (!c) { c = { id: importId(`category:${english}`), name: english, hidden: false }; document.categories.push(c); }
          categoryId = c.id; activeTask = null; notes.push(`## ${english}`); continue;
        }
        const check = line.match(/^(\s*)-\s+\[([ xX])\]\s+(.+)$/); const indent = line.match(/^\s*/)[0].length;
        if (check && activeTask && indent > taskIndent) { activeTask.versions.at(-1).subtasks.push({ id: importId(`subtask:${date}:${lineNumber}`), text: check[3].trim(), done: check[2] !== ' ' }); continue; }
        if (check) {
          const text = check[3].trim(), done = check[2] !== ' ';
          let task = !done && tasks.find(t => t.versions.at(-1).status === 'open' && t.versions.at(-1).text === text && t.versions.at(-1).categoryId === categoryId && !t.appearances.includes(date));
          if (task) { task.appearances.push(date); task.versions.push({ ...structuredClone(task.versions.at(-1)), date }); }
          else { task = newTask(importId(`task:${date}:${lineNumber}`), date, text, categoryId); if (done) task.versions[0].status = 'completed'; tasks.push(task); }
          activeTask = task; taskIndent = check[1].length; continue;
        }
        if (activeTask && line.trim() && indent > taskIndent) { const v = activeTask.versions.at(-1); v.details += (v.details ? '\n' : '') + line.slice(taskIndent + 2); }
        else { if (line.trim()) activeTask = null; notes.push(line); }
      }
      const text = notes.join('\n').trim(); if (text) document.days[date] = { notes: [document.days[date]?.notes, text].filter(Boolean).join('\n\n') };
      document.imports.push({ source, date });
    }
    // Parse dates in ascending order so task snapshots are always ordered.
    for (const task of tasks) { task.versions.sort((a, b) => a.date.localeCompare(b.date)); task.appearances.sort(); task.originDate = task.versions[0].date; }
    document.tasks.push(...tasks); validateDaily(document); normalizeDaily(document);
    return { source, from, to, dates: imported, taskCount: tasks.length, document, revision: saved.revision, sourceRevision: note.revision, content: markdownExport(document) };
  }
  async apply(input) {
    const preview = await this.preview(input || {});
    if (!input || preview.revision !== input.revision || preview.sourceRevision !== input.sourceRevision) fail(409, 'The log or Daily changed. Review a fresh import preview.');
    if (!preview.dates.length) fail(409, 'These dates were already imported or are absent from the source.');
    const result = await this.save(preview);
    this.notebooks.state.dailyImport = { source: preview.source, from: preview.from, to: preview.to }; await this.notebooks.persist(); return result;
  }
  async search(query) {
    const q = query.toLocaleLowerCase(); if (!q.trim()) return [];
    const { document } = await this.read(); const results = [];
    const match = (text, date, task, category, status) => {
      const matches = []; const lower = text.toLocaleLowerCase(); let offset = 0, count = 0;
      while ((offset = lower.indexOf(q, offset)) !== -1) {
        const original = lower.length === text.length ? offset : [...text].reduce((s, c) => s.lower < offset ? { lower: s.lower + c.toLocaleLowerCase().length, original: s.original + c.length } : s, { lower: 0, original: 0 }).original;
        const start = Math.max(0, original - 45); if (matches.length < 12) matches.push({ offset: original, length: query.length, snippet: text.slice(start, original + query.length + 80), highlight: original - start, date }); count++; offset += q.length;
      }
      if (count) results.push({ type: 'daily', date, taskId: task?.id, title: task ? task.versions.at(-1).text : 'Daily notes', category, status, count, matches });
    };
    for (const task of document.tasks) {
      const seen = new Set(), texts = [];
      for (const v of [...task.versions].reverse()) {
        const category = document.categories.find(c => c.id === v.categoryId)?.name || 'Miscellaneous';
        for (const text of [v.text, v.details, category, ...v.subtasks.map(s => s.text)]) if (text && !seen.has(text)) { seen.add(text); texts.push({ text, date: v.date, category }); }
      }
      const first = texts.find(t => t.text.toLocaleLowerCase().includes(q));
      if (first) {
        const start = results.length;
        for (const field of texts) match(field.text, field.date, task, field.category, task.versions.at(-1).status);
        const fields = results.splice(start);
        results.push({ ...fields[0], count: fields.reduce((sum, f) => sum + f.count, 0), matches: fields.flatMap(f => f.matches).slice(0, 12) });
      }
    }
    for (const [date, day] of Object.entries(document.days)) match(day.notes, date, null, '', 'note');
    return results;
  }
}
