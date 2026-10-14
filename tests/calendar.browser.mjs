import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';
let root, app, base;
const work = page => page.locator('#calendar-workspace');
const saved = page => expect(work(page).getByRole('status')).toContainText('Saved to disk');
const disk = async () => (await app.calendar.read()).document;
async function add(page, title='Meeting', start='2026-10-10T10:00') {
  await page.getByRole('button',{name:'Add event',exact:true}).click(); await work(page).getByLabel('Title',{exact:true}).fill(title); await page.getByLabel('Starting time',{exact:true}).fill(start);
  await page.getByRole('button',{name:'Save event',exact:true}).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await saved(page);
}
async function seed(title,start) {
  const saved = await app.calendar.read(); saved.document.events.push({id:randomUUID(),title,start}); await app.calendar.save(saved); return saved.document.events.at(-1);
}
test.use({timezoneId:'Asia/Shanghai'});
test.beforeEach(async ({page}) => {
  root=await fs.mkdtemp(path.join(os.tmpdir(),'fieldnotes-calendar-ui-')); await fs.mkdir(path.join(root,'collections')); await fs.writeFile(path.join(root,'collections/Notebook.md'),'# Notebook');
  await fs.symlink(path.resolve('dist'),path.join(root,'dist')); app=await createApp(root); await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve)); base=`http://127.0.0.1:${app.server.address().port}`;
  await page.clock.install({time:new Date('2026-10-10T00:00:00Z')}); await page.goto(base+'/?view=calendar&date=2026-10-10'); await expect(work(page).locator('h1')).toHaveText('Calendar');
});
test.afterEach(async ({context}) => { for(const page of context.pages()) await page.close(); await app.terminals.close(); await app.kernels.close(); await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }); await fs.rm(root,{recursive:true,force:true}); });
test('required-only creation, optional edits, export and reload',async ({page}) => {
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('button',{name:'Add event',exact:true}).click(); await page.getByRole('button',{name:'Save event',exact:true}).click(); expect((await disk()).events).toHaveLength(0); await expect(page.getByRole('dialog')).toBeVisible();
  await work(page).getByLabel('Title',{exact:true}).fill('Research meeting 中文'); await page.getByLabel('Starting time',{exact:true}).fill('2026-10-10T10:00'); await page.keyboard.press('ControlOrMeta+s'); await expect(page.getByRole('dialog')).toHaveCount(0); await saved(page);
  let event=(await disk()).events[0]; expect(event.start).toBe('2026-10-10T02:00:00.000Z'); expect(event.location).toBeUndefined(); expect(event.durationMinutes).toBeUndefined();
  await work(page).getByRole('button',{name:'Edit event',exact:true}).first().click(); await work(page).getByLabel('Title',{exact:true}).fill('Edited meeting'); await page.getByLabel('Location (optional)',{exact:true}).fill('Room A'); await page.getByLabel('Duration in minutes (optional)',{exact:true}).fill('45'); await page.getByRole('button',{name:'Save event',exact:true}).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await saved(page);
  await page.reload(); await expect(work(page)).toContainText('Room A'); await expect(work(page)).toContainText('Ends 10/10/2026, 10:45:00 AM'); await expect(work(page)).not.toContainText('45 minutes'); expect((await disk()).events[0].id).toBe(event.id);
  const download=page.waitForEvent('download'); await page.getByRole('button',{name:'Export JSON',exact:true}).click(); expect((await download).suggestedFilename()).toBe('workbench-calendar.json'); expect(errors).toEqual([]);
  await page.screenshot({path:'/tmp/fieldnotes-calendar.png',fullPage:true});
});
test('month navigation, selected-date events, agenda ordering, deletion and browser history',async ({page}) => {
  await add(page,'Later','2026-10-11T12:00'); await add(page,'Earlier','2026-10-10T09:00');
  await expect(work(page).locator('.calendar-agenda h3')).toHaveText(['Earlier','Later']); await expect(work(page).locator('.calendar-layout .calendar-event h3')).toHaveText(['Earlier']);
  await page.getByRole('button',{name:'2026-10-11, 1 events',exact:true}).click(); await expect(page).toHaveURL(/date=2026-10-11/); await expect(work(page).locator('.calendar-layout .calendar-event h3')).toHaveText(['Later']);
  await page.getByRole('button',{name:'Next month',exact:true}).click(); await expect(page.getByLabel('Calendar date',{exact:true})).toHaveValue('2026-11-01'); await page.goBack(); await expect(page.getByLabel('Calendar date',{exact:true})).toHaveValue('2026-10-11');
  page.once('dialog',d=>d.dismiss()); await work(page).getByRole('button',{name:'Delete event',exact:true}).first().click(); expect((await disk()).events).toHaveLength(2);
  page.once('dialog',d=>d.accept()); await work(page).getByRole('button',{name:'Delete event',exact:true}).first().click(); await saved(page); expect((await disk()).events).toHaveLength(1);
  await page.getByRole('button',{name:'Today',exact:true}).click(); await expect(page.getByLabel('Calendar date',{exact:true})).toHaveValue('2026-10-10');
});
test('save failure preserves form and draft, retry saves exactly one event',async ({page}) => {
  await page.route('**/api/calendar',route=>route.request().method()==='PUT'?route.fulfill({status:500,contentType:'application/json',body:'{"error":"Simulated failure"}'}):route.continue());
  await page.getByRole('button',{name:'Add event',exact:true}).click(); await work(page).getByLabel('Title',{exact:true}).fill('Preserved draft'); await page.getByLabel('Starting time',{exact:true}).fill('2026-10-10T10:00'); await page.getByRole('button',{name:'Save event',exact:true}).click(); await expect(page.getByRole('dialog')).toContainText('Simulated failure'); await expect(work(page).getByLabel('Title',{exact:true})).toHaveValue('Preserved draft'); expect((await disk()).events).toHaveLength(0);
  page.on('dialog',d=>d.accept()); await page.reload(); await expect(work(page).getByLabel('Title',{exact:true})).toHaveValue('Preserved draft'); await page.unroute('**/api/calendar'); await page.getByRole('button',{name:'Save event',exact:true}).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await saved(page); expect((await disk()).events).toHaveLength(1);
});
test('conflicts preserve draft, compare, reviewed overwrite, reload, and second-tab editing lock',async ({page,context}) => {
  await add(page); const second=await context.newPage(); await second.goto(page.url()); await expect(work(second).getByRole('status')).toContainText('Read-only'); await expect(second.getByRole('button',{name:'Add event',exact:true})).toBeDisabled();
  await work(page).getByRole('button',{name:'Edit event',exact:true}).first().click(); await work(page).getByLabel('Title',{exact:true}).fill('My draft');
  let external=await app.calendar.read(); external.document.events[0].title='External title'; await app.calendar.save(external);
  await page.getByRole('button',{name:'Save event',exact:true}).click(); await expect(work(page).getByRole('status')).toContainText('Conflict'); await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'Compare',exact:true}).click(); await expect(page.getByRole('dialog')).toContainText('External title'); await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:'Overwrite with draft',exact:true}).click(); page.once('dialog',d=>d.accept()); await page.getByRole('button',{name:'Replace reviewed disk version',exact:true}).click(); await saved(page); expect((await disk()).events[0].title).toBe('My draft');
  await page.getByRole('button',{name:'Students',exact:true}).click(); await expect(page.locator('#students-workspace')).toBeVisible(); await second.getByRole('button',{name:'Claim editing',exact:true}).click(); await saved(second);
});
test('reminders fire at ten minutes across sections and survive permission denial',async ({page}) => {
  await page.addInitScript(()=> { class Denied { static permission='default'; static async requestPermission(){ Denied.permission='denied'; return 'denied'; } } Object.defineProperty(window,'Notification',{value:Denied,configurable:true}); });
  await seed('Due soon','2026-10-10T00:11:00.000Z'); await page.reload(); await page.getByRole('button',{name:'Enable system notifications',exact:true}).click(); await expect(work(page)).toContainText('System notifications blocked');
  await page.getByRole('button',{name:'Students',exact:true}).click(); await page.clock.runFor(45000); await expect(page.locator('.calendar-reminder')).toHaveCount(0);
  await page.clock.runFor(15000); await expect(page.locator('.calendar-reminder')).toHaveCount(1); await expect(page.locator('.calendar-reminder')).toContainText('Due soon'); await page.getByRole('button',{name:'Dismiss reminder for Due soon',exact:true}).click(); await page.clock.runFor(15000); await expect(page.locator('.calendar-reminder')).toHaveCount(0); await page.reload(); await expect(page.locator('.calendar-reminder')).toHaveCount(0);
});
test('opening within window reminds once across tabs, excludes past events, rescheduling rearms',async ({page,context}) => {
  const event=await seed('Window event','2026-10-10T00:05:00.000Z'); await seed('Past event','2026-10-09T23:59:00.000Z');
  const second=await context.newPage(); await second.clock.install({time:new Date('2026-10-10T00:00:00Z')}); await second.goto(base); await expect(second.locator('.calendar-reminder')).toHaveCount(1);
  await page.reload(); await expect(work(page).locator('h1')).toHaveText('Calendar'); await expect(page.locator('.calendar-reminder')).toHaveCount(0); await expect(second.locator('.calendar-reminder')).toContainText('Window event');
  let doc=await app.calendar.read(); doc.document.events.find(e=>e.id===event.id).start='2026-10-10T00:06:00.000Z'; await app.calendar.save(doc); await page.clock.runFor(15000); await expect.poll(async () => await page.locator('.calendar-reminder').count() + await second.locator('.calendar-reminder').count()).toBe(2);
});
test('deletion removes pending reminders and failed drafts never notify',async ({page}) => {
  const event=await seed('Deleted event','2026-10-10T00:11:00.000Z'); let doc=await app.calendar.read(); doc.document.events=doc.document.events.filter(e=>e.id!==event.id); await app.calendar.save(doc);
  await page.route('**/api/calendar',route=>route.request().method()==='PUT'?route.fulfill({status:500,contentType:'application/json',body:'{"error":"Offline"}'}):route.continue());
  await page.getByRole('button',{name:'Add event',exact:true}).click(); await work(page).getByLabel('Title',{exact:true}).fill('Unsaved event'); await page.getByLabel('Starting time',{exact:true}).fill('2026-10-10T08:05'); await page.getByRole('button',{name:'Save event',exact:true}).click(); await expect(page.getByRole('dialog')).toContainText('Offline'); await page.clock.runFor(60000); await expect(page.locator('.calendar-reminder')).toHaveCount(0); page.on('dialog',d=>d.accept());
});
test('small-screen calendar and keyboard dialog are usable',async ({page}) => {
  await page.setViewportSize({width:390,height:844}); await expect(work(page).locator('.calendar-grid')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('button',{name:'Add event',exact:true}).click(); await expect(work(page).getByLabel('Title',{exact:true})).toBeFocused(); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('invalid duration stays in form and unsaved fields recover before submission',async ({page}) => {
  await page.getByRole('button',{name:'Add event',exact:true}).click(); await work(page).getByLabel('Title',{exact:true}).fill('Form only'); await page.getByLabel('Starting time',{exact:true}).fill('2026-10-10T10:00'); await page.getByLabel('Duration in minutes (optional)',{exact:true}).fill('0'); await page.getByRole('button',{name:'Save event',exact:true}).click(); expect((await disk()).events).toHaveLength(0); await expect(page.getByRole('dialog')).toBeVisible();
  page.on('dialog',d=>d.accept()); await page.reload(); await expect(work(page).getByLabel('Title',{exact:true})).toHaveValue('Form only'); await expect(page.getByLabel('Duration in minutes (optional)',{exact:true})).toHaveValue('0'); await page.getByLabel('Duration in minutes (optional)',{exact:true}).fill(''); await page.getByRole('button',{name:'Save event',exact:true}).click(); await saved(page); expect((await disk()).events).toHaveLength(1);
});
test('reload disk version discards a conflicting candidate',async ({page}) => {
  await add(page); await work(page).getByRole('button',{name:'Edit event',exact:true}).first().click(); await work(page).getByLabel('Title',{exact:true}).fill('Discard me');
  const external=await app.calendar.read(); external.document.events[0].title='Keep disk'; await app.calendar.save(external); await page.getByRole('button',{name:'Save event',exact:true}).click(); await expect(work(page).getByRole('status')).toContainText('Conflict'); await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click(); page.once('dialog',d=>d.accept()); await page.getByRole('button',{name:'Reload disk version',exact:true}).click(); await saved(page); await expect(work(page)).toContainText('Keep disk'); await expect(work(page)).not.toContainText('Discard me');
});

test('saving freezes event fields until disk acknowledges the change',async ({page}) => {
  let resume, started; const gate=new Promise(resolve=>{resume=resolve;}); const received=new Promise(resolve=>{started=resolve;});
  await page.route('**/api/calendar',async route=>{ if(route.request().method()==='PUT'){started();await gate;} await route.continue(); });
  await page.getByRole('button',{name:'Add event',exact:true}).click(); await work(page).getByLabel('Title',{exact:true}).fill('Saving event'); await page.getByLabel('Starting time',{exact:true}).fill('2026-10-10T10:00'); await page.getByRole('button',{name:'Save event',exact:true}).click(); await received;
  await expect(work(page).getByLabel('Title',{exact:true})).toBeDisabled(); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toBeVisible(); resume(); await expect(page.getByRole('dialog')).toHaveCount(0); await saved(page); expect((await disk()).events[0].title).toBe('Saving event');
});

test('events automatically create categorized Daily tasks, edits keep identity, deletion stops carry-forward', async ({ page }) => {
  await add(page, 'Default calendar task', '2026-10-10T10:00');
  await page.getByRole('button', { name: 'Add event', exact: true }).click();
  await work(page).getByLabel('Title', { exact: true }).fill('Student calendar task');
  await page.getByLabel('Starting time', { exact: true }).fill('2026-10-11T00:30');
  await page.getByLabel('Category (optional)', { exact: true }).selectOption('category-1');
  await page.getByRole('button', { name: 'Save event', exact: true }).click(); await saved(page);
  const events = (await disk()).events;
  await page.getByRole('button', { name: 'Daily', exact: true }).click();
  await page.goto(base + '/?view=daily&date=2026-10-10');
  const daily = page.locator('#daily-workspace');
  await expect(daily.locator('.daily-group').filter({ has: page.getByRole('heading', { name: 'Miscellaneous', exact: true }) }).getByLabel('Task', { exact: true })).toHaveValue('Default calendar task');
  await expect(daily.getByLabel('Task', { exact: true })).toHaveCount(1);
  await page.goto(base + '/?view=daily&date=2026-10-11');
  await expect(daily.locator('.daily-group').filter({ has: page.getByRole('heading', { name: 'Students', exact: true }) }).getByLabel('Task', { exact: true })).toHaveValue('Student calendar task');
  await expect(daily.locator('.daily-day-preview')).toContainText('00:30');
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  await work(page).locator('.calendar-event').filter({ hasText: 'Default calendar task' }).first().getByRole('button', { name: 'Edit event' }).click();
  await work(page).getByLabel('Title', { exact: true }).fill('Updated calendar task');
  await page.getByLabel('Category (optional)', { exact: true }).selectOption('category-2');
  await page.getByRole('button', { name: 'Save event', exact: true }).click(); await saved(page);
  let doc = (await app.daily.read()).document;
  expect(doc.tasks).toHaveLength(2); expect(doc.tasks.find(t => t.id === events[0].id).versions.at(-1).categoryId).toBe('category-2');
  page.once('dialog', dialog => dialog.accept());
  await work(page).locator('.calendar-event').filter({ hasText: 'Updated calendar task' }).first().getByRole('button', { name: 'Delete event' }).click(); await saved(page);
  doc = (await app.daily.read()).document;
  expect(doc.tasks.find(t => t.id === events[0].id).versions.at(-1).status).toBe('cancelled');
});

test('Daily category renames and additions update Calendar choices and retain existing event assignments', async ({ page }) => {
  await page.getByRole('button', { name: 'Add event', exact: true }).click();
  await work(page).getByLabel('Title', { exact: true }).fill('Learning event');
  await page.getByLabel('Starting time', { exact: true }).fill('2026-10-10T10:00');
  await page.getByLabel('Category (optional)', { exact: true }).selectOption('category-0');
  await page.getByRole('button', { name: 'Save event', exact: true }).click(); await saved(page);
  const original = (await disk()).events[0];
  await page.getByRole('button', { name: 'Daily', exact: true }).click();
  await page.getByRole('button', { name: 'Categories', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Category name', { exact: true }).first().fill('Reading');
  await dialog.getByLabel('New category', { exact: true }).fill('Music');
  await dialog.getByRole('button', { name: 'Add category', exact: true }).click();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  // Switching sections flushes the Daily settings, without a page reload.
  await page.getByRole('button', { name: 'Calendar', exact: true }).click();
  await work(page).getByRole('button', { name: 'Edit event', exact: true }).first().click();
  const category = page.getByLabel('Category (optional)', { exact: true });
  await expect(category).toHaveValue(original.categoryId);
  await expect(category.locator('option:checked')).toHaveText('Reading');
  await expect(category.locator('option')).toHaveText(['Miscellaneous (default)', 'Reading', 'Students', 'Projects', 'Papers', 'Development', 'Miscellaneous', 'Music']);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Add event', exact: true }).click();
  await work(page).getByLabel('Title', { exact: true }).fill('Music event');
  await page.getByLabel('Starting time', { exact: true }).fill('2026-10-11T10:00');
  await category.selectOption({ label: 'Music' });
  await page.getByRole('button', { name: 'Save event', exact: true }).click(); await saved(page);
  const daily = (await app.daily.read()).document;
  const music = daily.categories.find(c => c.name === 'Music');
  const events = (await disk()).events;
  expect(events.find(e => e.id === original.id).categoryId).toBe('category-0');
  expect(events.find(e => e.title === 'Music event').categoryId).toBe(music.id);
  expect(daily.tasks.find(t => t.id === original.id).versions.at(-1).categoryId).toBe('category-0');
  expect(daily.tasks.find(t => t.id === events.find(e => e.title === 'Music event').id).versions.at(-1).categoryId).toBe(music.id);
});


test('new event defaults to the selected date across month navigation; end time and duration are optional alternatives', async ({ page }) => {
  await page.getByRole('button', { name: 'Next month', exact: true }).click();
  await page.getByRole('button', { name: 'Add event', exact: true }).click();
  await expect(page.getByLabel('Starting time', { exact: true })).toHaveValue('2026-11-01T08:00');
  await work(page).getByLabel('Title', { exact: true }).fill('Overnight event');
  await page.getByLabel('Starting time', { exact: true }).fill('2026-10-10T23:30');
  await page.getByLabel('Duration in minutes (optional)', { exact: true }).fill('60');
  await page.getByLabel('End time (optional)', { exact: true }).fill('23:00');
  await expect(page.getByLabel('Duration in minutes (optional)', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Save event', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('after the starting time');
  expect((await disk()).events).toHaveLength(0);
  await page.getByLabel('End date (optional)', { exact: true }).fill('2026-10-11');
  await page.getByLabel('End time (optional)', { exact: true }).fill('01:00');
  await page.getByRole('button', { name: 'Save event', exact: true }).click(); await saved(page);
  const event = (await disk()).events[0];
  expect(event.end).toBe('2026-10-10T17:00:00.000Z'); expect(event.durationMinutes).toBeUndefined();
  await expect(work(page).locator('.calendar-agenda')).toContainText('Ends 10/11/2026, 1:00:00 AM');
  const daily = (await app.daily.read()).document.tasks.find(t => t.id === event.id);
  expect(daily.versions.at(-1).details).toBe('Ends: 2026-10-11 01:00');
  await page.reload();
  await work(page).getByRole('button', { name: 'Edit event', exact: true }).first().click();
  await expect(page.getByLabel('End time (optional)', { exact: true })).toHaveValue('01:00');
  await page.getByLabel('Duration in minutes (optional)', { exact: true }).fill('90');
  await expect(page.getByLabel('End time (optional)', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: 'Save event', exact: true }).click(); await saved(page);
  await expect(work(page).locator('.calendar-agenda')).toContainText('Ends 10/11/2026, 1:00:00 AM');
  expect((await disk()).events[0].end).toBeUndefined();
  await work(page).getByRole('button', { name: 'Edit event', exact: true }).first().click();
  await page.getByLabel('Duration in minutes (optional)', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Save event', exact: true }).click(); await saved(page);
  await expect(work(page).locator('.calendar-agenda')).not.toContainText('Ends');
});


test('Add event follows clicked days, previous month and direct date picker changes', async ({ page }) => {
  await expect(work(page).locator('.eyebrow')).toHaveCount(0);
  const checkDefault = async date => {
    await page.getByRole('button', { name: 'Add event', exact: true }).click();
    await expect(page.getByLabel('Starting time', { exact: true })).toHaveValue(`${date}T08:00`);
    await expect(page.getByLabel('End date (optional)', { exact: true })).toHaveValue(date);
    await expect(page.getByLabel('End time (optional)', { exact: true })).toHaveValue('');
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  };
  await page.getByRole('button', { name: '2026-10-14, 0 events', exact: true }).click();
  await checkDefault('2026-10-14');
  await page.getByRole('button', { name: 'Previous month', exact: true }).click();
  await checkDefault('2026-09-01');
  await page.getByLabel('Calendar date', { exact: true }).fill('2027-02-18');
  await page.getByLabel('Calendar date', { exact: true }).press('Tab');
  await expect(page).toHaveURL(/date=2027-02-18/);
  await checkDefault('2027-02-18');
});


test('end date follows the start date, remains optional, and saves a time on that date', async ({ page }) => {
  await page.getByRole('button', { name: 'Add event', exact: true }).click();
  await work(page).getByLabel('Title', { exact: true }).fill('Same-day end');
  const start = page.getByLabel('Starting time', { exact: true });
  const endDate = page.getByLabel('End date (optional)', { exact: true });
  await expect(endDate).toHaveValue('2026-10-10');
  await start.fill('2026-10-14T10:00');
  await expect(endDate).toHaveValue('2026-10-14');
  await page.getByLabel('End time (optional)', { exact: true }).fill('11:30');
  await page.getByRole('button', { name: 'Save event', exact: true }).click(); await saved(page);
  expect((await disk()).events[0].end).toBe('2026-10-14T03:30:00.000Z');
  await work(page).getByRole('button', { name: 'Edit event', exact: true }).first().click();
  await expect(endDate).toHaveValue('2026-10-14');
  await expect(page.getByLabel('End time (optional)', { exact: true })).toHaveValue('11:30');
  await endDate.fill('2026-10-16');
  await start.fill('2026-10-15T10:00');
  await expect(endDate).toHaveValue('2026-10-16');
  await page.getByLabel('End time (optional)', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Save event', exact: true }).click(); await saved(page);
  expect((await disk()).events[0].end).toBeUndefined();
});

async function instrumentSound(page, blocked = false) {
  await page.addInitScript(({ blocked }) => {
    window.soundNotes = []; window.systemAlerts = []; window.permissionRequests = 0;
    class Audio {
      state = 'suspended'; currentTime = 0; destination = {};
      async resume() { if (!blocked) this.state = 'running'; }
      createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
      createOscillator() { return { frequency: { setValueAtTime(value) { window.soundNotes.push(value); } }, connect() {}, disconnect() {}, start() {}, stop() {} }; }
    }
    class Notifications {
      static permission = 'default';
      static async requestPermission() { window.permissionRequests++; this.permission = 'granted'; return 'granted'; }
      constructor(title, options) { window.systemAlerts.push({ title, options }); }
      close() {}
    }
    Object.defineProperty(window, 'AudioContext', { value: Audio, configurable: true });
    Object.defineProperty(window, 'Notification', { value: Notifications, configurable: true });
  }, { blocked });
  await page.reload();
}

test('sound accompanies a system notification once across sections and repeated checks', async ({ page }) => {
  await instrumentSound(page);
  expect(await page.evaluate(() => permissionRequests)).toBe(0);
  await page.getByRole('button', { name: 'Enable system notifications', exact: true }).click();
  expect(await page.evaluate(() => permissionRequests)).toBe(1);
  await seed('Audible reminder', '2026-10-10T00:05:00.000Z');
  await page.getByRole('button', { name: 'Students', exact: true }).click();
  await page.clock.runFor(15000); await expect(page.locator('.calendar-reminder')).toHaveCount(1);
  expect(await page.evaluate(() => soundNotes)).toEqual([660, 880]);
  const alerts = await page.evaluate(() => systemAlerts); expect(alerts).toHaveLength(1); expect(alerts[0].title).toBe('Audible reminder'); expect(alerts[0].options.silent).toBe(true);
  await page.clock.runFor(30000); expect(await page.evaluate(() => soundNotes)).toHaveLength(2); expect(await page.evaluate(() => systemAlerts)).toHaveLength(1);
});

test('mute persists after reload and leaves visual and system reminders active', async ({ page }) => {
  await instrumentSound(page);
  await page.getByRole('button', { name: 'Mute reminder sound', exact: true }).click(); await page.reload();
  await expect(page.getByRole('button', { name: 'Enable reminder sound', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Enable system notifications', exact: true }).click(); await seed('Muted reminder', '2026-10-10T00:05:00.000Z');
  await page.clock.runFor(15000); await expect(page.locator('.calendar-reminder')).toHaveCount(1);
  expect(await page.evaluate(() => soundNotes)).toEqual([]); expect(await page.evaluate(() => systemAlerts)).toHaveLength(1);
  await page.getByRole('button', { name: 'Enable reminder sound', exact: true }).click(); await page.getByRole('button', { name: 'Test reminder sound', exact: true }).click(); expect(await page.evaluate(() => soundNotes)).toEqual([660,880]);
});

test('blocked or unsupported audio keeps the reminder and offers manual playback', async ({ page }) => {
  await instrumentSound(page, true); await seed('Blocked audio', '2026-10-10T00:05:00.000Z');
  await page.clock.runFor(15000); await expect(page.getByRole('button', { name: 'Play alert sound', exact: true })).toBeVisible(); expect(await page.evaluate(() => soundNotes)).toEqual([]);
  await page.getByRole('button', { name: 'Play alert sound', exact: true }).click(); await expect(page.locator('#notice')).toContainText('Audio playback is unavailable or blocked'); await expect(page.locator('.calendar-reminder')).toHaveCount(1);
  await page.addInitScript(() => { Object.defineProperty(window, 'AudioContext', { value: undefined, configurable: true }); Object.defineProperty(window, 'webkitAudioContext', { value: undefined, configurable: true }); });
  await page.reload(); await expect(work(page)).toContainText('Reminder sound is unavailable');
});

test('real browser audio unlocks on interaction and schedules two chime notes', async ({ page }) => {
  await page.addInitScript(() => {
    window.audioChecks = []; const Audio = window.AudioContext;
    window.AudioContext = class extends Audio {
      createOscillator() { const oscillator = super.createOscillator(); let frequency; const schedule = oscillator.frequency.setValueAtTime.bind(oscillator.frequency); oscillator.frequency.setValueAtTime = (value, time) => { frequency = value; return schedule(value, time); }; const start = oscillator.start.bind(oscillator); oscillator.start = time => { window.audioChecks.push({ state: this.state, frequency }); start(time); }; return oscillator; }
    };
  });
  await page.reload(); await page.getByRole('button', { name: 'Test reminder sound', exact: true }).click();
  await expect.poll(() => page.evaluate(() => audioChecks)).toEqual([{ state: 'running', frequency: 660 }, { state: 'running', frequency: 880 }]);
});

test('two tabs deliver only one chime for a reminder', async ({ page, context }) => {
  await instrumentSound(page); const second = await context.newPage(); await second.clock.install({ time: new Date('2026-10-10T00:00:00Z') }); await second.goto(page.url()); await instrumentSound(second);
  for (const tab of [page, second]) { await tab.getByRole('button', { name: 'Test reminder sound', exact: true }).click(); await tab.evaluate(() => { window.soundNotes = []; }); }
  await seed('One chime', '2026-10-10T00:05:00.000Z'); await Promise.all([page.clock.runFor(15000), second.clock.runFor(15000)]);
  await expect.poll(async () => await page.locator('.calendar-reminder').count() + await second.locator('.calendar-reminder').count()).toBe(1);
  expect(await page.evaluate(() => soundNotes.length) + await second.evaluate(() => soundNotes.length)).toBe(2);
});

test('system notification requests OS sound when enabled audio is blocked', async ({ page }) => {
  await instrumentSound(page, true); await page.getByRole('button', { name: 'Enable system notifications', exact: true }).click(); await seed('OS sound fallback', '2026-10-10T00:05:00.000Z'); await page.clock.runFor(15000);
  await expect(page.locator('.calendar-reminder')).toHaveCount(1); expect(await page.evaluate(() => systemAlerts[0].options.silent)).toBe(false);
});

test('Daily completion strikes the matching event in both lists; reopening and reload follow saved state', async ({ page }) => {
  await add(page, 'Linked event', '2026-10-11T10:00'); await add(page, 'Linked event', '2026-10-12T10:00');
  const events = (await disk()).events, revision = (await app.calendar.read()).revision;
  await page.goto(base + '/?view=daily&date=2026-10-11'); const daily = page.locator('#daily-workspace');
  await daily.getByRole('checkbox', { name: 'Complete Linked event', exact: true }).check(); await expect(daily.getByRole('status')).toContainText('Saved to disk');
  await page.goto(base + '/?view=calendar&date=2026-10-11');
  const completed = work(page).locator(`[data-event="${events[0].id}"]`), other = work(page).locator(`[data-event="${events[1].id}"]`);
  await expect(completed).toHaveCount(2); for (const row of await completed.all()) { await expect(row).toHaveClass(/completed/); await expect(row).toContainText('Completed in Daily'); await expect(row.locator('h3')).toHaveCSS('text-decoration-line', 'line-through'); }
  await expect(other).not.toHaveClass(/completed/); expect((await app.calendar.read()).revision).toBe(revision);
  await page.reload(); await expect(completed.first()).toHaveClass(/completed/);
  await page.goto(base + '/?view=daily&date=2026-10-11'); await daily.getByRole('checkbox', { name: 'Complete Linked event', exact: true }).uncheck(); await expect(daily.getByRole('status')).toContainText('Saved to disk');
  await page.goto(base + '/?view=calendar&date=2026-10-11'); for (const row of await completed.all()) { await expect(row).not.toHaveClass(/completed/); await expect(row.locator('h3')).toHaveCSS('text-decoration-line', 'none'); }
});

test('Calendar observes another tab completing and undoing its linked Daily task', async ({ page, context }) => {
  await add(page, 'Shared completion', '2026-10-10T10:00'); const id = (await disk()).events[0].id;
  const other = await context.newPage(); await other.clock.install({ time: new Date('2026-10-10T00:00:00Z') }); await other.goto(base + '/?view=daily&date=2026-10-10');
  const daily = other.locator('#daily-workspace'), rows = work(page).locator(`[data-event="${id}"]`);
  await daily.getByRole('checkbox', { name: 'Complete Shared completion', exact: true }).check(); await expect(daily.getByRole('status')).toContainText('Saved to disk');
  await page.bringToFront(); await page.clock.runFor(3000); await expect(rows.first()).toHaveClass(/completed/);
  await other.bringToFront(); await daily.getByRole('button', { name: 'Undo task change', exact: true }).click(); await expect(daily.getByRole('status')).toContainText('Saved to disk');
  await page.bringToFront(); await page.clock.runFor(3000); await expect(rows.first()).not.toHaveClass(/completed/);
});
