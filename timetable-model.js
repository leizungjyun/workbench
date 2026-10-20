import { validDate, shiftDate } from './daily-model.js';
import { eventEnd } from './calendar-model.js';
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const obj = v => { if (!v || typeof v !== 'object' || Array.isArray(v)) fail('Expected a timetable object.'); };
const text = (v, label) => { if (typeof v !== 'string' || v.length > 1000) fail(`Invalid ${label}.`); };
const date = v => { if (!validDate(v)) fail('Invalid timetable date.'); };
const time = v => { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) fail('Invalid period time.'); };
const list = v => { if (!Array.isArray(v) || v.length > 10000) fail('Invalid timetable list.'); };
const unique = (items, key = 'id') => { const ids = new Set(); for (const item of items) { obj(item); if (key === 'number') { if (!Number.isInteger(item[key])) fail('Invalid period number.'); } else text(item[key], key); if (!item[key] || ids.has(item[key])) fail(`Duplicate or missing ${key}.`); ids.add(item[key]); } };
const SYSU_PERIODS = [
  { number: 1, start: '08:00', end: '08:45' },
  { number: 2, start: '08:55', end: '09:40' },
  { number: 3, start: '10:10', end: '10:55' },
  { number: 4, start: '11:05', end: '11:50' },
  { number: 5, start: '14:20', end: '15:05' },
  { number: 6, start: '15:15', end: '16:00' },
  { number: 7, start: '16:30', end: '17:15' },
  { number: 8, start: '17:25', end: '18:10' },
  { number: 9, start: '19:00', end: '19:45' },
  { number: 10, start: '19:55', end: '20:40' },
  { number: 11, start: '20:50', end: '21:35' },
];
export function schoolPeriods(school) { return structuredClone(school?.periods ?? (school?.id === 'SYSU' ? SYSU_PERIODS : [])); }
export function newTimetables(id) { return { schemaVersion: 1, id, schools: [{ id: 'SYSU', name: 'Sun Yat-sen University', periods: schoolPeriods({ id: 'SYSU' }) }, { id: 'SUAT', name: 'Shenzhen University of Advanced Technology' }], semesters: [] }; }
function validatePeriods(items) {
    list(items); unique(items, 'number');
    for (const p of items) { if (!Number.isInteger(p.number) || p.number < 1 || p.number > 99) fail('Invalid period number.'); time(p.start); time(p.end); if (p.end <= p.start) fail('A period must end after it starts.'); }
    const periods = [...items].sort((a,b) => Number(a.number)-Number(b.number));
    if (periods.some((p,i) => i && p.start < periods[i-1].end)) fail('Period times overlap or are out of order.');
}
export function validateTimetables(doc) {
  obj(doc); if (doc.schemaVersion !== 1) fail('Unsupported timetable version.'); text(doc.id, 'ID'); list(doc.schools); list(doc.semesters); unique(doc.schools); unique(doc.semesters);
  for (const s of doc.schools) { text(s.name, 'school name'); if (s.periods !== undefined) validatePeriods(s.periods); }
  for (const s of doc.semesters) {
    obj(s); text(s.name, 'semester name'); if (!doc.schools.some(x => x.id === s.schoolId)) fail('Unknown semester school.');
    text(s.timeZone, 'time zone'); if (!s.timeZone) fail('A semester time zone is required.');
    try { new Intl.DateTimeFormat('en', { timeZone: s.timeZone }); } catch { fail('Invalid semester time zone.'); }
    for (const key of ['startDate', 'endDate', 'teachingEndDate', 'weekOneMonday']) date(s[key]);
    if (s.startDate > s.teachingEndDate || s.teachingEndDate > s.endDate || new Date(`${s.weekOneMonday}T12:00Z`).getUTCDay() !== 1) fail('Invalid semester bounds or week-one Monday.');
    validatePeriods(s.periods);
    list(s.holidays); list(s.overrides); unique(s.overrides, 'date'); list(s.annotations);
    for (const h of s.holidays) { date(h.start); date(h.end); text(h.name, 'holiday name'); if (h.end < h.start) fail('Invalid holiday interval.'); }
    for (const o of s.overrides) { date(o.date); if (!Number.isInteger(o.weekday) || o.weekday < 1 || o.weekday > 7 || !['all','odd','even'].includes(o.parity)) fail('Invalid teaching override.'); }
    for (const a of s.annotations) { date(a.start); date(a.end); text(a.name, 'annotation'); if (a.end < a.start) fail('Invalid annotation interval.'); }
  }
  return doc;
}
export function validateStudentTimetables(items) {
  list(items); unique(items, 'semesterId');
  for (const t of items) {
    list(t.courses); unique(t.courses);
    for (const c of t.courses) {
      obj(c); for (const k of ['name', 'code', 'location', 'notes']) text(c[k], k);
      if (!c.name.trim() || !['confirmed','pending'].includes(c.status) || !['all','odd','even'].includes(c.parity)) fail('Invalid course name, status or parity.');
      if (!Number.isInteger(c.weekday) || c.weekday < 1 || c.weekday > 7) fail('Invalid course weekday.');
      for (const [key, max] of [['periods',99],['weeks',60]]) {
        list(c[key]); if (new Set(c[key]).size !== c[key].length || c[key].some(n => !Number.isInteger(n) || n < 1 || n > max)) fail(`Invalid course ${key}.`);
      }
      const ordered = [...c.periods].sort((a,b) => a-b);
      if (c.status === 'confirmed' && ordered.some((n,i) => i && n !== ordered[i-1]+1)) fail('Use a separate course entry for each consecutive period block.');
      if (c.status === 'confirmed' && (!c.periods.length || !c.weeks.length)) fail('Confirmed courses need periods and teaching weeks.');
    }
  }
  return items;
}
export function mergeById(existing, incoming, key = 'id') {
  const map = new Map(existing.map(item => [item[key], item])); for (const item of incoming) map.set(item[key], structuredClone(item)); return [...map.values()];
}
export function localParts(instant, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).formatToParts(new Date(instant)).map(p => [p.type,p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
export function schoolInstant(date, time, zone) {
  const target = Date.parse(`${date}T${time}:00Z`); let guess = target;
  for (let i=0;i<3;i++) { const p=localParts(guess,zone); const delta=target-Date.parse(`${p.date}T${p.time}:00Z`); guess+=delta; if (!delta) break; }
  const p=localParts(guess,zone); if (p.date !== date || p.time !== time) fail('This school-local time does not exist.'); return new Date(guess).toISOString();
}
export function teachingDay(semester, day) {
  if (day < semester.startDate || day > semester.teachingEndDate) return null;
  const override = semester.overrides.find(o => o.date === day);
  if (!override && semester.holidays.some(h => h.start <= day && day <= h.end)) return null;
  const week = Math.floor((Date.parse(`${day}T12:00Z`)-Date.parse(`${semester.weekOneMonday}T12:00Z`))/604800000)+1;
  const weekday = override?.weekday || ((new Date(`${day}T12:00Z`).getUTCDay()+6)%7+1);
  return { week, weekday, parity: override?.parity === 'all' || !override ? (week%2 ? 'odd':'even') : override.parity };
}
export function classesOnDate(student, academic, day, semesterId) {
  if (student.profile.coursesCompleted === true) return { classes: [], incomplete: false };
  const semesters=academic.semesters.filter(s => s.schoolId === student.profile.schoolId && (!semesterId || s.id===semesterId) && s.startDate<=day && day<=s.endDate);
  const classes=[]; let incomplete=!semesters.length;
  for (const s of semesters) {
    const t=student.timetables?.find(t=>t.semesterId===s.id); if (!t) { incomplete=true; continue; }
    if (t.courses.some(c=>c.status==='pending')) incomplete=true;
    const teaching=teachingDay(s,day); if (!teaching) continue;
    for (const c of t.courses.filter(c=>c.status==='confirmed' && c.weekday===teaching.weekday && c.weeks.includes(teaching.week) && (c.parity==='all'||c.parity===teaching.parity))) {
      const p=c.periods.map(n=>s.periods.find(p=>Number(p.number)===n)); if (p.some(x=>!x)) { incomplete=true; continue; }
      const start=p.map(x=>x.start).sort()[0], end=p.map(x=>x.end).sort().at(-1);
      classes.push({ ...c, studentId:student.id, studentName:student.profile.name, date:day, timeZone:s.timeZone, start:schoolInstant(day,start,s.timeZone), end:schoolInstant(day,end,s.timeZone), localStart:start, localEnd:end, semesterId:s.id });
    }
  }
  return { classes:classes.sort((a,b)=>a.start.localeCompare(b.start)), incomplete };
}
const overlaps=(a,b)=>a.start < b.end && b.start < a.end;
export function checkConversation(event, student, academic, events, now = Date.now()) {
  const end=eventEnd(event); if (!end) fail('Student conversations require a duration or end time.');
  const semester=academic.semesters.find(s=>s.schoolId===student.profile.schoolId && s.startDate<=localParts(event.start,s.timeZone).date && localParts(event.start,s.timeZone).date<=s.endDate);
  const zone=semester?.timeZone || 'Asia/Shanghai', first=localParts(event.start,zone).date, last=localParts(end,zone).date;
  let day=first, incomplete=false; const classes=[];
  for (let i=0;day<=last && i<370;i++,day=shiftDate(day,1)) { const r=classesOnDate(student,academic,day); classes.push(...r.classes); incomplete ||= r.incomplete; }
  if (day<=last) fail('Conversation interval is too long.');
  return checkAvailability(event, events, now, zone, classes, classesOnDate(student,academic,first), incomplete);
}
export function checkCalendarAvailability(event, events, now = Date.now()) {
  return checkAvailability(event, events, now, event.timeZone || 'Asia/Shanghai', [], { classes: [], incomplete: false }, false);
}
function checkAvailability(event, events, now, zone, classes, dateClasses, incomplete) {
  const end = eventEnd(event); if (!end) fail('Conversations require a duration or end time.');
  const first = localParts(event.start, zone).date;
  const interval={...event,end};
  const busy=events.filter(e=>e.id!==event.id).map(e=>({...e,end:eventEnd(e)||new Date(Date.parse(e.start)+1).toISOString()}));
  const conflicts=[...classes.filter(c=>overlaps(interval,c)).map(c=>({type:'class',title:c.name,start:c.start,end:c.end})),...busy.filter(e=>overlaps(interval,e)).map(e=>({type:'event',eventId:e.id,title:e.title,start:e.start,end:e.end}))];
  const duration=Date.parse(end)-Date.parse(event.start), slots=[], freeWindows=[];
  const dayOpening=Date.parse(schoolInstant(first,'08:30',zone));
  const opening=Math.max(dayOpening,Number(now));
  const closing=Date.parse(schoolInstant(first,'21:30',zone));
  const occupied=[...dateClasses.classes,...busy].map(item=>({
    start:Math.max(opening,Date.parse(item.start)), end:Math.min(closing,Date.parse(item.end))
  })).filter(item=>item.start<item.end).sort((a,b)=>a.start-b.start);
  let cursor=opening;
  const free=(start,end)=>{
    // The event form accepts whole minutes; do not offer a rounded time inside a conflict.
    start=Math.ceil(start/60000)*60000; end=Math.floor(end/60000)*60000;
    if(start<end) freeWindows.push({start:new Date(start).toISOString(),end:new Date(end).toISOString()});
  };
  for(const item of occupied){ if(item.start>cursor) free(cursor,item.start); cursor=Math.max(cursor,item.end); }
  if(cursor<closing) free(cursor,closing);
  for(const window of freeWindows){
    const from=Date.parse(window.start), until=Date.parse(window.end);
    // Include the exact start of every free window as well as each quarter-hour start.
    const starts=new Set([from]);
    for(let start=dayOpening+Math.ceil((from-dayOpening)/900000)*900000;start+duration<=until;start+=900000) starts.add(start);
    for(const start of [...starts].sort((a,b)=>a-b)) if(start+duration<=until) slots.push({start:new Date(start).toISOString(),end:new Date(start+duration).toISOString()});
  }
  return { conflicts, past:Date.parse(event.start)<Number(now), incomplete:incomplete||dateClasses.incomplete, classes:dateClasses.classes, slots, freeWindows, durationMinutes:duration/60000, timeZone:zone };
}
