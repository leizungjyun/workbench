import { renderTimetableWeek } from './timetable-view.js';
import { validateTimetables, validateStudentTimetables, mergeById, schoolPeriods } from '../timetable-model.js';
import { localDate, shiftDate } from '../daily-model.js';
import './timetables.css';
export const node=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=text;n.className=cls;return n;};
const button=(label,action)=>{const b=node('button',label);b.type='button';b.onclick=()=>Promise.resolve().then(action).catch(e=>alert(e.message));return b;};
const select=(label,options,value,change)=>{const l=node('label'),s=node('select');s.setAttribute('aria-label',label);for(const [id,name] of options){const o=node('option',name);o.value=id;s.append(o);}s.value=value;l.append(node('span',label),s);s.onchange=()=>change(s.value);return l;};
const input=(label,value,change,type='text')=>{const l=node('label'),i=node('input');i.type=type;i.value=value??'';i.setAttribute('aria-label',label);i.oninput=()=>change(i.value);l.append(node('span',label),i);return l;};
const download=(data,name)=>{const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=node('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
const monday=day=>shiftDate(day,-((new Date(`${day}T12:00Z`).getUTCDay()+6)%7));
export function timetablePanel({academic,students,student,api,saveStudent,readOnly=false,refresh}) {
  if(student?.profile.coursesCompleted)return document.createDocumentFragment();
  students=students.filter(s=>!s.profile.coursesCompleted);
  const panel=node('section','','timetable-panel'); panel.setAttribute('aria-label','Student timetables');
  let showWeekends=false;
  let week=monday(localDate()),school=student?.profile.schoolId||'',person=student?.id||'',semester='';
  function render(){
    panel.replaceChildren(node('h2',student?'Semester timetable':'Timetable dashboard'));
    const controls=node('div','','timetable-controls');
    if(!student) controls.append(select('School filter',[['','All schools'],...academic.document.schools.map(s=>[s.id,s.id])],school,v=>{school=v;person='';semester='';render();}),select('Student filter',[['','All students'],...students.filter(s=>!school||s.profile.schoolId===school).map(s=>[s.id,s.profile.name])],person,v=>{person=v;render();}));
    const terms=academic.document.semesters.filter(s=>!school||s.schoolId===school);
    controls.append(select('Semester',[['','By date'],...terms.map(s=>[s.id,`${s.schoolId} · ${s.name}`])],semester,v=>{semester=v;const s=terms.find(s=>s.id===v);if(s&&(week<s.startDate||week>s.endDate))week=monday(s.startDate);render();}),button('Previous week',()=>{week=shiftDate(week,-7);render();}),input('Timetable week',week,v=>{if(/^\d{4}-\d{2}-\d{2}$/.test(v)){week=monday(v);render();}},'date'),button('Next week',()=>{week=shiftDate(week,7);render();}));
    controls.append(button('Export school calendars',()=>download(academic.document,'school-calendars.json')));
    controls.append(button('School calendars',()=>academicEditor(academic,api,refresh)));
    if(student){controls.append(button('Export timetable',()=>download({schoolId:student.profile.schoolId||'',timetables:student.timetables||[]},`timetable-${student.id}.json`)));if(!readOnly)controls.append(button('Edit / import courses',()=>courseEditor(student,academic,saveStudent,refresh)));}
    panel.append(controls);
    const people=student?[student]:students.filter(s=>!s.archived&&(!school||s.profile.schoolId===school)&&(!person||s.id===person));
    const weekendToggle=button(showWeekends?'Hide empty weekends':'Show weekends',()=>{showWeekends=!showWeekends;render();});
    weekendToggle.setAttribute('aria-pressed',String(showWeekends));controls.append(weekendToggle);
    panel.append(renderTimetableWeek({people,academic:academic.document,terms,week,semesterId:semester,showWeekends}));
  }render();return panel;
}
function editor(title,key,initial,revision,validate,apply) {
  const dialog=node('dialog','','timetable-dialog'),error=node('p','','timetable-warning'),body=node('div'),actions=node('div','','timetable-controls');dialog.setAttribute('aria-label',title);dialog.append(node('h2',title));
  let draft=structuredClone(initial),reviewed='',saving=false,stale=false;
  try{const old=JSON.parse(localStorage.getItem(key));if(old){draft=old.document; stale=old.revision!==revision; error.textContent=old.revision!==revision?'Recovered draft; disk changed. Export this draft or reload disk before applying.':'Recovered timetable draft.';}}catch{error.textContent='Unreadable draft; disk data preserved.';}
  const persist=()=>{reviewed='';preview.textContent='';localStorage.setItem(key,JSON.stringify({document:draft,revision:stale?'stale':revision}));};
  const preview=node('pre','','timetable-review');
  const json=node('textarea');json.setAttribute('aria-label','Import JSON');json.placeholder='Paste structured JSON to import';
  const file=node('input');file.type='file';file.accept='.json,application/json';file.setAttribute('aria-label','Import JSON file');file.onchange=async()=>{try{json.value=await file.files[0].text();}catch(e){error.textContent=e.message;}};
  const importButton=button('Load import preview',()=>{try{const incoming=importer(JSON.parse(json.value),draft);validate(incoming);draft=incoming;persist();draw();error.textContent='Imported draft. Review before applying.';}catch(e){error.textContent=e.message;}});let importer=(incoming)=>incoming;
  const review=button('Review changes',()=>{try{validate(draft);reviewed=JSON.stringify(draft);preview.textContent=JSON.stringify(draft,null,2);error.textContent='Review the data below, then apply.';}catch(e){error.textContent=e.message;}});
  const save=button('Apply reviewed changes',async()=>{if(saving)return;try{if(stale)throw new Error('The recovered draft is stale. Export it, reload disk, then import and review the changes.');if(!reviewed||reviewed!==JSON.stringify(draft))throw new Error('Review changes before applying.');validate(draft);saving=true;dialog.querySelectorAll('button,input,select,textarea').forEach(n=>n.disabled=true);await apply(draft,revision);localStorage.removeItem(key);dialog.close();}catch(e){error.textContent=e.message;}finally{saving=false;dialog.querySelectorAll('button,input,select,textarea').forEach(n=>n.disabled=false);}});
  actions.append(review,save,button('Export draft',()=>download(draft,'timetable-draft.json')),button('Reload disk / discard draft',()=>{draft=structuredClone(initial);stale=false;localStorage.removeItem(key);persist();draw();error.textContent='Loaded the disk version captured when this editor opened.';}),button('Close',()=>dialog.close()));
  dialog.append(body,json,file,importButton,error,preview,actions);dialog.addEventListener('cancel',e=>{if(saving)e.preventDefault();});dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);
  let draw=()=>{};return {dialog,body,get draft(){return draft;},persist,setDraw(fn){draw=fn;draw();},setImporter(fn){importer=fn;}};
}
function courseEditor(student,academic,save,refresh){
  let term=academic.document.semesters.find(s=>s.schoolId===student.profile.schoolId)?.id||'';
  const e=editor('Edit semester courses',`timetable-courses:${student.id}`,student.timetables||[],JSON.stringify(student.timetables||[]),draft=>{validateStudentTimetables(draft);for(const t of draft){const term=academic.document.semesters.find(s=>s.id===t.semesterId);if(!term)throw new Error('Unknown course semester.');for(const c of t.courses.filter(c=>c.status==='confirmed'))if(c.periods.some(n=>!term.periods.some(p=>p.number===n)))throw new Error('Configure every confirmed course period in its school calendar.');}},async draft=>{await save(draft);await refresh();});
  e.setImporter((v,current)=>{const incoming=Array.isArray(v)?v:v.timetables||v.student?.timetables||[v];validateStudentTimetables(incoming);return mergeById(current,incoming.map(t=>({...t,courses:mergeById(current.find(old=>old.semesterId===t.semesterId)?.courses||[],t.courses)})),'semesterId');});
  e.setDraw(()=>{const b=e.body;b.replaceChildren(select('Course semester',academic.document.semesters.filter(s=>s.schoolId===student.profile.schoolId).map(s=>[s.id,s.name]),term,v=>{term=v;e.setDraw(draw); }));drawRows();});
  function draw(){e.body.replaceChildren(select('Course semester',academic.document.semesters.filter(s=>s.schoolId===student.profile.schoolId).map(s=>[s.id,s.name]),term,v=>{term=v;draw();}));drawRows();}
  function drawRows(){if(!term){e.body.append(node('p','Assign a school and configure its semester first.'));return;}const t=e.draft.find(t=>t.semesterId===term);const courses=t?.courses||[];
    for(const c of courses){const row=node('fieldset');row.append(node('legend',c.name||'New course'));const update=(k,v)=>{c[k]=v;e.persist();};for(const [k,label]of [['name','Course name'],['code','Course code'],['location','Course location'],['notes','Review notes']])row.append(input(label,c[k],v=>update(k,v)));
      row.append(input('Weekday (1–7)',c.weekday,v=>update('weekday',Number(v)),'number'),input('Periods (comma separated)',c.periods.join(','),v=>update('periods',v?v.split(',').map(Number):[])),input('Teaching weeks (comma separated)',c.weeks.join(','),v=>update('weeks',v?v.split(',').map(Number):[])),select('Week parity',[['all','All'],['odd','Odd'],['even','Even']],c.parity,v=>update('parity',v)),select('Review status',[['confirmed','Confirmed'],['pending','Pending review']],c.status,v=>update('status',v)),button('Remove course',()=>{t.courses=t.courses.filter(x=>x.id!==c.id);e.persist();draw();}));e.body.append(row);}
    e.body.append(button('Add course',()=>{let t=e.draft.find(t=>t.semesterId===term);if(!t){t={semesterId:term,courses:[]};e.draft.push(t);}t.courses.push({id:crypto.randomUUID(),name:'New course',code:'',location:'',notes:'',weekday:1,periods:[],weeks:[],parity:'all',status:'pending'});e.persist();draw();}));
  }e.dialog.showModal();
}
function academicEditor(academic,api,refresh){
  let term=academic.document.semesters[0]?.id||'';
  const e=editor('School calendars','timetable-academic-draft',academic.document,academic.revision,validateTimetables,async(draft,revision)=>{await api('/api/timetables','PUT',{document:draft,revision});await refresh();});
  e.setImporter((v,current)=>{const d=v.document||v;validateTimetables({...current,schools:d.schools||current.schools,semesters:d.semesters||[]});return {...current,schools:mergeById(current.schools,d.schools||[]),semesters:mergeById(current.semesters,d.semesters||[])};});
  function draw(){const b=e.body,d=e.draft;b.replaceChildren(select('Edit semester',d.semesters.map(s=>[s.id,`${s.schoolId} · ${s.name}`]),term,v=>{term=v;draw();}),button('Add semester',()=>{const school=d.schools[0]?.id||'SUAT',id=crypto.randomUUID();d.semesters.push({id,schoolId:school,name:'New semester',timeZone:'Asia/Shanghai',startDate:localDate(),endDate:localDate(),teachingEndDate:localDate(),weekOneMonday:monday(localDate()),periods:schoolPeriods(d.schools.find(s=>s.id===school)),holidays:[],overrides:[],annotations:[]});term=id;e.persist();draw();}));
    const s=d.semesters.find(s=>s.id===term);if(!s)return;b.append(select('Semester school',d.schools.map(s=>[s.id,s.id]),s.schoolId,v=>{s.schoolId=v;if(!s.periods.length)s.periods=schoolPeriods(d.schools.find(s=>s.id===v));e.persist();draw();}));for(const[k,label,type]of [['name','Semester name','text'],['timeZone','School time zone','text'],['startDate','Semester start','date'],['teachingEndDate','Teaching ends','date'],['endDate','Semester end','date'],['weekOneMonday','Week one Monday','date']])b.append(input(label,s[k],v=>{s[k]=v;e.persist();},type));
    if(schoolPeriods(d.schools.find(school=>school.id===s.schoolId)).length)b.append(button('Use school bell times',()=>{s.periods=schoolPeriods(d.schools.find(school=>school.id===s.schoolId));e.persist();draw();}));
    for(const[key,label,fields,empty]of [['periods','Period',[['number','Period number','number'],['start','Period start','time'],['end','Period end','time']],{number:1,start:'08:30',end:'09:10'}],['holidays','Holiday',[['name','Holiday name','text'],['start','Holiday start','date'],['end','Holiday end','date']],{name:'Holiday',start:localDate(),end:localDate()}],['overrides','Teaching override',[['date','Override date','date'],['weekday','Override weekday','number'],['parity','Override parity','text']],{date:localDate(),weekday:1,parity:'all'}],['annotations','Annotation',[['name','Annotation name','text'],['start','Annotation start','date'],['end','Annotation end','date']],{name:'Annotation',start:localDate(),end:localDate()}]]){
      b.append(node('h3',`${label}s`));for(const item of s[key]){const row=node('div','','timetable-controls');for(const[k,l,t]of fields)row.append(input(l,item[k],v=>{item[k]=t==='number'?Number(v):v;e.persist();},t));row.append(button(`Remove ${label.toLowerCase()}`,()=>{s[key]=s[key].filter(x=>x!==item);e.persist();draw();}));b.append(row);}b.append(button(`Add ${label.toLowerCase()}`,()=>{s[key].push({...empty});e.persist();draw();}));}
  }e.setDraw(draw);e.dialog.showModal();
}
