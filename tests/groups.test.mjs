import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { createApp } from '../server.js';
import { newGroupSession, validateGroup, defaultParticipants, markdownNote, groupCategoryId } from '../group-model.js';
import { attachmentLimit } from '../groups.js';
import { schoolInstant } from '../timetable-model.js';
import { updateTask, stateAt } from '../daily-model.js';
import { validateCalendar } from '../calendar-model.js';
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-groups-'));
  const app = await createApp(root, { now: () => Date.parse('2026-10-10T00:00:00Z') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.terminals.close(); await app.kernels.close(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const request = async (url, method = 'GET', body) => fetch(base + url, { method, headers: { Origin: base, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const students = await Promise.all(['Ada Example','Grace Example','Lin Example'].map(name => app.students.create({ name })));
  const memberIds = students.map(s => s.document.id);
  const group = await app.groups.create({ name: 'Synthetic Lab', memberIds, leaderId: memberIds[0] });
  return { root, app, request, base, students, memberIds, group };
}
async function withSession(f) { const s = newGroupSession(randomUUID(), f.group.document, '2026-10-20'); s.title = 'Baseline review'; f.group.document.sessions.push(s); f.group = await f.app.groups.save(f.group.document.id, f.group); return s; }
const eventFor = (f,s, patch = {}) => ({ id:s.id, groupId:f.group.document.id, groupSessionId:s.id, participantIds:[...s.participantIds], title:'Synthetic Lab · Workshop · Baseline review', start:'2026-10-20T02:00:00.000Z', timeZone:'Asia/Shanghai', durationMinutes:60, categoryId:groupCategoryId, ...patch });
async function book(f,e,acknowledge=true) {
  const checked=await (await f.request(`/api/groups/${e.groupId}/check`,'POST',{event:e})).json(),calendar=await f.app.calendar.read();
  calendar.document.events=calendar.document.events.filter(old=>old.id!==e.id);calendar.document.events.push(e);
  return f.request('/api/calendar','PUT',{...calendar,acknowledgements:acknowledge?{[e.id]:checked.acknowledgement}:{}});
}
test('groups support overlapping membership, required leaders, archives, snapshots, revisions and restart',async t=>{
  const f=await fixture(t),s=await withSession(f),before=structuredClone(f.group);
  const other=await f.app.groups.create({name:'Another Lab',memberIds:[f.memberIds[0]],leaderId:f.memberIds[0]});
  assert.equal(other.document.memberIds[0],f.memberIds[0]);assert.deepEqual(defaultParticipants(f.group.document,'Workshop'),f.memberIds);assert.deepEqual(defaultParticipants(f.group.document,'Roundtable'),[f.memberIds[0]]);
  f.group.document.memberIds=f.memberIds.slice(1);f.group.document.leaderId=f.memberIds[1];f.group.document.preparation.participantIds=f.memberIds.slice(1);f.group.document.archived=true;
  f.group=await f.app.groups.save(f.group.document.id,f.group);
  assert.deepEqual(f.group.document.sessions[0].participantIds,s.participantIds);
  await assert.rejects(f.app.groups.save(before.document.id,before),{status:409});
  const restarted=await createApp(f.root);t.after(async()=>{await restarted.terminals.close();await restarted.kernels.close();});
  assert.deepEqual((await restarted.groups.read(f.group.document.id)).document,f.group.document);assert.equal((await restarted.groups.list()).groups.find(g=>g.id===f.group.document.id).archived,true);
  for(const mutate of [d=>d.leaderId=randomUUID(),d=>d.memberIds.push(d.memberIds[0]),d=>d.sessions[0].participantIds=[],d=>d.sessions[0].type='Other']){const d=structuredClone(f.group.document);mutate(d);assert.throws(()=>validateGroup(d),{status:400});}
  await assert.rejects(f.app.groups.create({name:'Unknown',memberIds:[randomUUID()],leaderId:randomUUID()}),{status:400});
});
test('group Markdown, shared actions, objective relationships and search remain authoritative',async t=>{
  const f=await fixture(t),s=await withSession(f),d=f.group.document;
  const goal={id:randomUUID(),title:'Novel objective',description:markdownNote('Novel direction'),targetDate:'2027-01-01',status:'In progress',archived:false,milestones:[{id:randomUUID(),text:'Novel experiment',done:false}]};d.objectives.push(goal);
  d.sessions[0].correction=markdownNote('Novel corrected baseline');d.sessions[0].objectiveIds=[goal.id];
  d.sessions[0].actions.push({id:randomUUID(),text:'Novel follow-up',owner:'Students',assigneeIds:f.memberIds.slice(0,2),done:false,dueDate:'2026-11-01',objectiveId:goal.id});
  f.group=await f.app.groups.save(d.id,f.group);assert.equal((await f.app.groups.search('Novel'))[0].count,5);
  const search=await (await f.request('/api/search?q=corrected')).json();assert.equal(search.groups[0].matches[0].sessionId,s.id);assert.equal(search.occurrences,1);
  const exported=await (await f.request('/api/groups/export')).json();assert.deepEqual(exported.groups[0].sessions[0].actions[0].assigneeIds,f.memberIds.slice(0,2));
  const bad=structuredClone(f.group.document);bad.sessions[0].actions[0].assigneeIds=[];assert.throws(()=>validateGroup(bad));
  bad.sessions[0].actions[0].owner='Supervisor';bad.sessions[0].actions[0].objectiveId=randomUUID();assert.throws(()=>validateGroup(bad));
});
test('group scheduling creates one categorized Daily record, retains identity, completion and notes through edits and cancellation',async t=>{
  const f=await fixture(t),s=await withSession(f),e=eventFor(f,s);
  assert.equal((await book(f,e)).status,200);
  let daily=await f.app.daily.read();assert.equal(daily.document.tasks.length,1);assert.equal(daily.document.tasks[0].versions[0].categoryId,groupCategoryId);assert.deepEqual(daily.document.tasks[0].versions[0].participantIds,f.memberIds);
  const categoryIds=daily.document.categories.map(c=>c.id);assert.deepEqual(categoryIds.slice(0,6),Array.from({length:6},(_,i)=>`category-${i}`));
  updateTask(daily.document.tasks[0],'2026-10-20',{status:'completed',details:'Personal notes'});await f.app.daily.save(daily);
  e.start='2026-10-21T03:00:00.000Z';assert.equal((await book(f,e)).status,200);daily=await f.app.daily.read();assert.equal(daily.document.tasks.length,1);assert.equal(daily.document.tasks[0].id,e.id);assert.equal(daily.document.tasks[0].versions.at(-1).status,'completed');assert.equal(daily.document.tasks[0].versions.at(-1).details,'Personal notes');
  const calendar=await f.app.calendar.read();calendar.document.events=[];assert.equal((await f.request('/api/calendar','PUT',calendar)).status,200);daily=await f.app.daily.read();assert.equal(daily.document.tasks[0].calendarEvent.deleted,true);
  assert.equal((await f.app.groups.read(e.groupId)).document.sessions.length,1);
  assert.equal((await book(f,e)).status,200);assert.equal((await f.app.daily.read()).document.tasks.length,1);
});
test('availability includes every participant, common windows and incomplete timetables; conflicts and stale acknowledgements are enforced',async t=>{
  const f=await fixture(t),s=await withSession(f),e=eventFor(f,s);
  const calendar=await f.app.calendar.read();calendar.document.events.push({id:randomUUID(),title:'Existing booking',start:e.start,durationMinutes:30});await f.app.calendar.save(calendar);
  let checked=await (await f.request(`/api/groups/${e.groupId}/check`,'POST',{event:e})).json();assert.equal(checked.participants.length,3);assert.equal(checked.incomplete,true);assert.equal(checked.conflicts.length,1);assert.equal(checked.conflicts[0].title,'Existing booking');assert.ok(checked.conflicts[0].eventId);assert.equal(checked.conflicts[0].participantId,undefined);assert.ok(checked.participants.every(p=>p.conflicts.length===0));assert.ok(checked.slots.every(slot=>slot.end<=e.start||slot.start>='2026-10-20T02:30:00.000Z'));
  assert.equal((await book(f,e,false)).status,409);
  const draft=await f.app.calendar.read();draft.document.events.push(e);assert.equal((await f.request('/api/calendar','PUT',{...draft,acknowledgements:{[e.id]:checked.acknowledgement}})).status,200);
  e.location='Room B';checked=await (await f.request(`/api/groups/${e.groupId}/check`,'POST',{event:e})).json();
  let student=await f.app.students.read(f.memberIds[1]);student.document.profile.researchAreas='Changed';await f.app.students.save(student.document.id,student);
  const latest=await f.app.calendar.read();latest.document.events=latest.document.events.map(old=>old.id===e.id?e:old);
  assert.equal((await f.request('/api/calendar','PUT',{...latest,acknowledgements:{[e.id]:checked.acknowledgement}})).status,409);
  const bad={...e,participantIds:[]};assert.throws(()=>validateCalendar({...latest.document,events:[bad]}));
  const external=await f.app.students.create({name:'Outside group'});assert.equal((await f.request(`/api/groups/${e.groupId}/check`,'POST',{event:{...e,participantIds:[external.document.id]}})).status,400);
});
test('class conflicts from a second participant affect group availability while completed coursework removes class warnings',async t=>{
  const f=await fixture(t),s=await withSession(f);const fixtureData=JSON.parse(await fs.readFile(new URL('./fixtures/timetable.json',import.meta.url),'utf8'));
  const academic=await f.app.timetables.read();academic.document.semesters=fixtureData.semesters;await f.app.timetables.save(academic);
  let student=await f.app.students.read(f.memberIds[1]);student.document.profile.schoolId='SUAT';student.document.timetables=fixtureData.student.timetables;student=await f.app.students.save(student.document.id,student);
  const e=eventFor(f,s,{start:schoolInstant('2026-10-12','10:30','Asia/Shanghai'),durationMinutes:30});
  let checked=await (await f.request(`/api/groups/${e.groupId}/check`,'POST',{event:e})).json();assert.ok(checked.conflicts.some(c=>c.participantId===student.document.id&&c.type==='class'));
  const calendar = await f.app.calendar.read();
  const bookings = [randomUUID(), randomUUID()].map(id => ({ id, title: 'Same booking title', start: e.start, durationMinutes: 30 }));
  calendar.document.events.push(...bookings); await f.app.calendar.save(calendar);
  checked = await (await f.request(`/api/groups/${e.groupId}/check`, 'POST', { event: e })).json();
  assert.equal(checked.conflicts.filter(c => c.type === 'event').length, 2);
  assert.deepEqual(new Set(checked.conflicts.filter(c => c.type === 'event').map(c => c.eventId)), new Set(bookings.map(e => e.id)));
  assert.ok(checked.conflicts.filter(c => c.type === 'event').every(c => c.title === 'Same booking title' && !c.participantId));
  assert.ok(checked.conflicts.some(c => c.type === 'class' && c.participantId === student.document.id && c.participantName === student.document.profile.name));
  student.document.profile.coursesCompleted=true;await f.app.students.save(student.document.id,student);checked=await (await f.request(`/api/groups/${e.groupId}/check`,'POST',{event:e})).json();assert.equal(checked.participants.find(p=>p.id===student.document.id).incomplete,false);assert.equal(checked.conflicts.filter(c=>c.type==='class').length,0);
});
test('group APIs require origin, revisions and linked sessions; booked sessions cannot be removed or detached',async t=>{
  const f=await fixture(t),s=await withSession(f),e=eventFor(f,s);
  assert.equal((await fetch(f.base+'/api/groups',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await f.request(`/api/groups/${f.group.document.id}`,'PUT',{document:f.group.document})).status,400);
  const bad=eventFor(f,{...s,id:randomUUID()});assert.equal((await f.request(`/api/groups/${e.groupId}/check`,'POST',{event:bad})).status,400);
  assert.equal((await book(f,e)).status,200);const group=await f.app.groups.read(e.groupId);group.document.sessions=[];assert.equal((await f.request(`/api/groups/${e.groupId}`,'PUT',group)).status,400);
  const calendar=await f.app.calendar.read();delete calendar.document.events[0].groupId;delete calendar.document.events[0].groupSessionId;delete calendar.document.events[0].participantIds;assert.equal((await f.request('/api/calendar','PUT',calendar)).status,400);
});
test('optional presentations upload privately, preview PDFs, download originals and survive detachment and versioning',async t=>{
  const f=await fixture(t),s=await withSession(f),id=f.group.document.id;const bytes=Buffer.from('%PDF-1.4\nsynthetic presentation\n%%EOF');
  const upload=await fetch(`${f.base}/api/groups/${id}/attachments?name=${encodeURIComponent('Synthetic slides.pdf')}`,{method:'POST',headers:{Origin:f.base,'Content-Type':'application/octet-stream'},body:bytes});assert.equal(upload.status,201);const metadata=await upload.json();
  const group=await f.app.groups.read(id);group.document.sessions[0].attachments.push(metadata);const saved=await f.app.groups.save(id,group);
  const preview=await f.request(`/api/groups/${id}/attachments/${metadata.id}?preview=true`);assert.equal(preview.headers.get('content-type'),'application/pdf');assert.deepEqual(Buffer.from(await preview.arrayBuffer()),bytes);
  const download=await f.request(`/api/groups/${id}/attachments/${metadata.id}`);assert.match(download.headers.get('content-disposition'),/^attachment/);
  saved.document.sessions[0].attachments=[];await f.app.groups.save(id,saved);assert.equal((await f.request(`/api/groups/${id}/attachments/${metadata.id}`)).status,200);
  assert.equal((await fs.stat(path.join(f.root,'.notebook/group-attachments',id,metadata.id))).mode&0o777,0o600);
  assert.deepEqual(await fs.readdir(path.join(f.root,'collections')),[]);
});
test('attachments reject unsafe names, sizes, missing files, symlinks and cross-group references',async t=>{
  const f=await fixture(t),s=await withSession(f),id=f.group.document.id;
  const stream=chunks=>Object.assign(Readable.from(chunks),{headers:{}});
  for(const name of ['../slides.pdf','script.html','bad\n.pdf','slides\\bad.pdf'])await assert.rejects(f.app.groups.upload(id,stream([Buffer.from('x')]),name),{status:400});
  await assert.rejects(f.app.groups.upload(id,Object.assign(stream([]),{headers:{'content-length':String(attachmentLimit+1)}}),'large.pdf'),{status:413});
  await assert.rejects(f.app.groups.upload(id,stream([{length:attachmentLimit+1}]),'stream.pdf'),{status:413});
  await assert.rejects(f.app.groups.upload(id,stream([]),'empty.pdf'),{status:400});
  const a=await f.app.groups.upload(id,stream([Buffer.from('PowerPoint')]),'slides.pptx');
  const other=await f.app.groups.create({name:'Second',memberIds:f.memberIds,leaderId:f.memberIds[0]});other.document.sessions.push({...newGroupSession(randomUUID(),other.document,'2026-10-20'),attachments:[a]});await assert.rejects(f.app.groups.save(other.document.id,other),{code:'ENOENT'});
  const file=path.join(f.root,'.notebook/group-attachments',id,a.id);await fs.rename(file,file+'.original');await fs.symlink(file+'.original',file);await assert.rejects(f.app.groups.attachment(id,a.id),{status:400});
  await assert.rejects(f.app.groups.read('../escape'),{status:400});
});

test('Group category becomes available without a booking and timezone suggestions stay inside the selected local day',async t=>{
  const f=await fixture(t),s=await withSession(f);
  assert.equal((await f.app.daily.read()).document.categories.find(c=>c.id===groupCategoryId).name,'Group');
  const e=eventFor(f,s,{start:'2026-10-21T00:00:00.000Z',timeZone:'America/New_York'});
  const checked=await(await f.request(`/api/groups/${e.groupId}/check`,'POST',{event:e})).json();
  assert.equal(checked.timeZone,'America/New_York');
  assert.ok(checked.slots.every(slot=>slot.start>=schoolInstant('2026-10-20','08:30','America/New_York')&&slot.end<=schoolInstant('2026-10-20','21:30','America/New_York')));
});

test('Group version history retains twenty revisions and preserves malformed on-disk documents',async t=>{
  const f=await fixture(t);let item=f.group;
  for(let n=0;n<22;n++){item.document.name=`Synthetic group ${n}`;item=await f.app.groups.save(item.document.id,item);}
  assert.equal((await fs.readdir(path.join(f.root,'.notebook/group-versions',item.document.id))).length,20);
  const file=path.join(f.root,'.notebook/groups',`${item.document.id}.json`);await fs.writeFile(file,'{broken');await assert.rejects(f.app.groups.read(item.document.id),{status:400});assert.equal(await fs.readFile(file,'utf8'),'{broken');
});
