import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isJupyter, parseNotebook } from '../notebooks.js';

export const hash = data => createHash('sha256').update(data).digest('hex');
const excluded = new Set(['collections', 'node_modules', 'dist', 'app', 'scripts', 'tests', 'examples', 'fixtures', '__pycache__', 'venv', 'env']);
async function scan(root, prefix = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || excluded.has(entry.name) || entry.isSymbolicLink()) continue;
    const relative = path.posix.join(prefix, entry.name);
    if (relative === 'README.md' && entry.isFile() && (await fs.readFile(path.join(root, relative), 'utf8')).startsWith('<!-- fieldnotes: app-documentation -->')) continue;
    if (entry.isDirectory()) result.push(...await scan(root, relative));
    else if (entry.isFile() && /\.(md|ipynb)$/i.test(entry.name)) result.push(relative);
  }
  return result.sort();
}
async function exists(file) { try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function safeParents(root, relative) {
  let current = root;
  for (const part of relative.split('/').slice(0, -1)) {
    current = path.join(current, part);
    if (await exists(current)) {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe directory: ${current}`);
    }
  }
}
export async function migrate(root) {
  root = path.resolve(root);
  const stateDir = path.join(root, '.notebook');
  await safeParents(root, '.notebook/import-manifest.json');
  await fs.mkdir(stateDir, { recursive: true });
  const manifestPath = path.join(stateDir, 'import-manifest.json');
  const previous = await exists(manifestPath) ? JSON.parse(await fs.readFile(manifestPath, 'utf8')) : { notes: [], attachments: {} };
  const entries = new Map(previous.notes.map(item => [item.path, item]));
  const attachments = { ...previous.attachments };
  const notebookOrigins = { ...previous.notebookOrigins };
  const sources = await scan(root);
  for (const relative of sources) {
    const data = await fs.readFile(path.join(root, relative));
    if (isJupyter(relative)) { parseNotebook(data.toString('utf8')); notebookOrigins[relative] = path.posix.dirname(relative); }
    entries.set(relative, { path: relative, sha256: hash(data), bytes: data.length });
    const images = {};
    for (const match of data.toString('utf8').matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)) {
      const href = match[1];
      if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(href)) continue;
      let decoded; try { decoded = decodeURIComponent(href); } catch { continue; }
      const target = path.resolve(root, path.dirname(relative), decoded);
      const asset = path.relative(root, target).split(path.sep).join('/');
      if (asset.startsWith('../') || !/\.(png|jpe?g|gif|webp|avif)$/i.test(asset)) continue;
      await safeParents(root, asset);
      if (await exists(target) && (await fs.lstat(target)).isFile()) images[href] = { id: hash(asset).slice(0, 24), path: asset };
    }
    if (Object.keys(images).length) attachments[relative] = images;
  }
  // Preflight every destination before moving any source.
  for (const relative of sources) {
    await safeParents(root, `collections/${relative}`);
    if (await exists(path.join(root, 'collections', relative))) throw new Error(`Destination collision: collections/${relative}`);
  }
  const manifest = { version: 1, notes: [...entries.values()], attachments, notebookOrigins };
  // A journal makes interruption and a subsequent rerun safe.
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  for (const relative of sources) {
    const source = path.join(root, relative), target = path.join(root, 'collections', relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.link(source, target); // Exclusive: never replaces an existing destination.
    await fs.unlink(source);
  }
  for (const relative of sources) {
    const data = await fs.readFile(path.join(root, 'collections', relative));
    if (hash(data) !== entries.get(relative).sha256) throw new Error(`Verification failed: ${relative}`);
  }
  return { moved: sources.length, verified: sources.length, imported: entries.size };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await migrate(process.argv[2] || process.cwd()), null, 2));
}
