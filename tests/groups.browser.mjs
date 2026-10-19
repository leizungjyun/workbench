import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
import { newGroupSession, markdownNote } from '../group-model.js';
let root, app, base, students, ids;
const work = page => page.locator('#groups-workspace');
const saved = page => expect(work(page).getByRole('status')).toContainText('Saved to disk');
test.beforeEach(async ({ page }) => {
  root=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-group-ui-'));await fs.mkdir(path.join(root,'collections'));await fs.writeFile(path.join(root,'collections/Notebook.md'),'# Synthetic notebook');await fs.symlink(path.resolve('dist'),path.join(root,'dist'));
  app=await createApp(root,{now:()=>Date.parse('2026-10-10T00:00:00Z')});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${app.server.address().port}`;
  students=await Promise.all(['Ada Example','Grace Example','Lin Example'].map(name=>app.students.create({name})));ids=students.map(s=>s.document.id);
  await page.clock.install({time:new Date('2026-10-10T00:00:00Z')});await page.goto(base);await page.getByRole('button',{name:'Group',exact:true}).click();
});
test.afterEach(async({context})=>{for(const p of context.pages())await p.close();await app.terminals.close();await app.kernels.close();app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
async function create(page,name='Synthetic Lab'){
  await work(page).getByRole('button',{name:'Add group',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Add group',exact:true});await dialog.getByLabel('Group name',{exact:true}).fill(name);
  for(const s of students)await dialog.getByRole('checkbox',{name:`Member: ${s.document.profile.name}`,exact:true}).check();await dialog.getByLabel('Student leader',{exact:true}).selectOption(ids[0]);await dialog.getByRole('button',{name:'Create group',exact:true}).click();await expect(page).toHaveURL(/view=group&id=/);await saved(page);
}
async function edit(page,section){const b=work(page).getByRole('button',{name:`Edit ${section}`,exact:true});if(await b.count())await b.click();}
async function disk(page){return(await app.groups.read(new URL(page.url()).searchParams.get('id'))).document;}
async function addSession(page){await edit(page,'session records');await work(page).getByRole('button',{name:'Add session',exact:true}).click();}

test('create groups, overlap membership, choose leader, participant defaults and manual type changes',async({page})=>{
  await create(page);await expect(work(page).locator('.group-profile')).toContainText('Student leader: Ada Example');await edit(page,'next session');const prep=work(page).locator('.student-preparation');
  for(const name of ['Ada Example','Grace Example','Lin Example'])await expect(prep.getByRole('button',{name:`Participant: ${name}`,exact:true})).toHaveAttribute('aria-pressed','true');
  await prep.getByLabel('Session type',{exact:true}).selectOption('Roundtable');await expect(prep.getByRole('button',{name:'Participant: Grace Example',exact:true})).toHaveAttribute('aria-pressed','false');
  await prep.getByRole('button',{name:'Participant: Grace Example',exact:true}).click();await prep.getByRole('button',{name:'Participant: Ada Example',exact:true}).click();
  page.once('dialog',d=>d.dismiss());await prep.getByLabel('Session type',{exact:true}).selectOption('Workshop');await expect(prep.getByLabel('Session type',{exact:true})).toHaveValue('Roundtable');
  page.once('dialog',d=>d.accept());await prep.getByLabel('Session type',{exact:true}).selectOption('Workshop');await saved(page);
  await prep.getByLabel('Session topic',{exact:true}).fill('Shared foundations');await saved(page);await prep.getByRole('button',{name:'Start session',exact:true}).click();
  await expect(work(page).locator('.student-session')).toHaveCount(1);await saved(page);const doc=await disk(page);expect(doc.sessions).toHaveLength(1);expect(doc.sessions[0].participantIds).toEqual(ids);expect(doc.preparation.title).toBe('');
  await work(page).getByRole('button',{name:'Edit group',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Edit group',exact:true});await dialog.getByRole('checkbox',{name:'Member: Ada Example',exact:true}).uncheck();await dialog.getByLabel('Student leader',{exact:true}).selectOption(ids[1]);await dialog.getByRole('button',{name:'Save group',exact:true}).click();await saved(page);expect((await disk(page)).sessions[0].participantIds).toEqual(ids);
  await work(page).getByRole('button',{name:'All groups',exact:true}).click();await create(page,'Second group');expect((await app.groups.list()).groups).toHaveLength(2);
});

test('Markdown notes, corrections, shared action owners and objectives persist; student pages and global search link to the group',async({page})=>{
  await create(page);await edit(page,'objectives');await work(page).getByRole('button',{name:'Add objective',exact:true}).click();await work(page).getByLabel('Objective title',{exact:true}).fill('Reproducible research');await work(page).getByLabel('Objective description',{exact:true}).fill('## Shared direction');await work(page).getByRole('button',{name:'Add milestone',exact:true}).click();await work(page).getByLabel('Milestone',{exact:true}).fill('Run baseline');
  await addSession(page);const record=work(page).locator('.student-session');await record.getByLabel('Session title',{exact:true}).fill('Novel baseline');await record.getByLabel('Discussion',{exact:true}).fill('## Discussion\n\n**Evidence** matters.');await record.getByLabel('Decisions',{exact:true}).fill('- Review results');await record.getByLabel('Correction',{exact:true}).fill('**Corrected** interpretation');await record.getByRole('checkbox',{name:'Reproducible research',exact:true}).check();await record.getByRole('button',{name:'Add action',exact:true}).click();await record.getByLabel('Action',{exact:true}).fill('Novel shared follow-up');await record.getByLabel('Owner',{exact:true}).selectOption('Students');await expect(record.locator('.group-assignee-picker')).not.toHaveAttribute('open','');await record.locator('.group-assignee-picker > summary').click();await record.getByRole('checkbox',{name:'Assign: Ada Example',exact:true}).click();await expect(record.getByRole('checkbox',{name:'Assign: Ada Example',exact:true})).toBeChecked();await record.getByRole('checkbox',{name:'Assign: Grace Example',exact:true}).check();await expect(record.locator('.group-assignee-picker > summary')).toHaveText('Assigned students: Ada Example, Grace Example');await record.locator('.group-assignee-picker > summary').click();await expect(record.getByRole('checkbox',{name:'Assign: Grace Example',exact:true})).not.toBeVisible();await saved(page);await record.getByLabel('Linked objective',{exact:true}).selectOption((await disk(page)).objectives[0].id);await saved(page);
  await work(page).getByRole('button',{name:'Done editing session records',exact:true}).click();await expect(record.locator('textarea')).toHaveCount(0);await expect(record.locator('.group-assignee-picker')).toHaveCount(0);await expect(record.locator('.group-action')).toContainText('Ada Example, Grace Example');await expect(record.locator('.group-action')).not.toContainText('Lin Example');await expect(record.locator('strong')).toHaveText(['Evidence','Corrected']);await expect(work(page).locator('.student-objective-history')).toContainText('Novel baseline');
  const groupId=(await disk(page)).id;await page.goto(base+`/?view=student&id=${ids[1]}`);await expect(page.locator('.student-group-overview')).toContainText('Synthetic Lab');await expect(page.locator('.student-group-overview')).toContainText('Novel shared follow-up');await page.locator('.student-group-overview').getByRole('link',{name:/Novel shared follow-up/}).click();await expect(page).toHaveURL(new RegExp(`view=group&id=${groupId}`));await expect(work(page).locator('.student-session')).toHaveAttribute('open','');
  await page.locator('#search-launch').click();await page.locator('#search-input').fill('Corrected');await expect(page.locator('#search-results')).toContainText('Group · Synthetic Lab');await page.locator('#search-results .result-snippet').filter({hasText:'Corrected'}).click();await expect(work(page).locator('.student-session')).toContainText('Corrected');
  await page.reload();await edit(page,'session records');await expect(work(page).getByLabel('Discussion',{exact:true})).toHaveValue('## Discussion\n\n**Evidence** matters.');
});

test('schedule one group session, edit its Calendar booking, complete and reopen Daily, then cancel without deleting notes',async({page})=>{
  await create(page);await edit(page,'next session');const prep=work(page).locator('.student-preparation');await prep.getByLabel('Session topic',{exact:true}).fill('Research planning');await prep.getByLabel('Next session date',{exact:true}).fill('2026-10-20');await prep.getByRole('button',{name:'Schedule session',exact:true}).click();let dialog=page.getByRole('dialog',{name:'Schedule group session',exact:true});await expect(dialog.getByLabel('Duration in minutes',{exact:true})).toHaveValue('60');await expect(dialog.getByLabel('Group availability',{exact:true})).toContainText('Ada Example: availability incomplete');await dialog.getByRole('button',{name:'Save booking',exact:true}).click();await expect(dialog).toHaveCount(0);
  const doc=await disk(page),event=(await app.calendar.read()).document.events[0];expect(doc.sessions).toHaveLength(1);expect(event.id).toBe(doc.sessions[0].id);expect(event.title).toBe('Synthetic Lab · Workshop · Research planning');
  await work(page).getByRole('button',{name:'Reschedule session',exact:true}).click();dialog=page.getByRole('dialog',{name:'Schedule group session',exact:true});await dialog.getByLabel('Starting time',{exact:true}).fill('2026-10-21T11:00');await dialog.getByRole('button',{name:'Save booking',exact:true}).click();await expect(dialog).toHaveCount(0);expect((await app.calendar.read()).document.events).toHaveLength(1);
  await page.goto(base+'/?view=calendar&date=2026-10-21');const calendar=page.locator('#calendar-workspace');await calendar.locator(`[data-event="${event.id}"]`).first().getByRole('button',{name:'Edit event',exact:true}).click();dialog=page.getByRole('dialog',{name:'Edit event',exact:true});await expect(dialog.locator('.conversation-preview')).toContainText('Group availability');await dialog.getByLabel('Location (optional)',{exact:true}).fill('Room 2');await dialog.getByRole('button',{name:'Save event',exact:true}).click();await expect(dialog).toHaveCount(0);expect((await app.calendar.read()).document.events[0].groupId).toBe(doc.id);
  await page.goto(base+'/?view=daily&date=2026-10-21');const daily=page.locator('#daily-workspace');await expect(daily.getByRole('link',{name:'Open group session',exact:true})).toHaveCount(2);await daily.getByRole('checkbox',{name:`Complete ${event.title}`,exact:true}).check();await expect(daily.getByRole('status')).toContainText('Saved to disk');await page.goto(base+'/?view=calendar&date=2026-10-21');await expect(calendar.locator(`[data-event="${event.id}"]`).first()).toHaveClass(/completed/);
  await page.goto(base+'/?view=daily&date=2026-10-21');await daily.getByRole('checkbox',{name:`Complete ${event.title}`,exact:true}).uncheck();await expect(daily.getByRole('status')).toContainText('Saved to disk');await page.goto(base+'/?view=calendar&date=2026-10-21');await expect(calendar.locator(`[data-event="${event.id}"]`).first()).not.toHaveClass(/completed/);page.once('dialog',d=>d.accept());await calendar.locator(`[data-event="${event.id}"]`).first().getByRole('button',{name:'Delete event',exact:true}).click();await expect(calendar.locator(`[data-event="${event.id}"]`)).toHaveCount(0);expect((await app.groups.read(doc.id)).document.sessions).toHaveLength(1);
});

test('conflict override is explicit and another tab changing bookings invalidates a reviewed acknowledgement',async({page})=>{
  await create(page);await addSession(page);const id=(await disk(page)).id;const calendar=await app.calendar.read();calendar.document.events.push({id:randomUUID(),title:'Busy supervisor',start:'2026-10-10T02:00:00.000Z',durationMinutes:60});await app.calendar.save(calendar);
  await work(page).getByRole('button',{name:'Schedule this session',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Schedule group session',exact:true});await expect(dialog.getByLabel('Group availability',{exact:true})).toContainText('Busy supervisor');await expect(dialog.locator('.schedule-conflict')).toHaveCount(1);await expect(dialog.locator('.schedule-conflict-source')).toHaveText('Your Calendar');await expect(dialog.getByLabel('Participant timetable status')).not.toContainText('class conflict ·');await dialog.getByRole('button',{name:'Save booking',exact:true}).click();await expect(dialog.getByRole('button',{name:'Save booking',exact:true})).toBeEnabled();await expect(dialog).toBeVisible();expect((await app.calendar.read()).document.events).toHaveLength(1);
  await dialog.getByLabel('Save despite these conflicts',{exact:true}).check();await page.route('**/api/calendar',async route=>{if(route.request().method()==='PUT'){const g=await app.groups.read(id);g.document.name='Changed elsewhere';await app.groups.save(id,g);}await route.continue();});await dialog.getByRole('button',{name:'Save booking',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('availability changed');expect((await app.calendar.read()).document.events).toHaveLength(1);await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
});

test('presentation files are optional, PDF previews and downloads work, detaching preserves the uploaded file',async({page})=>{
  await create(page);await addSession(page);const record=work(page).locator('.student-session'),bytes=Buffer.from('%PDF-1.4\nSynthetic slides\n%%EOF');await record.getByLabel('Attach presentations',{exact:true}).setInputFiles([{name:'Synthetic slides.pdf',mimeType:'application/pdf',buffer:bytes},{name:'Synthetic deck.pptx',mimeType:'application/vnd.openxmlformats-officedocument.presentationml.presentation',buffer:Buffer.from('Synthetic deck')}]);await expect(record.getByRole('link',{name:'Synthetic slides.pdf',exact:true})).toBeVisible();await expect(record.getByRole('link',{name:'Synthetic deck.pptx',exact:true})).toBeVisible();await saved(page);
  const previewHref=await record.getByRole('link',{name:'Preview PDF',exact:true}).getAttribute('href');const response=await page.request.get(base+previewHref);expect(response.headers()['content-type']).toBe('application/pdf');expect(await response.body()).toEqual(bytes);
  const downloadPromise=page.waitForEvent('download');await record.getByRole('link',{name:'Synthetic deck.pptx',exact:true}).click();expect((await downloadPromise).suggestedFilename()).toBe('Synthetic deck.pptx');
  const doc=await disk(page),file=doc.sessions[0].attachments[0];await record.getByRole('button',{name:'Detach presentation',exact:true}).first().click();await saved(page);expect((await page.request.get(`${base}/api/groups/${doc.id}/attachments/${file.id}`)).status()).toBe(200);
});

test('draft recovery, save errors, revision conflicts, duplicate tab locks, archive and restore',async({page,context})=>{
  await create(page);const url=page.url();await edit(page,'next session');await page.route('**/api/groups/*',async route=>{if(route.request().method()==='PUT')await route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Synthetic failure'})});else await route.continue();});await work(page).getByLabel('Session topic',{exact:true}).fill('Unsaved source');await expect(work(page).getByRole('status')).toContainText('Save failed');await work(page).getByRole('button',{name:'All groups',exact:true}).click();await expect(page).toHaveURL(url);page.once('dialog',d=>d.accept());await page.reload();await expect(work(page).getByRole('status')).toContainText('Save failed');await page.unroute('**/api/groups/*');await work(page).getByRole('button',{name:'Retry save',exact:true}).click();await saved(page);expect((await disk(page)).preparation.title).toBe('Unsaved source');
  const second=await context.newPage();await second.goto(url);await expect(work(second).getByRole('status')).toHaveText('Read-only');await expect(work(second).getByRole('button',{name:'Edit group',exact:true})).toBeDisabled();await second.close();
  await work(page).getByRole('button',{name:'Archive group',exact:true}).click();await saved(page);await work(page).getByRole('button',{name:'All groups',exact:true}).click();await expect(work(page).locator('.student-card')).toHaveCount(0);await work(page).getByLabel('Show groups',{exact:true}).selectOption('archived');await work(page).locator('.student-card').click();await work(page).getByRole('button',{name:'Restore group',exact:true}).click();await saved(page);expect((await disk(page)).archived).toBe(false);
});

test('Next Session and Session Records remain adjacent with tall objectives on desktop and mobile',async({page})=>{
  await create(page);const doc=await disk(page),item=await app.groups.read(doc.id);item.document.objectives=Array.from({length:8},(_,i)=>({id:randomUUID(),title:`Shared objective ${i}`,description:markdownNote('Research direction'),targetDate:'',status:'Planned',archived:false,milestones:[]}));item.document.sessions.push(newGroupSession(randomUUID(),doc,'2026-10-10'));await app.groups.save(doc.id,item);await page.reload();
  for(const width of [1440,390]){await page.setViewportSize({width,height:1000});const prep=await work(page).locator('.student-preparation').boundingBox(),history=await work(page).locator('.student-history').boundingBox(),goals=await work(page).locator('.student-objectives').boundingBox();expect(history.y-prep.y-prep.height).toBeCloseTo(24,0);if(width===390)expect(goals.y).toBeGreaterThan(history.y);else expect(goals.y+goals.height).toBeGreaterThan(history.y+history.height);}
});

test('group disk conflicts preserve local Markdown, compare, and overwrite only the reviewed revision',async({page})=>{
  await create(page);const id=(await disk(page)).id;await edit(page,'next session');
  await page.route('**/api/groups/'+id,async route=>{
    if(route.request().method()==='PUT'){const latest=await app.groups.read(id);latest.document.name='External group title';await app.groups.save(id,latest);}await route.continue();
  });
  await work(page).getByLabel('Next session agenda',{exact:true}).fill('## Local draft');await expect(work(page).getByRole('status')).toContainText('Conflict');await page.unroute('**/api/groups/'+id);
  await work(page).getByRole('button',{name:'Compare',exact:true}).click();const comparison=page.locator('.student-compare');await expect(comparison).toContainText('External group title');await expect(comparison).toContainText('Local draft');await comparison.getByRole('button',{name:'Close',exact:true}).click();
  await work(page).getByRole('button',{name:'Overwrite with draft',exact:true}).click();await expect(comparison).toBeVisible();page.once('dialog',d=>d.accept());await comparison.getByRole('button',{name:'Close',exact:true}).click();await saved(page);expect((await disk(page)).preparation.agenda.text).toBe('## Local draft');
});

test('roundtables schedule with a 30-minute default and keep only selected attendees',async({page})=>{
  await create(page);await edit(page,'next session');const prep=work(page).locator('.student-preparation');await prep.getByLabel('Session type',{exact:true}).selectOption('Roundtable');await prep.getByRole('button',{name:'Participant: Grace Example',exact:true}).click();await prep.getByRole('button',{name:'Participant: Ada Example',exact:true}).click();await saved(page);
  await prep.getByRole('button',{name:'Schedule session',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Schedule group session',exact:true});await expect(dialog.getByLabel('Duration in minutes',{exact:true})).toHaveValue('30');await expect(dialog.getByLabel('Group availability',{exact:true})).toContainText('Grace Example');await expect(dialog.getByLabel('Group availability',{exact:true})).not.toContainText('Ada Example');await dialog.getByRole('button',{name:'Save booking',exact:true}).click();await expect(dialog).toHaveCount(0);expect((await app.calendar.read()).document.events[0].participantIds).toEqual([ids[1]]);
});

test('unsaved booking fields recover after reload and Cancel clears the scheduling draft',async({page})=>{
  await create(page);await addSession(page);await saved(page);await work(page).getByRole('button',{name:'Schedule this session',exact:true}).click();let dialog=page.getByRole('dialog',{name:'Schedule group session',exact:true});await dialog.getByLabel('Starting time',{exact:true}).fill('2026-11-02T14:00');await dialog.getByLabel('Location',{exact:true}).fill('Room draft');page.once('dialog',d=>d.accept());await page.reload();dialog=page.getByRole('dialog',{name:'Schedule group session',exact:true});await expect(dialog.getByLabel('Starting time',{exact:true})).toHaveValue('2026-11-02T14:00');await expect(dialog.getByLabel('Location',{exact:true})).toHaveValue('Room draft');await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await page.reload();await expect(page.getByRole('dialog')).toHaveCount(0);expect((await app.calendar.read()).document.events).toHaveLength(0);
});

test('navigation waits for presentation upload and preserves the attached file',async({page})=>{
  await create(page);await addSession(page);await saved(page);let release;const held=new Promise(resolve=>{release=resolve;});await page.route('**/api/groups/*/attachments?*',async route=>{await held;await route.continue();});
  await work(page).getByLabel('Attach presentations',{exact:true}).setInputFiles({name:'Held slides.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 Synthetic')});await expect(work(page).getByRole('status')).toHaveText('Uploading presentations…');await page.getByRole('button',{name:'Daily',exact:true}).click();await expect(page.locator('#notice')).toContainText('Wait for presentation uploads');await expect(work(page)).toBeVisible();release();await expect(work(page).getByRole('link',{name:'Held slides.pdf',exact:true})).toBeVisible();await saved(page);expect((await disk(page)).sessions[0].attachments).toHaveLength(1);
});

test('changing the leader updates untouched Roundtable preparation without changing historical attendance',async({page})=>{
  await create(page);await edit(page,'next session');const prep=work(page).locator('.student-preparation');await prep.getByLabel('Session type',{exact:true}).selectOption('Roundtable');await saved(page);
  await work(page).getByRole('button',{name:'Edit group',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Edit group',exact:true});await dialog.getByLabel('Student leader',{exact:true}).selectOption(ids[1]);await dialog.getByRole('button',{name:'Save group',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(prep.getByRole('button',{name:'Participant: Grace Example',exact:true})).toHaveAttribute('aria-pressed','true');await expect(prep.getByRole('button',{name:'Participant: Ada Example',exact:true})).toHaveAttribute('aria-pressed','false');
});

test('member search filters names and metadata while keeping selections and leader choices', async ({ page }) => {
  const extra = await app.students.create({ name: '示例学生甲', profile: { schoolId: 'SYSU', program: 'PhD' } });
  await page.reload(); await page.getByRole('button', { name: 'Group', exact: true }).click();
  await work(page).getByRole('button', { name: 'Add group', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Add group', exact: true });
  await dialog.getByLabel('Group name', { exact: true }).fill('Searchable group');
  const search = dialog.getByRole('searchbox', { name: 'Search students', exact: true });
  await search.fill('  GRACE  ');
  await expect(dialog.locator('.group-member-option:visible')).toHaveCount(1);
  await dialog.getByRole('checkbox', { name: 'Member: Grace Example', exact: true }).check();
  await dialog.getByLabel('Student leader', { exact: true }).selectOption(ids[1]);
  await search.fill('sysu phd');
  await expect(dialog.locator('.group-member-option:visible')).toHaveCount(1);
  await dialog.getByRole('checkbox', { name: 'Member: 示例学生甲', exact: true }).check();
  await search.fill('no such student');
  await expect(dialog.locator('.group-member-option:visible')).toHaveCount(0);
  await expect(dialog.getByRole('status')).toHaveText('No students match your search.');
  await expect(dialog.locator('.group-members-heading')).toContainText('2 selected');
  await expect(dialog.getByLabel('Student leader', { exact: true })).toHaveValue(ids[1]);
  await search.press('Enter'); await expect(dialog).toBeVisible();
  await search.fill('示例'); await expect(dialog.getByRole('checkbox', { name: 'Member: 示例学生甲', exact: true })).toBeChecked();
  await search.fill(''); await expect(dialog.locator('.group-member-option:visible')).toHaveCount(4);
  await expect(dialog.getByRole('checkbox', { name: 'Member: Grace Example', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(dialog).toHaveCount(0); await saved(page);
  expect((await disk(page)).memberIds).toEqual([ids[1], extra.document.id]);
  await work(page).getByRole('button', { name: 'Edit group', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit group', exact: true });
  await dialog.getByRole('searchbox', { name: 'Search students', exact: true }).fill('Grace');
  await dialog.getByRole('checkbox', { name: 'Member: Grace Example', exact: true }).uncheck();
  await dialog.getByLabel('Student leader', { exact: true }).selectOption(extra.document.id);
  await dialog.getByRole('button', { name: 'Save group', exact: true }).click();
  await expect(dialog).toHaveCount(0); await saved(page);
  expect((await disk(page)).memberIds).toEqual([extra.document.id]);
});

test('a Group conflict is shown once and inline acknowledgment also works when rescheduling in Calendar', async ({ page }) => {
  await create(page); await addSession(page); await saved(page);
  const group = await disk(page), calendar = await app.calendar.read();
  calendar.document.events.push({ id: randomUUID(), title: 'Supervisor planning', start: '2026-10-10T02:00:00.000Z', durationMinutes: 60 });
  await app.calendar.save(calendar);
  await work(page).getByRole('button', { name: 'Schedule this session', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Schedule group session', exact: true });
  await expect(dialog.locator('.schedule-conflict')).toHaveCount(1);
  await expect(dialog.locator('.schedule-conflict-source')).toHaveText('Your Calendar');
  const ack = dialog.getByLabel('Save despite these conflicts', { exact: true });
  await ack.check(); await page.clock.runFor(15000); await expect(ack).toBeChecked();
  await dialog.getByLabel('Location', { exact: true }).fill('Room A'); await expect(ack).not.toBeChecked();
  await expect(ack).toBeEnabled(); await ack.check();
  await dialog.getByRole('button', { name: 'Save booking', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await page.goto(base + '/?view=calendar&date=2026-10-10');
  await page.locator(`#calendar-workspace [data-event="${group.sessions[0].id}"]`).first().getByRole('button', { name: 'Edit event', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.locator('.schedule-conflict')).toHaveCount(1);
  await expect(dialog.locator('.schedule-conflict-source')).toHaveText('Your Calendar');
  await dialog.getByLabel('Save despite these conflicts', { exact: true }).check();
  await dialog.getByRole('button', { name: 'Save event', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const booked = (await app.calendar.read()).document.events.find(e => e.groupId === group.id);
  expect(booked.id).toBe(group.sessions[0].id); expect(booked.location).toBe('Room A');
});
