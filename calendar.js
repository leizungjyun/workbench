import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { newCalendar, validateCalendar } from './calendar-model.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export class CalendarStore {
  constructor(notebooks) { this.notebooks = notebooks; }
  async safe(...parts) {
    let file = this.notebooks.stateDir;
    for (const part of ['', 'calendar', ...parts]) { file = path.join(file, part); try { if ((await fs.lstat(file)).isSymbolicLink()) fail(400, 'Calendar storage cannot contain symlinks.'); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    return file;
  }
  async init() {
    await fs.mkdir(await this.safe(), { recursive: true }); await fs.mkdir(await this.safe('versions'), { recursive: true });
    try { await fs.writeFile(await this.safe('workspace.json'), JSON.stringify(newCalendar(randomUUID()), null, 2), { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    await this.read(); return this;
  }
  async read() {
    const handle = await fs.open(await this.safe('workspace.json')); let bytes, stat;
    try { bytes = await handle.readFile(); stat = await handle.stat(); } finally { await handle.close(); }
    let document; try { document = JSON.parse(bytes); } catch { fail(400, 'Calendar data is invalid JSON; the file has been preserved.'); }
    validateCalendar(document); return { document, revision: hash(bytes), savedAt: stat.mtime.toISOString() };
  }
  async save(input) {
    if (!input || typeof input.revision !== 'string') fail(400, 'A Calendar revision is required.');
    const { document, revision } = input;
    validateCalendar(document); const previous = await this.read();
    if (document.id !== previous.document.id) fail(400, 'Calendar identity cannot change.');
    if (revision !== previous.revision) fail(409, 'Calendar changed on disk. Your draft is preserved.');
    await fs.writeFile(await this.safe('versions', `${Date.now()}-${randomUUID()}.json`), JSON.stringify(previous, null, 2), { flag: 'wx', mode: 0o600 });
    await this.notebooks.atomic(await this.safe('workspace.json'), JSON.stringify(document, null, 2), async () => { if ((await this.read()).revision !== revision) fail(409, 'Calendar changed on disk. Your draft is preserved.'); });
    const versions = (await fs.readdir(await this.safe('versions'))).filter(n => /^\d+-[a-f\d-]+\.json$/.test(n)).sort().reverse();
    for (const name of versions.slice(20)) await fs.rm(await this.safe('versions', name));
    return this.read();
  }
  async export() { const { document } = await this.read(); return { schemaVersion: 1, exportedAt: new Date().toISOString(), document }; }
}
