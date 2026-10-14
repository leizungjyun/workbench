import fs from 'node:fs/promises';
import { hiddenEntry } from './files.js';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash = data => createHash('sha256').update(data).digest('hex');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const exists = async file => { try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
export const contains = (parent, child) => child === parent || child.startsWith(parent + '/');
const remap = (value, from, to) => to + value.slice(from.length);
const subset = (object, prefix) => Object.fromEntries(Object.entries(object || {}).filter(([key]) => contains(prefix, key)));
const drop = (object, prefix) => { for (const key of Object.keys(object || {})) if (contains(prefix, key)) delete object[key]; };

export class LifecycleStore {
  async initLifecycle() {
    this.state.stored ||= {};
    for (const name of ['archive', 'trash', 'purging', 'assets']) {
      const dir = path.join(this.stateDir, name);
      if (await exists(dir) && (await fs.lstat(dir)).isSymbolicLink()) fail(400, 'Storage cannot be a symlink.');
      await fs.mkdir(dir, { recursive: true });
    }
    await this.recoverOperation();
    // Old trash files are left exactly where they are; only index them.
    for (const entry of await fs.readdir(path.join(this.stateDir, 'trash'), { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(md|ipynb)$/i.test(entry.name)) continue;
      const match = /^(\d+)-([a-f\d-]{36})-(.+)$/i.exec(entry.name);
      const id = 'legacy-' + hash(entry.name).slice(0, 24);
      if (this.state.stored[id]) continue;
      const proposedPath = match?.[3] || entry.name;
      this.validate(proposedPath);
      this.state.stored[id] = { id, scope: 'trash', kind: 'note', originalPath: null, proposedPath, sourceScope: 'active', deletedAt: new Date(match ? Number(match[1]) : (await fs.stat(path.join(this.stateDir, 'trash', entry.name))).mtimeMs).toISOString(), legacyFile: entry.name, attachments: {}, notebookOrigins: {}, pins: [] };
    }
    await this.persist();
  }
  async safeStorage(relative) {
    if (typeof relative !== 'string' || relative.split('/').some(p => !p || p === '.' || p === '..' || /[\\\x00-\x1f]/.test(p)) || !/^(collections\/|\.notebook\/(archive|trash|purging|assets)\/)/.test(relative)) fail(400, 'Invalid storage path.');
    let file = this.root;
    for (const part of relative.split('/')) { file = path.join(file, part); if (await exists(file) && (await fs.lstat(file)).isSymbolicLink()) fail(400, 'Symlinks are not allowed.'); }
    return file;
  }
  async commitOperation(moves, nextState, cleanup = [], beforeCommit) {
    if (await exists(path.join(this.stateDir, 'operation.json'))) fail(503, 'A storage operation needs recovery. Restart the app before trying again.');
    for (const move of moves) {
      const source = await this.safeStorage(move.source), target = await this.safeStorage(move.target);
      if (await exists(target)) fail(409, 'The destination already exists. Choose another path.');
      if ((await this.snapshot(source)).revision !== move.revision) fail(409, 'This item changed on disk. Refresh before trying again.');
    }
    if (beforeCommit) await beforeCommit();
    await this.atomic(path.join(this.stateDir, 'operation.json'), JSON.stringify({ moves, nextState, cleanup }));
    await this.recoverOperation();
  }
  async recoverOperation() {
    const journal = path.join(this.stateDir, 'operation.json');
    if (!await exists(journal)) return;
    if ((await fs.lstat(journal)).isSymbolicLink()) fail(400, 'Symlinks are not allowed.');
    const operation = JSON.parse(await fs.readFile(journal, 'utf8'));
    for (const move of operation.moves) {
      const source = await this.safeStorage(move.source), target = await this.safeStorage(move.target);
      const a = await exists(source), b = await exists(target);
      if (a && b) fail(409, 'Storage recovery found two copies. Both have been preserved.');
      if (!a && !b) fail(409, 'Storage recovery could not locate the item.');
      if (a) {
        if ((await this.snapshot(source)).revision !== move.revision) fail(409, 'The item changed during storage recovery. It has been preserved.');
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rename(source, target);
      }
    }
    this.state = operation.nextState; await this.persist();
    for (const relative of operation.cleanup || []) { const file = await this.safeStorage(relative); if (await exists(file)) { await this.snapshot(file); await fs.rm(file, { recursive: true, force: true }); } }
    await fs.unlink(journal);
  }
  async snapshot(file) {
    const files = [], notes = [], folders = [];
    const rootStat = await fs.lstat(file);
    if (rootStat.isSymbolicLink()) fail(400, 'Symlinks are not allowed.');
    const visit = async (current, relative, visible = true) => {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) fail(400, 'This item contains a symlink. Move the symlink outside it first.');
      if (stat.isDirectory()) {
        files.push([relative, 'directory']);
        if (relative && visible) folders.push(relative);
        for (const name of (await fs.readdir(current)).sort()) await visit(path.join(current, name), relative ? relative + '/' + name : name, visible && !hiddenEntry(name));
      } else if (stat.isFile()) {
        const digest = hash(await fs.readFile(current)); files.push([relative, digest]);
        if (visible) notes.push({ path: relative, modified: stat.mtimeMs, revision: digest });
      } else fail(400, 'Only regular files and folders can be managed.');
    };
    await visit(file, '');
    return { kind: rootStat.isDirectory() ? 'folder' : 'note', revision: rootStat.isFile() ? files[0][1] : hash(JSON.stringify(files)), fileCount: files.filter(f => f[1] !== 'directory').length, noteCount: notes.length, notes, folders };
  }
  async locate({ scope = 'active', id, path: relative = '' }) {
    if (scope === 'active') {
      const file = await this.resolve(relative, false);
      return { file, scope, path: relative, displayPath: relative };
    }
    if (!['archive', 'trash'].includes(scope) || typeof id !== 'string') fail(400, 'Invalid storage location.');
    const record = this.state.stored[id];
    if (!record || record.scope !== scope) fail(404, 'Stored item not found. Refresh the sidebar.');
    if (relative) this.validate(relative, false);
    if (record.kind === 'note' && relative) fail(400, 'A notebook has no child paths.');
    const base = record.legacyFile ? `.notebook/trash/${record.legacyFile}` : `.notebook/${scope}/${id}/payload`;
    const file = await this.safeStorage(base + (relative ? '/' + relative : ''));
    return { file, scope, id, path: relative, record, displayPath: (record.originalPath || record.proposedPath) + (relative ? '/' + relative : '') };
  }
  async item(ref) { const location = await this.locate(ref); const snapshot = await this.snapshot(location.file); return { scope: location.scope, id: location.id, path: location.path, displayPath: location.displayPath, ...snapshot }; }
  async storedEntries(scope) {
    const result = [];
    for (const record of Object.values(this.state.stored).filter(r => r.scope === scope)) {
      try { const info = await this.item({ scope, id: record.id }); result.push({ ...info, originalPath: record.originalPath, sourceScope: record.sourceScope, legacy: !!record.legacyFile, archivedAt: record.archivedAt, deletedAt: record.deletedAt }); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return result.sort((a, b) => (b.deletedAt || b.archivedAt || '').localeCompare(a.deletedAt || a.archivedAt || ''));
  }
  async readStored(ref) {
    const location = await this.locate(ref);
    this.validate(location.displayPath, false);
    const data = await fs.readFile(location.file), stat = await fs.stat(location.file);
    return this.fileDocument(location.displayPath, data, stat, { scope: location.scope, id: location.id, storedPath: location.path, readOnly: true, originalPath: location.record.originalPath, attachments: Object.fromEntries(Object.entries(location.record.attachments[location.displayPath] || {}).map(([href, asset]) => [href, `/api/attachments/${asset.id}`])) });
  }
  detachMetadata(next, location, selected) {
    if (location.scope === 'active') {
      next.pins = next.pins.filter(p => !contains(selected, p)); next.recent = next.recent.filter(p => !contains(selected, p));
      drop(next.attachments, selected); drop(next.notebookOrigins, selected);
    } else if (!location.path) delete next.stored[location.id];
    else { const record = next.stored[location.id]; drop(record.attachments, selected); drop(record.notebookOrigins, selected); record.pins = record.pins.filter(p => !contains(selected, p)); }
  }
  async transfer(input) {
    const location = await this.locate(input), info = await this.snapshot(location.file);
    if (info.kind === 'note') this.validate(location.displayPath, false);
    if (!input.revision || input.revision !== info.revision) fail(409, 'This item changed on disk. Refresh before trying again.');
    const action = input.action;
    if (!['archive', 'trash', 'restore', 'move', 'purge'].includes(action)) fail(400, 'Unknown item action.');
    if (action === 'archive' && location.scope !== 'active') fail(400, 'Only active items can be archived.');
    if (action === 'move' && location.scope !== 'active') fail(400, 'Restore this item before renaming or moving it.');
    if (action === 'restore' && location.scope === 'active') fail(400, 'This item is already active.');
    if (action === 'trash' && location.scope === 'trash') fail(400, 'This item is already in Trash.');
    if (action === 'purge' && location.scope !== 'trash') fail(400, 'Only Trash items can be permanently deleted.');
    await this.indexRelativeImages?.(location, info);
    const selected = location.displayPath;
    const next = structuredClone(this.state);
    const metadata = location.scope === 'active' ? this.state : location.record;
    const attachments = structuredClone(subset(metadata.attachments, selected)), notebookOrigins = structuredClone(subset(metadata.notebookOrigins, selected)), pins = metadata.pins.filter(p => contains(selected, p));
    let target, result, cleanup = [];
    if (action === 'move' || (action === 'restore' && (location.scope === 'archive' || location.record.sourceScope === 'active'))) {
      const destination = input.destination || selected;
      this.validate(destination, false);
      if (/\.(md|ipynb)$/i.test(selected) && path.extname(destination).toLowerCase() !== path.extname(selected).toLowerCase()) fail(400, 'Keep the notebook’s file extension.');
      if (location.scope === 'active' && contains(selected, destination)) fail(400, 'Choose a different path outside this folder.');
      target = await this.resolve(destination, false);
      this.detachMetadata(next, location, selected);
      for (const [key, value] of Object.entries(attachments)) next.attachments[remap(key, selected, destination)] = value;
      for (const [key, value] of Object.entries(notebookOrigins)) next.notebookOrigins[remap(key, selected, destination)] = value;
      next.pins = [...new Set([...next.pins, ...pins.map(p => remap(p, selected, destination))])];
      if (action === 'move') next.recent = this.state.recent.map(p => contains(selected, p) ? remap(p, selected, destination) : p);
      result = { scope: 'active', path: destination, kind: info.kind };
    } else {
      this.detachMetadata(next, location, selected);
      const scope = action === 'purge' ? 'purging' : action === 'archive' || action === 'restore' ? 'archive' : 'trash';
      const id = scope !== 'purging' && location.scope !== 'active' && !location.path && !location.record.legacyFile ? location.id : randomUUID(); target = path.join(this.stateDir, scope, id, 'payload');
      if (scope !== 'purging') {
        const record = { id, scope, kind: info.kind, originalPath: location.record?.originalPath === null ? null : selected, proposedPath: selected, sourceScope: action === 'restore' ? 'active' : location.scope, attachments, notebookOrigins, pins,
          archivedAt: scope === 'archive' ? location.record?.archivedAt || new Date().toISOString() : location.record?.archivedAt,
          deletedAt: scope === 'trash' ? new Date().toISOString() : undefined };
        next.stored[id] = record; result = { scope, id, path: '', kind: info.kind };
      } else { cleanup.push(path.relative(this.root, path.dirname(target)).split(path.sep).join('/')); result = { ok: true }; }
    }
    if (location.scope !== 'active' && !location.path && !location.record.legacyFile) cleanup.push(`.notebook/${location.scope}/${location.id}`);
    const relative = file => path.relative(this.root, file).split(path.sep).join('/');
    await this.relocateAssets(next, relative(location.file), relative(target), action === 'purge');
    await this.commitOperation([{ source: relative(location.file), target: relative(target), revision: info.revision }], next, cleanup, () => this.beforeTransfer?.(input, location));
    return result;
  }
  async emptyTrash() {
    const next = structuredClone(this.state), moves = [], cleanup = [];
    for (const record of Object.values(this.state.stored).filter(r => r.scope === 'trash')) {
      const location = await this.locate({ scope: 'trash', id: record.id }), info = await this.snapshot(location.file), id = randomUUID();
      moves.push({ source: path.relative(this.root, location.file).split(path.sep).join('/'), target: `.notebook/purging/${id}/payload`, revision: info.revision });
      cleanup.push(`.notebook/purging/${id}`); if (!record.legacyFile) cleanup.push(`.notebook/trash/${record.id}`); delete next.stored[record.id];
    }
    for (const move of moves) await this.relocateAssets(next, move.source, move.target, true);
    await this.commitOperation(moves, next, cleanup); return { ok: true };
  }
  async relocateAssets(next, source, target, purging) {
    const maps = [next.attachments, ...Object.values(next.stored).map(r => r.attachments)];
    for (const map of maps) for (const group of Object.values(map || {})) for (const asset of Object.values(group)) {
      if (!contains(source, asset.path)) continue;
      if (purging) {
        // An image may still be referenced by another notebook after its folder
        // is permanently deleted. Retain only explicitly indexed shared images.
        const destination = `.notebook/assets/${hash(asset.path).slice(0, 32)}${path.extname(asset.path)}`;
        const original = asset.path.startsWith('.notebook/') ? await this.safeStorage(asset.path) : await this.resolve(asset.path, false, this.root);
        await this.atomic(await this.safeStorage(destination), await fs.readFile(original)); asset.path = destination;
      } else asset.path = remap(asset.path, source, target);
    }
  }
}
