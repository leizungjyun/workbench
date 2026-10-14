import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const exists = async p => { try { await fs.lstat(p); return true; } catch (e) { if(e.code !== 'ENOENT') throw e; return false; } };
const digest = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
export async function organizeWorkspace(root, { dryRun = false } = {}) {
  root = path.resolve(root); const journalFile = path.join(root, '.notebook/workspace-migration.json');
  const safe = async relative => {
    if (typeof relative !== 'string' || !relative || relative.split('/').some(p => !p || p === '..' || p === '.' || /[\\\x00-\x1f]/.test(p))) throw new Error('Unsafe migration path.');
    let p = root; if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('Workspace cannot be a symlink.');
    for (const part of relative.split('/')) { p = path.join(p, part); if(await exists(p) && (await fs.lstat(p)).isSymbolicLink()) throw new Error('Migration refuses symlinks.'); } return p;
  };
  let operation;
  if (await exists(journalFile)) { await safe('.notebook/workspace-migration.json'); operation = JSON.parse(await fs.readFile(journalFile, 'utf8')); }
  else {
    const moves = [], directories = []; const add = async (source, target) => { const file = await safe(source); if (!await exists(file)) return; if (!(await fs.stat(file)).isFile()) throw new Error('Expected a regular source file.'); const destination = await safe(target); if(await exists(destination)) throw new Error(`Destination collision: ${target}`); moves.push({ source, target, hash: await digest(file) }); };
    const walk = async relative => { const file = await safe(relative); if(!await exists(file)) return; const stat = await fs.stat(file); if(stat.isDirectory()) { const target = 'collections/' + relative; const dest = await safe(target); if(await exists(dest) && !(await fs.stat(dest)).isDirectory()) throw new Error('Destination directory collision: ' + target); directories.push(target); for(const name of await fs.readdir(file)) if (name !== '.DS_Store') await walk(relative + '/' + name); } else await add(relative, 'collections/' + relative); };
    await walk('circuits'); await add('password/password.md', 'collections/password/password.md');
    const imports = await safe('fixtures'); if(await exists(imports)) for(const name of await fs.readdir(imports)) if(name.endsWith('.json')) await add('fixtures/' + name, '.notebook/imports/' + name);
    await add('notebook-import.json', '.notebook/import-manifest.json');
    const stateFile = await safe('.notebook/state.json'); const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    const update = map => { for(const key of Object.keys(map || {})) if(map[key] === 'circuits' || map[key].startsWith('circuits/')) map[key] = 'collections/' + map[key]; };
    update(state.notebookOrigins);
    const remapAssets = map => { for(const group of Object.values(map || {})) for(const asset of Object.values(group)) if(moves.some(m=>m.source === asset.path)) asset.path = moves.find(m=>m.source === asset.path).target; };
    remapAssets(state.attachments); for(const record of Object.values(state.stored || {})) { update(record.notebookOrigins); remapAssets(record.attachments); }
    operation = { version:1, moves, directories, state, oldStateHash: await digest(stateFile) };
    if(dryRun) return { files:moves.length, destinations:moves.map(m=>m.target) };
    if (!moves.length) { let missing = false; for(const d of directories) if(!await exists(await safe(d))) missing=true; if(!missing) return {moved:0}; }
    await fs.writeFile(journalFile, JSON.stringify(operation, null, 2), { flag:'wx', mode:0o600 });
  }
  if(dryRun) return { files:operation.moves.length, recovering:true };
  if (operation.version !== 1 || !Array.isArray(operation.moves)) throw new Error('Invalid migration journal.');
  const stateFile = await safe('.notebook/state.json');
  const current = await fs.readFile(stateFile,'utf8'); const currentHash = createHash('sha256').update(current).digest('hex');
  if(currentHash !== operation.oldStateHash && JSON.stringify(JSON.parse(current)) !== JSON.stringify(operation.state)) throw new Error('Workspace metadata changed. Migration paused without overwriting it.');
  for(const directory of operation.directories || []) { if(!directory.startsWith('collections/circuits')) throw new Error('Invalid migration directory.'); const dir = await safe(directory); if(await exists(dir) && !(await fs.stat(dir)).isDirectory()) throw new Error('Migration directory collision.'); await fs.mkdir(dir,{recursive:true}); }
  for(const move of operation.moves) {
    if(!/^(circuits\/|password\/password\.md$|fixtures\/|notebook-import\.json$)/.test(move.source) || !/^(collections\/|\.notebook\/(imports\/|import-manifest\.json$))/.test(move.target)) throw new Error('Invalid migration journal locations.');
    const source = await safe(move.source), target = await safe(move.target), a = await exists(source), b = await exists(target);
    if(a && b) throw new Error('Migration found two copies. Both were preserved.'); if(!a && !b) throw new Error('Migration source and destination are missing.');
    if(await digest(a ? source : target) !== move.hash) throw new Error('Migration contents changed; files were preserved.');
    if(a) { await fs.mkdir(path.dirname(target), {recursive:true}); await fs.rename(source,target); }
    if(await digest(target) !== move.hash) throw new Error('Migration hash verification failed.');
  }
  const temporary = path.join(root,'.notebook/.migrated-state.json'); await fs.writeFile(temporary,JSON.stringify(operation.state,null,2),{mode:0o600}); await fs.rename(temporary,stateFile);
  // Keep empty directory structure; no unrelated files or deleted files are recreated.
  await fs.unlink(journalFile); return { moved:operation.moves.length, verified:operation.moves.length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if(!process.argv[2]) throw new Error('Usage: node scripts/organize-workspace.mjs <workspace> [--dry-run]');
  console.log(JSON.stringify(await organizeWorkspace(process.argv[2], {dryRun:process.argv.includes('--dry-run')})));
}
