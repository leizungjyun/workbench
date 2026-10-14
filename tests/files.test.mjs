import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp, NotebookStore } from '../server.js';
import { workspacePath } from '../workspace.js';
import { organizeWorkspace } from '../scripts/organize-workspace.mjs';
async function fixture(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(),'workbench-files-')); t.after(()=>fs.rm(root,{recursive:true,force:true})); const store=await new NotebookStore(root).init(); return {root,store}; }
test('workspace CLI precedence, normal text, UTF-8 BOM and newline style preservation, search and lifecycle', async t=>{
 const {root,store}=await fixture(t); assert.equal(workspacePath(['--workspace',root],{WORKBENCH_WORKSPACE:'/other'}),root); assert.throws(()=>workspacePath(['--workspace'],{}));
 await fs.writeFile(path.join(store.collection,'helper.py'),Buffer.from('\ufeffvalue = "needle"\r\nprint(value)\r\n'));
 const file=await store.read('helper.py'); assert.equal(file.kind,'text'); assert.equal(file.content.charCodeAt(0)===0xfeff,false);
 const saved=await store.save({path:file.path,revision:file.revision,content:'value = "needle"\nprint(42)\n'}); assert.equal(await fs.readFile(path.join(store.collection,'helper.py'),'utf8'),'\ufeffvalue = "needle"\r\nprint(42)\r\n');
 await assert.rejects(store.save({path:file.path,revision:file.revision,content:'stale'}),{status:409});
 await store.metadata({path:file.path,pin:true,recent:true}); const info=await store.item({path:file.path}); const archive=await store.transfer({path:file.path,action:'archive',revision:info.revision});
 assert.equal((await store.read('',archive)).content,saved.content); assert.equal((await store.search('needle')).occurrences,1);
 await assert.rejects(store.save({path:file.path,scope:'archive',content:'unsafe'}),{status:403}); const archived=await store.item(archive); const trash=await store.transfer({...archive,action:'trash',revision:archived.revision}); assert.equal((await store.search('needle')).occurrences,0);
 const back=await store.transfer({...trash,action:'restore',revision:(await store.item(trash)).revision}); await store.transfer({...back,action:'restore',revision:(await store.item(back)).revision}); assert.equal(store.state.pins.includes(file.path),true);
});
test('binary, non-UTF8 and oversized text are download-only; hidden caches stay out of the tree',async t=>{
 const {store}=await fixture(t); await fs.writeFile(path.join(store.collection,'invalid.txt'),Buffer.from([255,0,1])); await fs.writeFile(path.join(store.collection,'large.txt'),'a'.repeat(5*1024*1024+1)); await fs.mkdir(path.join(store.collection,'__pycache__')); await fs.writeFile(path.join(store.collection,'__pycache__/x.pyc'),'hidden');
 for(const name of ['invalid.txt','large.txt']) { const file=await store.read(name); assert.equal(file.viewOnly,true); await assert.rejects(store.save({path:name,content:'replace',revision:file.revision}),{status:403}); }
 assert.equal((await store.tree()).notes.length,2); assert.equal((await store.tree()).folders.length,0);
});
test('separate app root serves built assets, scoped streams never render active HTML, and origins/traversal are restricted',async t=>{
 const {root,store}=await fixture(t); await fs.writeFile(path.join(store.collection,'image.png'),Buffer.from([1,2,3])); await fs.writeFile(path.join(store.collection,'page.html'),'<script>evil()</script>');
 const app=await createApp(root); await new Promise(r=>app.server.listen(0,'127.0.0.1',r)); t.after(async()=>{await app.terminals.close();await app.kernels.close();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));}); const base=`http://127.0.0.1:${app.server.address().port}`;
 assert.equal((await fetch(base+'/')).status,200); const raw=await fetch(base+'/api/file/raw?path=image.png&preview=true'); assert.equal(raw.headers.get('content-type'),'image/png'); assert.deepEqual(Buffer.from(await raw.arrayBuffer()),Buffer.from([1,2,3]));
 const html=await fetch(base+'/api/file/raw?path=page.html&preview=true'); assert.match(html.headers.get('content-disposition'),/^attachment/); assert.equal((await app.store.read('page.html')).kind,'text');
 assert.equal((await fetch(base+'/api/file/raw?path=../server.js')).status,400); assert.equal((await fetch(base+'/api/file',{method:'PUT',headers:{Origin:'https://other.test','content-type':'application/json'},body:'{}'})).status,403);
});
test('private organization verifies bytes, remaps helper directories, preserves unrelated files and repeats safely',async t=>{
 const {root,store}=await fixture(t); await fs.mkdir(path.join(root,'circuits/space ü'),{recursive:true}); await fs.mkdir(path.join(store.collection,'circuits')); await fs.writeFile(path.join(root,'circuits/.DS_Store'),'source cache'); await fs.writeFile(path.join(store.collection,'circuits/.DS_Store'),'destination cache'); await fs.writeFile(path.join(root,'circuits/space ü/helper.py'),'value = 42\n'); await fs.mkdir(path.join(root,'password')); await fs.writeFile(path.join(root,'password/password.md'),'# Synthetic private note'); await fs.mkdir(path.join(root,'fixtures')); await fs.writeFile(path.join(root,'fixtures/import.json'),'{}'); await fs.writeFile(path.join(root,'unrelated.bin'),Buffer.from([0,1])); store.state.notebookOrigins['a.ipynb']='circuits/space ü'; await store.persist();
 const result=await organizeWorkspace(root); assert.equal(result.verified,3); assert.equal(await fs.readFile(path.join(root,'circuits/.DS_Store'),'utf8'),'source cache'); assert.equal(await fs.readFile(path.join(store.collection,'circuits/.DS_Store'),'utf8'),'destination cache'); assert.equal(await fs.readFile(path.join(root,'collections/circuits/space ü/helper.py'),'utf8'),'value = 42\n'); assert.equal(JSON.parse(await fs.readFile(path.join(root,'.notebook/state.json'),'utf8')).notebookOrigins['a.ipynb'],'collections/circuits/space ü'); assert.deepEqual(await fs.readFile(path.join(root,'unrelated.bin')),Buffer.from([0,1])); assert.equal((await organizeWorkspace(root)).moved,0);
});
test('private organization stops on collisions before moving any source',async t=>{
 const {root,store}=await fixture(t); await fs.mkdir(path.join(root,'circuits')); await fs.mkdir(path.join(store.collection,'circuits')); await fs.writeFile(path.join(root,'circuits/a.py'),'one'); await fs.writeFile(path.join(store.collection,'circuits/a.py'),'two'); await assert.rejects(organizeWorkspace(root),/collision/); assert.equal(await fs.readFile(path.join(root,'circuits/a.py'),'utf8'),'one');
});

test('organization resumes an interrupted move, retains empty folders and refuses symlink escapes',async t=>{
 const {root,store}=await fixture(t); await fs.mkdir(path.join(root,'circuits/empty'),{recursive:true}); await fs.writeFile(path.join(root,'circuits/helper.py'),'value=42'); await fs.mkdir(path.join(store.collection,'circuits'));
 const {createHash}=await import('node:crypto'); const hash=b=>createHash('sha256').update(b).digest('hex'); const stateBytes=await fs.readFile(path.join(store.stateDir,'state.json')); const state=JSON.parse(stateBytes); state.notebookOrigins['example.ipynb']='collections/circuits';
 const journal={version:1,moves:[{source:'circuits/helper.py',target:'collections/circuits/helper.py',hash:hash(Buffer.from('value=42'))}],directories:['collections/circuits/empty'],state,oldStateHash:hash(stateBytes)};
 await fs.writeFile(path.join(store.stateDir,'workspace-migration.json'),JSON.stringify(journal)); await fs.rename(path.join(root,'circuits/helper.py'),path.join(store.collection,'circuits/helper.py'));
 assert.equal((await organizeWorkspace(root)).verified,1); assert.equal((await fs.stat(path.join(store.collection,'circuits/empty'))).isDirectory(),true); assert.equal((await fs.readdir(store.stateDir)).includes('workspace-migration.json'),false);
 await fs.symlink(os.tmpdir(),path.join(root,'circuits/escape')); await assert.rejects(organizeWorkspace(root),/symlink/);
});

test('relative collection images are indexed before archive and survive individual notebook restoration',async t=>{
 const {store}=await fixture(t); await fs.writeFile(path.join(store.collection,'picture.png'),'image bytes'); await store.create({path:'picture.md',content:'![Picture](picture.png)'});
 const note=await store.read('picture.md'); assert.match(note.attachments['picture.png'],/^\/api\/file\/raw/);
 const archive=await store.transfer({path:'picture.md',action:'archive',revision:(await store.item({path:'picture.md'})).revision}); const stored=await store.read('',archive); const id=stored.attachments['picture.png'].split('/').at(-1); assert.equal(await fs.readFile(await store.attachment(id),'utf8'),'image bytes');
});

test('migration excludes application instructions while importing actual user notes',async t=>{
 const {root}=await fixture(t); const {migrate}=await import('../scripts/migrate.mjs'); await fs.writeFile(path.join(root,'AGENTS.md'),'# Instructions'); await fs.writeFile(path.join(root,'README.md'),'# App documentation'); await fs.writeFile(path.join(root,'package.json'),'{}'); await fs.writeFile(path.join(root,'server.js'),'// app'); await fs.mkdir(path.join(root,'notes')); await fs.writeFile(path.join(root,'notes/README.md'),'# User note');
 assert.equal((await migrate(root)).moved,1); assert.equal(await fs.readFile(path.join(root,'AGENTS.md'),'utf8'),'# Instructions'); assert.equal(await fs.readFile(path.join(root,'README.md'),'utf8'),'# App documentation'); assert.equal(await fs.readFile(path.join(root,'collections/notes/README.md'),'utf8'),'# User note');
});
