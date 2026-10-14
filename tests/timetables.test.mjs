import { importTimetableFixture } from '../scripts/import-timetable.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';
import { newStudent, validateStudent } from '../student-model.js';
import { newTimetables, validateTimetables, validateStudentTimetables, mergeById, classesOnDate, teachingDay, checkConversation as modelCheckConversation, schoolInstant } from '../timetable-model.js';
import { newDaily, updateTask, stateAt } from '../daily-model.js';
import { syncCalendarTasks } from '../daily-calendar.js';
const fixture=JSON.parse(await fs.readFile(new URL('./fixtures/timetable.json',import.meta.url),'utf8'));
const academic=()=>({...newTimetables(randomUUID()),semesters:structuredClone(fixture.semesters)});
const student=()=>({...newStudent(randomUUID(),'Example Student'),profile:{...newStudent(randomUUID(),'Example Student').profile,schoolId:'SUAT'},timetables:structuredClone(fixture.student.timetables)});
const checkConversation = (event, student, academic, events, now = Date.parse('2026-08-01T00:00:00Z')) => modelCheckConversation(event, student, academic, events, now);
const conversation=(s,date='2026-10-12',time='10:30',durationMinutes=30)=>({id:randomUUID(),title:'Conversation',studentId:s.id,start:schoolInstant(date,time,'Asia/Shanghai'),durationMinutes,timeZone:'Asia/Shanghai'});
test('legacy students remain valid; timetable imports reject malformed dates, times, courses and duplicates',()=>{
  const legacy=newStudent(randomUUID(),'Legacy');delete legacy.profile.schoolId;assert.doesNotThrow(()=>validateStudent(legacy));
  assert.doesNotThrow(()=>validateTimetables(academic()));assert.doesNotThrow(()=>validateStudent(student()));
  for(const mutate of [d=>d.semesters[0].weekOneMonday='2026-08-25',d=>d.semesters[0].timeZone='',d=>d.semesters[0].periods[0].end='07:00',d=>d.semesters[0].startDate='2026-02-30',d=>d.semesters.push(d.semesters[0])]){const d=academic();mutate(d);assert.throws(()=>validateTimetables(d));}
  const courses=student().timetables;courses[0].courses[0].weeks=[1,1];assert.throws(()=>validateStudentTimetables(courses));
});
test('courses respect period spans, week ranges, holidays and chronological makeup-day overrides',()=>{
  const a=academic(),s=student(),sem=a.semesters[0];
  const monday=classesOnDate(s,a,'2026-10-12');assert.equal(monday.classes.length,3);assert.equal(monday.incomplete,false);assert.equal(monday.classes[0].localStart,'10:15');assert.equal(monday.classes[0].localEnd,'11:40');
  assert.equal(classesOnDate(s,a,'2026-10-06').classes.length,0);assert.equal(classesOnDate(s,a,'2026-09-25').classes.length,0);
  assert.equal(teachingDay(sem,'2026-09-20').weekday,3);assert.equal(teachingDay(sem,'2026-09-20').week,4);assert.equal(teachingDay(sem,'2026-09-20').parity,'odd');assert.equal(classesOnDate(s,a,'2026-09-20').classes.length,3);
  assert.equal(teachingDay(sem,'2026-10-10').week,7);assert.equal(teachingDay(sem,'2026-10-10').parity,'even');assert.equal(classesOnDate(s,a,'2026-10-10').classes[0].name,'Example numerics');
  assert.equal(teachingDay(sem,'2026-12-14').parity,'odd');assert.equal(teachingDay(sem,'2026-12-15').weekday,2);
  assert.equal(classesOnDate(s,a,'2026-12-21').classes.length,0);assert.equal(classesOnDate(s,a,'2027-01-04').incomplete,true);
  const noHoliday=structuredClone(a);noHoliday.semesters[0].holidays=[];assert.equal(classesOnDate(s,noHoliday,'2026-10-05').classes.length,0);
});
test('semester identity isolates imports and parity filters use override parity',()=>{
  const a=academic(),s=student();const next={...structuredClone(a.semesters[0]),id:'next',startDate:'2027-02-01',weekOneMonday:'2027-02-01',teachingEndDate:'2027-06-01',endDate:'2027-06-30'};a.semesters=mergeById(a.semesters,[next]);a.semesters=mergeById(a.semesters,fixture.semesters);assert.equal(a.semesters.length,2);assert.equal(classesOnDate(s,a,'2027-02-01').incomplete,true);
  const c=s.timetables[0].courses.find(c=>c.id==='ai-3');c.parity='odd';assert.equal(classesOnDate(s,a,'2026-09-20').classes.some(c=>c.id==='ai-3'),true);assert.equal(classesOnDate(s,a,'2026-09-16').classes.some(c=>c.id==='ai-3'),false);
});
test('conflicts include breaks within classes, full intervals, other events, adjacency and matching-duration suggestions',()=>{
  const s=student(),a=academic(),event=conversation(s);let checked=checkConversation(event,s,a,[]);assert.equal(checked.conflicts[0].title,'Example computation');assert.equal(checked.incomplete,false);assert.ok(checked.slots.every(slot=>Date.parse(slot.end)-Date.parse(slot.start)===1800000));
  assert.equal(checkConversation(conversation(s,'2026-10-12','10:55',5),s,a,[]).conflicts.length,1);
  assert.equal(checkConversation(conversation(s,'2026-10-12','11:40',30),s,a,[]).conflicts.length,0);
  const other=conversation(s,'2026-10-12','12:00');assert.equal(checkConversation(other,s,a,[other]).conflicts.length,0);
  assert.equal(checkConversation(conversation(s,'2026-10-12','11:55'),s,a,[other]).conflicts[0].type,'event');
  const cross=conversation(s,'2026-10-11','23:00',720);assert.equal(checkConversation(cross,s,a,[]).conflicts.length,1);
  assert.equal(schoolInstant('2026-10-12','10:15','Asia/Shanghai'),'2026-10-12T02:15:00.000Z');assert.throws(()=>schoolInstant('2026-03-08','02:30','America/New_York'));
});
test('Calendar student links reconcile into Daily without duplicating tasks or losing completion and notes',()=>{
  const s=student(),e=conversation(s),d=newDaily(randomUUID());syncCalendarTasks(d,{events:[e]},new Date('2026-10-12T00:00Z'));const task=d.tasks[0];assert.equal(task.versions[0].studentId,s.id);
  updateTask(task,'2026-10-12',{details:'Keep notes',status:'completed',subtasks:[{id:randomUUID(),text:'Prepare',done:true}]});e.start=schoolInstant('2026-10-13','12:00','Asia/Shanghai');syncCalendarTasks(d,{events:[e]},new Date('2026-10-12T00:00Z'));assert.equal(d.tasks.length,1);assert.equal(stateAt(task,'2026-10-12').status,'completed');assert.equal(stateAt(task,'2026-10-12').details,'Keep notes');assert.equal(stateAt(task,'2026-10-12').subtasks.length,1);
});
test('academic store backups, revision protection and fresh conflict acknowledgement through API',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-timetables-')),app=await createApp(root);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await app.terminals.close();await app.kernels.close();await new Promise(r=>{app.server.close(r);app.server.closeAllConnections();});await fs.rm(root,{recursive:true,force:true});});
  const req=async(route,method='GET',body)=>{const r=await fetch(base+route,{method,headers:{origin:base,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
  let academic=await app.timetables.read();academic.document.semesters=fixture.semesters;const before=structuredClone(academic);academic=await app.timetables.save(academic);await assert.rejects(app.timetables.save(before),{status:409});assert.equal((await fs.readdir(path.join(root,'.notebook/timetables/versions'))).length,1);
  const created=await app.students.create({name:'Example Student'});created.document.profile.schoolId='SUAT';created.document.timetables=fixture.student.timetables;const saved=await app.students.save(created.document.id,created);
  const event=conversation(saved.document);let calendar=await app.calendar.read();calendar.document.events.push(event);
  assert.equal((await req('/api/calendar','PUT',calendar)).status,409);
  let checked=await req('/api/timetables/check','POST',{event});assert.equal(checked.data.conflicts.length,1);
  academic.document.semesters[0].name+=' Updated';await app.timetables.save(academic);
  assert.equal((await req('/api/calendar','PUT',{...calendar,acknowledgements:{[event.id]:checked.data.acknowledgement}})).status,409);
  checked=await req('/api/timetables/check','POST',{event});assert.equal((await req('/api/calendar','PUT',{...calendar,acknowledgements:{[event.id]:checked.data.acknowledgement}})).status,200);
  assert.equal((await req('/api/timetables/export')).status,200);const daily=await req('/api/daily');assert.equal(daily.data.document.tasks[0].versions[0].studentId,created.document.id);
});

test('initial fixture import preserves unrelated student content and is idempotent', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-import-'));
  const app = await createApp(root);
  t.after(async () => { await app.terminals.close(); await app.kernels.close(); await fs.rm(root, { recursive: true, force: true }); });
  const initial = await app.students.create({ name: 'Example Student' });
  initial.document.profile.researchAreas = 'Keep research';
  await app.students.save(initial.document.id, initial);
  const result = await importTimetableFixture(app.students, app.timetables, fixture);
  assert.equal(result.studentId, initial.document.id);
  assert.equal(result.studentChanged, true);
  const stored = await app.students.read(initial.document.id);
  assert.equal(stored.document.profile.researchAreas, 'Keep research');
  assert.equal(stored.document.timetables[0].courses.length, 8);
  const repeated = await importTimetableFixture(app.students, app.timetables, fixture);
  assert.equal(repeated.studentChanged, false);
  assert.equal(repeated.academicChanged, false);
  assert.equal((await app.students.read(initial.document.id)).revision, stored.revision);
});

test('confirmed Wednesday RL and Thursday discussion use weeks 1–6, 8–17 and detect their exact busy times', () => {
  const s = student(), a = academic(), courses = s.timetables[0].courses;
  const rl = courses.find(c => c.id === 'rl-3-pending');
  const discussion = courses.find(c => c.id === 'theory-discussion-4-pending');
  assert.equal(courses.filter(c => c.status === 'pending').length, 0);
  assert.deepEqual(rl.weeks, courses.find(c => c.id === 'rl-2').weeks);
  assert.deepEqual(rl.periods, [11, 12]);
  assert.deepEqual(discussion.periods, [4]);
  assert.deepEqual(discussion.weeks, rl.weeks);
  for (const day of ['2026-08-26', '2026-09-30', '2026-10-14', '2026-12-16']) {
    const match = classesOnDate(s, a, day).classes.find(c => c.id === rl.id);
    assert.equal(match.localStart, '20:00'); assert.equal(match.localEnd, '21:25');
  }
  for (const day of ['2026-08-27', '2026-10-15', '2026-12-17']) {
    const match = classesOnDate(s, a, day).classes.find(c => c.id === discussion.id);
    assert.equal(match.localStart, '11:00'); assert.equal(match.localEnd, '11:40');
  }
  const withoutHolidays = structuredClone(a); withoutHolidays.semesters[0].holidays = [];
  assert.equal(classesOnDate(s, withoutHolidays, '2026-10-07').classes.some(c => c.id === rl.id), false);
  assert.equal(classesOnDate(s, withoutHolidays, '2026-10-08').classes.some(c => c.id === discussion.id), false);
  assert.equal(checkConversation(conversation(s, '2026-10-14', '20:15'), s, a, []).conflicts[0].title, 'Example learning');
  assert.equal(checkConversation(conversation(s, '2026-10-15', '11:10'), s, a, []).conflicts[0].title, discussion.name);
  assert.equal(checkConversation(conversation(s, '2026-10-15', '11:40'), s, a, []).conflicts.length, 0);
  assert.equal(classesOnDate(s, a, '2026-10-14').incomplete, false);
  rl.status = 'pending';
  assert.equal(classesOnDate(s, a, '2026-10-14').incomplete, true);
});

test('free windows span 08:30–21:30, include evenings and weekends, merge busy intervals and offer exact gap starts', () => {
  const s = student(), a = academic();
  const checked = checkConversation(conversation(s), s, a, []);
  const localTimes = values => values.map(slot => [slot.start, slot.end].map(time => new Date(time).toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' })));
  assert.deepEqual(localTimes(checked.freeWindows), [['08:30','10:15'],['11:40','15:15'],['16:40','18:30'],['19:55','21:30']]);
  assert.ok(checked.slots.length > 6);
  assert.ok(localTimes(checked.slots).some(([start,end]) => start === '11:40' && end === '12:10'));
  assert.deepEqual(localTimes(checked.slots).at(-1), ['21:00','21:30']);
  const weekend = checkConversation(conversation(s, '2026-10-17', '09:00'), s, a, []);
  assert.deepEqual(localTimes(weekend.freeWindows), [['08:30','21:30']]);
  assert.equal(weekend.slots.length, 51);
  const blocked = [conversation(s, '2026-10-17', '08:00', 120), conversation(s, '2026-10-17', '09:30', 60), conversation(s, '2026-10-17', '10:00', 10), conversation(s, '2026-10-17', '20:00', 120)];
  assert.deepEqual(localTimes(checkConversation(conversation(s, '2026-10-17', '11:00'), s, a, blocked).freeWindows), [['10:30','20:00']]);
  assert.ok(checkConversation(conversation(s, '2026-10-17', '09:00', 60), s, a, []).slots.every(slot => Date.parse(slot.end) - Date.parse(slot.start) === 3600000));
  const long = checkConversation(conversation(s, '2026-10-12', '09:00', 300), s, a, []);
  assert.equal(long.slots.length, 0); assert.equal(long.freeWindows.length, 4);
});

test('availability removes past dates, clips today to the next minute, and preserves conflict detection for historical intervals', () => {
  const s=student(),a=academic(),now=Date.parse('2026-10-12T06:22:20Z');
  const today=checkConversation(conversation(s),s,a,[],now);
  assert.equal(today.freeWindows[0].start,'2026-10-12T06:23:00.000Z');
  assert.ok(today.slots.every(slot=>Date.parse(slot.start)>=now));
  assert.ok(today.slots.some(slot=>slot.start==='2026-10-12T06:30:00.000Z'));
  assert.equal(today.conflicts[0].title,'Example computation');
  const past=checkConversation(conversation(s,'2026-10-11','12:00'),s,a,[],now);
  assert.deepEqual(past.slots,[]);assert.deepEqual(past.freeWindows,[]);assert.equal(past.past,true);
  const future=checkConversation(conversation(s,'2026-10-13','09:00'),s,a,[],now);
  assert.equal(future.freeWindows[0].start,'2026-10-13T00:30:00.000Z');
  assert.deepEqual(checkConversation(conversation(s),s,a,[],Date.parse('2026-10-12T13:31:00Z')).slots,[]);
});

test('Calendar cannot save mutually conflicting new draft conversations without confirmation', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-draft-conflicts-'));
  const app=await createApp(root,{now:()=>Date.parse('2026-10-12T00:00:00Z')});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await app.terminals.close();await app.kernels.close();await new Promise(resolve=>{app.server.close(resolve);app.server.closeAllConnections();});await fs.rm(root,{recursive:true,force:true});});
  let academic=await app.timetables.read();academic.document.semesters=fixture.semesters;await app.timetables.save(academic);
  const saved=await app.students.create({name:'Student'});saved.document.profile.schoolId='SUAT';saved.document.timetables=fixture.student.timetables;await app.students.save(saved.document.id,saved);
  const doc=await app.calendar.read(),first=conversation(saved.document,'2026-10-12','12:00'),second=conversation(saved.document,'2026-10-12','12:15');
  doc.document.events=[first,second];
  const post=async(route,method,body)=>fetch(base+route,{method,headers:{origin:base,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post('/api/calendar','PUT',doc)).status,409);
  const preview=await (await post('/api/timetables/check','POST',{event:first,draftEvents:[second]})).json();
  assert.equal(preview.conflicts[0].type,'event');
  assert.equal((await app.calendar.read()).document.events.length,0);
});

test('SYSU bell times match the supplied eleven-period timetable and validate school defaults', () => {
  const doc = newTimetables(randomUUID());
  const school = doc.schools.find(s => s.id === 'SYSU');
  assert.deepEqual(school.periods.map(p => [p.number, p.start, p.end]), [
    [1, '08:00', '08:45'], [2, '08:55', '09:40'], [3, '10:10', '10:55'],
    [4, '11:05', '11:50'], [5, '14:20', '15:05'], [6, '15:15', '16:00'],
    [7, '16:30', '17:15'], [8, '17:25', '18:10'], [9, '19:00', '19:45'],
    [10, '19:55', '20:40'], [11, '20:50', '21:35']
  ]);
  assert.deepEqual(doc.semesters, []);
  assert.doesNotThrow(() => validateTimetables(doc));
  const legacy = structuredClone(doc); delete legacy.schools[0].periods;
  assert.doesNotThrow(() => validateTimetables(legacy));
  school.periods[1].start = '08:40';
  assert.throws(() => validateTimetables(doc), /overlap/);
  assert.equal(newTimetables('other').schools[0].periods[1].start, '08:55');
});

test('completed coursework means no class conflicts or missing timetable warning, while calendar events still block slots', () => {
  const s = student(), a = academic(); s.profile.coursesCompleted = true;
  assert.doesNotThrow(() => validateStudent(s));
  assert.deepEqual(classesOnDate(s, a, '2026-10-12'), {classes:[], incomplete:false});
  s.timetables = []; a.semesters = [];
  const event = conversation(s), other = {...conversation(s), id:randomUUID()};
  const checked = checkConversation(event, s, a, [other]);
  assert.equal(checked.incomplete, false);
  assert.deepEqual(checked.conflicts.map(c=>c.type), ['event']);
  s.profile.coursesCompleted = 'true';
  assert.throws(() => validateStudent(s), /courses completed/);
});
