import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
let root, app, base;
test.beforeEach(async ({ page }) => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldnotes-student-ui-'));
  await fs.mkdir(path.join(root, 'collections')); await fs.writeFile(path.join(root, 'collections/Notebook.md'), '# Notebook');
  await fs.symlink(path.resolve('dist'), path.join(root, 'dist'));
  app = await createApp(root); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`; await page.goto(base); await page.getByRole('button', { name: 'Students', exact: true }).click();
});
test.afterEach(async ({ context }) => { for (const page of context.pages()) await page.close(); await app.terminals.close(); await app.kernels.close(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
const work = page => page.locator('#students-workspace');
test('global search returns notebook and student matches with a boolean profile field', async ({ page }) => {
  const student = await app.students.create({ name: 'Notebook student' });
  student.document.profile.coursesCompleted = true;
  await app.students.save(student.document.id, student);
  await page.locator('#search-launch').click();
  await page.locator('#search-input').fill('Notebook');
  await expect(page.locator('#search-results')).toContainText('Notebook student');
  await expect(page.locator('#search-results .result-title')).toContainText(['Notebook', 'Notebook student']);
  await expect(page.locator('#notice')).not.toContainText('Operation failed');
});
const saved = page => expect(work(page).getByRole('status')).toContainText('Saved to disk');
async function create(page, name = '李同学', editing = true) { await page.getByRole('button', { name: 'Add student', exact: true }).click(); await page.getByRole('textbox', { name: 'Student name', exact: true }).fill(name); await page.getByRole('button', { name: 'Create student', exact: true }).click(); await expect(page).toHaveURL(/view=student&id=/); await saved(page); if (editing) await editSections(page); }
async function editSections(page) { await page.getByRole('button', { name: /^(Edit|Done editing) objectives$/ }).waitFor({ state: 'visible' }); for (const title of ['next conversation', 'supervision record', 'objectives']) { const button = page.getByRole('button', { name: `Edit ${title}`, exact: true }); if (await button.count()) await button.click(); } }
async function editProfile(page, label, value) { await page.getByRole('button', { name: 'Edit profile', exact: true }).click(); await page.getByLabel(label, { exact: true }).fill(value); await page.getByRole('button', { name: 'Save profile', exact: true }).click(); await expect(page.locator('.student-dialog')).toHaveCount(0); }
async function rich(page, name, text) { await work(page).getByRole('textbox', { name, exact: true }).fill(text); }
async function disk(page) { const id = new URL(page.url()).searchParams.get('id'); return (await app.students.read(id)).document; }
async function goal(page, title = 'First paper') { await editSections(page); await page.getByRole('button', { name: 'Add objective', exact: true }).click(); await page.getByRole('textbox', { name: 'Objective title', exact: true }).last().fill(title); }
async function action(page, title = 'Run experiments') { await page.getByRole('button', { name: 'Add action', exact: true }).last().click(); await page.getByRole('textbox', { name: 'Action', exact: true }).last().fill(title); }

test('profile, formatted notes, objectives, milestones and preparation survive reload', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message)); await create(page);
  await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
  for (const [label, value] of [['Date of birth', '2001-02-03'], ['GK place (高考地)', '广东'], ['Email', 'student@example.com'], ['Research areas', '机器学习'], ['Degree / program', 'PhD'], ['Entry year', '2026']]) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await goal(page); await rich(page, 'Objective description', '研究方向和方法'); await page.getByLabel('Target date', { exact: true }).fill('2027-02-01'); await page.getByLabel('Objective status', { exact: true }).selectOption('In progress');
  await page.getByRole('button', { name: 'Add milestone', exact: true }).click(); await page.getByLabel('Milestone', { exact: true }).fill('Literature review'); await page.getByLabel('Milestone completed', { exact: true }).check();
  await page.getByLabel('Next meeting', { exact: true }).fill('2026-10-16'); await rich(page, 'Next meeting agenda', '**讨论实验设计**');
  await saved(page); await page.getByRole('button', { name: 'Start meeting', exact: true }).click(); await expect(page.getByLabel('Next meeting', { exact: true })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Discussion', exact: true })).toHaveValue('**讨论实验设计**');
  await page.getByLabel('Meeting title', { exact: true }).fill('Experiment design'); await rich(page, 'Decisions', '先做基线');
  await action(page); await page.getByLabel('Owner', { exact: true }).selectOption('Supervisor'); await page.getByLabel('Due date', { exact: true }).fill('2026-10-20');
  const goalId = (await disk(page)).objectives[0].id; await page.getByLabel('Linked objective', { exact: true }).selectOption(goalId);
  await saved(page); await page.reload(); await expect(page.locator('h1').filter({ hasText: '李同学' })).toBeVisible(); await expect(page.locator('.student-profile-summary')).toContainText('广东'); await expect(page.locator('.student-profile input')).toHaveCount(0);
  await editSections(page); await expect(page.getByLabel('Owner', { exact: true })).toHaveValue('Supervisor'); await expect(page.locator('.student-goal')).toContainText('1 / 1 milestones completed');
  await expect(page.locator('.student-objective-history')).toContainText('Experiment design'); await page.locator('.student-objective-history').getByRole('button').click(); await expect(page.locator('.student-session')).toHaveAttribute('open', '');
  await page.getByLabel('Action completed', { exact: true }).check(); await expect(page.locator('.student-pending-actions')).toContainText('Unfinished actions (0)'); await saved(page);
  const doc = await disk(page); expect(doc.sessions[0].date).toBe('2026-10-16'); expect(doc.sessions[0].actions[0].done).toBe(true); expect(doc.preparation.agenda.content).toEqual([{ type: 'paragraph' }]); expect(errors).toEqual([]);
  await page.locator('#students-workspace').evaluate(n => n.scrollTop = 0); await page.screenshot({ path: '/tmp/fieldnotes-student-dashboard.png', fullPage: true });
});

test('list summaries, search, archive, restore, export and browser history', async ({ page }) => {
  await create(page, 'Later student'); await page.getByLabel('Next meeting', { exact: true }).fill('2026-11-01'); await saved(page); await page.getByRole('button', { name: 'All students', exact: true }).click();
  await create(page, 'Earlier student'); await page.getByLabel('Next meeting', { exact: true }).fill('2026-10-10'); await editProfile(page, 'Research areas', 'Neural circuits'); await goal(page); await page.getByLabel('Target date', { exact: true }).fill('2027-01-01'); await saved(page);
  const studentUrl = page.url(); await page.getByRole('button', { name: 'All students', exact: true }).click(); await expect(page.locator('.student-card h2')).toHaveText(['Earlier student', 'Later student']);
  await expect(page.locator('.student-card').first()).toContainText('2027-01-01'); await page.getByLabel('Search students', { exact: true }).fill('circuits'); await expect(page.locator('.student-card')).toHaveCount(1); await page.getByLabel('Search students', { exact: true }).fill('');
  await page.goBack(); await expect(page).toHaveURL(studentUrl); await expect(page.locator('.student-profile-summary')).toContainText('Earlier student'); await page.goForward(); await expect(page).toHaveURL(/view=students$/);
  await page.locator('.student-card').first().click(); await editSections(page); await page.getByRole('button', { name: 'Archive objective', exact: true }).click(); await page.getByRole('button', { name: 'Archive student', exact: true }).click(); await saved(page);
  await page.getByRole('button', { name: 'All students', exact: true }).click(); await expect(page.locator('.student-card')).toHaveCount(1); await page.getByLabel('Show students', { exact: true }).selectOption('archived'); await expect(page.locator('.student-card')).toContainText('Earlier student');
  const exported = await (await page.request.get(base + '/api/students/export')).json(); expect(exported.students).toHaveLength(2); expect(exported.students.some(d => d.archived && d.objectives[0].archived)).toBe(true);
  const downloadEvent = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export all records', exact: true }).click(); expect((await downloadEvent).suggestedFilename()).toBe('workbench-students.json');
  await page.locator('.student-card').click(); await page.getByRole('button', { name: 'Unarchive student', exact: true }).click(); await editSections(page); await page.getByText('Archived objectives (1)', { exact: true }).click(); await page.getByRole('button', { name: 'Unarchive objective', exact: true }).click(); await saved(page);
  await page.locator('#tree').getByRole('button', { name: 'Notebook', exact: true }).click(); await expect(page.locator('#note-title')).toHaveText('Notebook'); await page.goBack(); await expect(page.locator('.student-profile-summary')).toContainText('Earlier student');
});

test('history search, removal undo and objective links retain identity', async ({ page }) => {
  await create(page); await goal(page, 'Stable goal'); await page.getByRole('button', { name: 'Add meeting', exact: true }).click(); await page.getByLabel('Meeting title', { exact: true }).fill('First session'); await rich(page, 'Discussion', '特殊关键词'); await action(page, 'Read paper'); await page.getByLabel('Stable goal', { exact: true }).check(); await saved(page);
  const first = await disk(page); await page.getByRole('button', { name: 'Add meeting', exact: true }).click(); await page.getByLabel('Meeting title', { exact: true }).first().fill('Second session'); await saved(page);
  await page.getByLabel('Search meeting records', { exact: true }).fill('特殊关键词'); await expect(page.locator('.student-session:visible')).toHaveCount(1); await expect(page.locator('.student-session:visible')).toContainText('First session');
  page.once('dialog', d => d.accept()); await page.getByRole('button', { name: 'Remove action', exact: true }).click(); await expect(page.getByLabel('Action', { exact: true })).toHaveCount(0); await editProfile(page, 'Degree / program', 'Keep this edit'); await page.getByRole('button', { name: 'Undo removal', exact: true }).click(); await expect(page.getByLabel('Action', { exact: true })).toHaveValue('Read paper'); await expect(page.locator('.student-profile-summary')).toContainText('Keep this edit');
  await page.getByLabel('Objective title', { exact: true }).fill('Renamed goal'); await saved(page); const latest = await disk(page); expect(latest.objectives[0].id).toBe(first.objectives[0].id); expect(latest.sessions[0].objectiveIds).toEqual([first.objectives[0].id]);
});

test('failed saves preserve draft, block navigation, recover on reload and retry', async ({ page }) => {
  await create(page); await page.route('**/api/students/*', async route => { if (route.request().method() === 'PUT') await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Simulated save failure' }) }); else await route.continue(); });
  await editProfile(page, 'Degree / program', 'Draft stage'); await expect(work(page).getByRole('status')).toContainText('Save failed');
  await page.getByRole('button', { name: 'All students', exact: true }).click(); await expect(page.locator('.student-profile-summary')).toContainText('Draft stage'); await expect(page).toHaveURL(/view=student/);
  page.on('dialog', d => d.accept()); await page.reload(); await expect(page.locator('.student-profile-summary')).toContainText('Draft stage'); await expect(work(page).getByRole('status')).toContainText('Save failed');
  await page.unroute('**/api/students/*'); await page.getByRole('button', { name: 'Retry save', exact: true }).click(); await saved(page); expect((await disk(page)).profile.program).toBe('Draft stage');
});

test('disk conflict compare, export, explicit overwrite and reload preserve chosen content', async ({ page }) => {
  await create(page); const id = (await disk(page)).id;
  const file = path.join(root, '.notebook/students', `${id}.json`);
  const conflictOnSave = async program => {
    await page.route('**/api/students/*', async route => {
      if (route.request().method() === 'PUT') {
        const external = JSON.parse(await fs.readFile(file, 'utf8')); external.profile.program = program; await fs.writeFile(file, JSON.stringify(external));
      }
      await route.continue();
    });
  };
  await conflictOnSave('Disk edit'); await editProfile(page, 'Degree / program', 'Local draft');
  await expect(work(page).getByRole('status')).toContainText('Conflict'); await page.unroute('**/api/students/*');
  await page.getByRole('button', { name: 'Compare', exact: true }).click(); await expect(page.locator('.student-compare')).toContainText('Local draft'); await expect(page.locator('.student-compare')).toContainText('Disk edit'); await page.locator('.student-compare').getByRole('button', { name: 'Close', exact: true }).click();
  const downloadEvent = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export draft', exact: true }).click(); expect((await downloadEvent).suggestedFilename()).toContain('-draft.json');
  await page.getByRole('button', { name: 'Overwrite with draft', exact: true }).click(); await expect(page.locator('.student-compare')).toBeVisible(); page.once('dialog', d => d.accept()); await page.locator('.student-compare').getByRole('button', { name: 'Close', exact: true }).click(); await saved(page); expect((await disk(page)).profile.program).toBe('Local draft');
  await conflictOnSave('Newest disk'); await editProfile(page, 'Degree / program', 'Another local'); await expect(work(page).getByRole('status')).toContainText('Conflict'); await page.unroute('**/api/students/*');
  page.once('dialog', d => d.accept()); await page.getByRole('button', { name: 'Reload disk version', exact: true }).click(); await expect(page.locator('.student-profile-summary')).toContainText('Newest disk'); await saved(page);
});

test('two tabs coordinate student ownership and reclaim after notebook navigation', async ({ page, context }) => {
  await create(page); const duplicate = await context.newPage(); await duplicate.goto(page.url()); await expect(duplicate.locator('.student-readonly')).toContainText('Already being edited'); await expect(duplicate.getByRole('button', { name: 'Edit profile', exact: true })).toBeDisabled();
  await expect(duplicate.getByRole('button', { name: 'Edit supervision record', exact: true })).toBeDisabled();
  await page.locator('#tree').getByRole('button', { name: 'Notebook', exact: true }).click(); await expect(page.locator('#note-title')).toHaveText('Notebook'); await duplicate.getByRole('button', { name: 'Edit here when available', exact: true }).click(); await expect(duplicate.getByRole('button', { name: 'Edit profile', exact: true })).toBeEnabled(); await editProfile(duplicate, 'Degree / program', 'Reclaimed'); await saved(duplicate);
  await duplicate.getByRole('button', { name: 'All students', exact: true }).click(); await expect(duplicate.getByLabel('Search students', { exact: true })).toBeEnabled();
});

test('mobile layout, keyboard save, Markdown source and failed meeting-start recovery', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await create(page); await goal(page); await rich(page, 'Next meeting agenda', '1. [Discuss baseline](https://example.com/paper)'); await page.keyboard.press('ControlOrMeta+S'); await saved(page);
  expect((await disk(page)).preparation.agenda).toEqual({ type: 'markdown', text: '1. [Discuss baseline](https://example.com/paper)' });
  await page.getByLabel('Next meeting', { exact: true }).fill('2026-10-16'); await saved(page);
  await page.route('**/api/students/*', async route => { if (route.request().method() === 'PUT') await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Offline"}' }); else await route.continue(); });
  await page.getByRole('button', { name: 'Start meeting', exact: true }).click(); await expect(work(page).getByRole('status')).toContainText('Save failed'); await expect(page.getByLabel('Next meeting', { exact: true })).toHaveValue('2026-10-16'); expect((await disk(page)).sessions).toHaveLength(0);
  await page.unroute('**/api/students/*'); await page.getByRole('button', { name: 'Start meeting', exact: true }).click(); await expect(page.locator('.student-session')).toHaveCount(1); await saved(page);
  const boxes = await page.locator('.student-profile, .student-preparation, .student-objectives, .student-history').evaluateAll(nodes => nodes.map(n => ({ top: n.getBoundingClientRect().top, right: n.getBoundingClientRect().right })));
  expect(boxes[0].top).toBeLessThan(boxes[1].top); expect(boxes[1].top).toBeLessThan(boxes[2].top); expect(boxes[2].top).toBeLessThan(boxes[3].top); expect(boxes.every(b => b.right <= 390)).toBe(true);
  await page.screenshot({ path: '/tmp/fieldnotes-student-mobile.png', fullPage: true });
});

test('add student accepts optional details; concise profile edits can be cancelled', async ({ page }) => {
  await page.clock.setFixedTime(new Date(2026, 9, 10));
  await page.getByRole('button', { name: 'Add student', exact: true }).click();
  await page.getByLabel('Student name', { exact: true }).fill('Full profile');
  await page.getByLabel('GK place (高考地)', { exact: true }).fill('四川');
  await page.getByLabel('Date of birth', { exact: true }).fill('2000-04');
  await page.getByRole('dialog').getByLabel('Entry year', { exact: true }).fill('2025');
  await page.getByLabel('Email', { exact: true }).fill('full@example.com');
  await page.getByRole('button', { name: 'Create student', exact: true }).click(); await saved(page);
  await expect(page.locator('.topbar')).toBeHidden();
  await expect(page.locator('.students-heading')).not.toContainText('A continuous record');
  await expect(page.locator('.student-profile-summary')).toContainText('四川');
  await expect(page.locator('[data-current-stage]')).toHaveText('Year 2');
  await expect(page.locator('.student-profile input')).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
  await expect(page.getByLabel('GK place (高考地)', { exact: true })).toHaveValue('四川');
  await expect(page.getByLabel('Native place (籍贯)', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Birthplace', { exact: true })).toHaveCount(0);
  await page.getByLabel('Name', { exact: true }).fill('Cancelled');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.student-profile-summary')).toContainText('Full profile');
  await editProfile(page, 'Name', 'Updated'); await saved(page);
  await page.reload(); await expect(page.locator('.student-profile-summary')).toContainText('Updated');
  await page.getByRole('button', { name: 'All students', exact: true }).click();
  await page.getByRole('button', { name: 'Workbench home', exact: true }).click();
  await expect(page.locator('.topbar #toggle-sidebar')).toBeAttached();
});

test('an external edit while the profile dialog is open becomes a conflict', async ({ page }) => {
  await create(page); await page.clock.install();
  await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
  await page.getByLabel('Degree / program', { exact: true }).fill('Local profile draft');
  const id = (await disk(page)).id; const file = path.join(root, '.notebook/students', `${id}.json`);
  const external = JSON.parse(await fs.readFile(file, 'utf8')); external.profile.program = 'External profile'; await fs.writeFile(file, JSON.stringify(external));
  await page.clock.fastForward(4000);
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(work(page).getByRole('status')).toContainText('Conflict');
  await expect(page.locator('.student-profile-summary')).toContainText('Local profile draft');
  expect((await disk(page)).profile.program).toBe('External profile');
});


test('sections open as formatted previews with explicit edit controls', async ({ page }) => {
  await create(page, 'Preview student', false);
  await expect(work(page).locator('#toggle-sidebar')).toHaveCount(0);
  await expect(page.locator('#toggle-sidebar')).toBeHidden();
  await expect(work(page).getByRole('toolbar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add meeting', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
  for (const [label, value] of [['Date of birth', '2001-02-03'], ['GK place (高考地)', '四川'], ['Email', 'preview@example.com'], ['Research areas', '机器学习'], ['Degree / program', 'PhD'], ['Entry year', '2025']]) await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  const tops = await page.locator('.student-profile-summary > div').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().top));
  expect(new Set(tops).size).toBe(1);
  await editSections(page);
  await page.getByLabel('Next meeting', { exact: true }).fill('2026-10-16'); await rich(page, 'Next meeting agenda', '**讨论方法**');
  await goal(page, 'Preview objective'); await rich(page, 'Objective description', '长期方向');
  await page.getByRole('button', { name: 'Add milestone', exact: true }).click(); await page.getByLabel('Milestone', { exact: true }).fill('Read literature'); await page.getByLabel('Milestone completed', { exact: true }).check();
  await page.getByRole('button', { name: 'Add meeting', exact: true }).click(); await rich(page, 'Discussion', '指导记录'); await action(page, 'Review results'); await page.getByLabel('Preview objective', { exact: true }).check();
  for (const title of ['next conversation', 'supervision record', 'objectives']) await page.getByRole('button', { name: `Done editing ${title}`, exact: true }).click();
  await expect(work(page).getByRole('toolbar')).toHaveCount(0);
  await expect(page.locator('.student-preparation input, .student-session-body input, .student-goal input')).toHaveCount(0);
  await expect(page.locator('.student-preparation strong')).toHaveText('讨论方法');
  await expect(page.locator('.student-session-body')).toContainText('指导记录');
  await expect(page.locator('.student-goal')).toContainText('Read literature');
  await editProfile(page, 'Date of birth', '2001-02'); await saved(page); expect((await disk(page)).profile.dob).toBe('2001-02');
  await page.reload(); await expect(page.locator('.student-profile-summary')).toContainText('2001-02'); await expect(page.locator('.student-preparation strong')).toHaveText('讨论方法');
  await expect(work(page).getByRole('toolbar')).toHaveCount(0);
  await page.locator('.student-objective-history').getByRole('button').click(); await expect(page.locator('.student-session-body')).toContainText('Review results');
  await page.screenshot({ path: '/tmp/fieldnotes-student-preview.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#toggle-sidebar')).toBeVisible(); await page.locator('#toggle-sidebar').click(); await expect(page.getByRole('button', { name: 'Students', exact: true })).toBeVisible();
});


test('global search finds student text and opens meeting records and archived objectives', async ({ page }) => {
  await create(page, 'Search student'); await rich(page, 'Next meeting agenda', 'A fictional meeting discussed 示例检索词.'); await saved(page);
  await page.getByRole('button', { name: 'Start meeting', exact: true }).click(); await saved(page);
  await goal(page, 'Archived keyword objective'); await saved(page);
  await page.getByRole('button', { name: 'Archive objective', exact: true }).click(); await saved(page);
  await page.getByRole('button', { name: 'Archive student', exact: true }).click(); await saved(page);
  const studentUrl = page.url();
  await page.locator('#search-launch').click(); await page.locator('#search-input').fill('示例检索词');
  await expect(page.locator('#search-summary')).toHaveText('1 matching result · 1 text match');
  await expect(page.locator('.result-group')).toContainText('Archived student');
  await expect(page.locator('.result-snippet mark')).toHaveText('示例检索词');
  await page.locator('.result-snippet').click(); await expect(page).toHaveURL(studentUrl);
  await expect(page.locator('.student-session')).toHaveAttribute('open', '');
  await expect(page.locator('.student-session')).toContainText('示例检索词');
  await page.locator('#search-launch').click(); await page.locator('#search-input').fill('Archived keyword');
  await expect(page.locator('.result-snippet mark')).toHaveText('Archived keyword');
  await expect(page.locator('#search-summary')).toHaveText('1 matching result · 1 text match');
  await page.locator('.result-snippet').click(); await expect(page).toHaveURL(studentUrl);
  await expect(work(page).locator('.student-objectives [data-goal]').filter({ hasText: 'Archived keyword objective' })).toBeVisible();
  await page.locator('#search-launch').click(); await page.locator('#search-input').fill('missing keyword');
  await expect(page.locator('.empty-message')).toContainText('No results found');
});

test('student scheduling creates a named Students Daily record and Daily completion updates Calendar', async ({ page }) => {
  await create(page, 'Synthetic Ada', false);
  await work(page).getByRole('button', { name: 'Schedule conversation', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add event', exact: true });
  await expect(dialog.getByLabel('Title', { exact: true })).toHaveValue('Synthetic Ada · Conversation');
  await expect(dialog.getByLabel('Category (optional)', { exact: true })).toHaveValue('category-1');
  await dialog.getByLabel('Starting time', { exact: true }).fill('2026-10-20T10:00');
  await dialog.getByLabel('Title', { exact: true }).fill('Research planning');
  await dialog.getByRole('button', { name: 'Save event', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const event = (await app.calendar.read()).document.events[0];
  expect(event.title).toBe('Synthetic Ada · Research planning'); expect(event.categoryId).toBe('category-1');
  const dailyOnDisk = JSON.parse(await fs.readFile(path.join(root, '.notebook/daily/workspace.json'), 'utf8'));
  expect(dailyOnDisk.tasks.find(t => t.id === event.id).versions[0].text).toBe(event.title);
  await page.goto(base + '/?view=daily&date=2026-10-20');
  await page.getByRole('checkbox', { name: `Complete ${event.title}`, exact: true }).check();
  await expect(page.locator('#daily-workspace').getByRole('status')).toContainText('Saved to disk');
  await page.goto(base + '/?view=calendar&date=2026-10-20');
  await expect(page.locator(`[data-event="${event.id}"]`).first()).toHaveClass(/completed/);
  await expect(page.locator(`[data-event="${event.id}"]`).first()).toContainText('Completed in Daily');
});

test('notes show exact Markdown source while editing and render only after Done editing', async ({ page }) => {
  await create(page, 'Synthetic Grace');
  await page.getByRole('button', { name: 'Add meeting', exact: true }).click();
  const source = '## Progress\n\n**Evidence** and *analysis*.\n\n- [Source](https://example.com)\n- Second item\n\n```python\nprint("baseline")\n```';
  const correctionSource = '**Corrected** result\n\n- Recheck baseline';
  await rich(page, 'Discussion', source); await rich(page, 'Correction', correctionSource);
  await expect(work(page).getByRole('textbox', { name: 'Discussion', exact: true })).toHaveValue(source);
  await expect(work(page).getByRole('textbox', { name: 'Correction', exact: true })).toHaveValue(correctionSource);
  await expect(work(page).locator('.student-session .student-rich-preview')).toHaveCount(0);
  await expect(work(page).getByRole('toolbar')).toHaveCount(0);
  await saved(page);
  expect((await disk(page)).sessions[0].discussion).toEqual({ type: 'markdown', text: source });
  await page.getByRole('button', { name: 'Done editing supervision record', exact: true }).click();
  const record = work(page).locator('.student-session');
  await expect(record.locator('textarea')).toHaveCount(0);
  await expect(record.getByRole('heading', { name: 'Progress', exact: true })).toBeVisible();
  await expect(record.locator('strong')).toHaveText(['Evidence', 'Corrected']);
  await expect(record.getByRole('link', { name: 'Source', exact: true })).toHaveAttribute('href', 'https://example.com');
  await expect(record.locator('pre code')).toContainText('print("baseline")');
  await page.getByRole('button', { name: 'Edit supervision record', exact: true }).click();
  await expect(work(page).getByRole('textbox', { name: 'Discussion', exact: true })).toHaveValue(source);
  await page.getByRole('button', { name: 'Done editing supervision record', exact: true }).click();
  await page.reload(); await expect(work(page).locator('.student-session strong')).toHaveText(['Evidence', 'Corrected']);
  await editSections(page);
  await expect(work(page).getByRole('textbox', { name: 'Discussion', exact: true })).toHaveValue(source);
  await expect(work(page).getByRole('textbox', { name: 'Correction', exact: true })).toHaveValue(correctionSource);
  await work(page).getByLabel('Search meeting records', { exact: true }).fill('Corrected');
  await expect(work(page).locator('.student-session:visible')).toHaveCount(1);
});


test('supervision follows preparation directly even beside tall objectives, on desktop and mobile', async ({ page }) => {
  await create(page, 'Synthetic layout student', false);
  const id = (await disk(page)).id, item = await app.students.read(id);
  const empty = () => ({ type: 'doc', content: [{ type: 'paragraph' }] });
  item.document.objectives = Array.from({ length: 8 }, (_, index) => ({ id: randomUUID(), title: `Research objective ${index + 1}`, description: empty(), targetDate: '', status: 'Planned', archived: false, milestones: [] }));
  item.document.sessions.push({ id: randomUUID(), date: '2026-10-16', title: 'Baseline review', discussion: empty(), decisions: empty(), correction: empty(), objectiveIds: [], actions: [] });
  await app.students.save(id, item); await page.reload();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const preparation = await page.locator('.student-preparation').boundingBox();
    const history = await page.locator('.student-history').boundingBox();
    const objectives = await page.locator('.student-objectives').boundingBox();
    expect(history.y - (preparation.y + preparation.height)).toBeCloseTo(24, 0);
    if (width > 760) {
      expect(objectives.y).toBeCloseTo(preparation.y, 0);
      expect(objectives.y + objectives.height).toBeGreaterThan(history.y + 200);
    } else expect(objectives.y).toBeGreaterThan(history.y + history.height);
    await expect(page.locator('.student-session .student-next-conversation')).toHaveCount(0);
    await page.screenshot({ path: `/private/tmp/workbench-supervision-layout-${width}.png`, fullPage: true });
  }
});


test('legacy formatted notes open as Markdown source and keep their original data until edited', async ({ page }) => {
  const item = await app.students.create({ name: 'Synthetic legacy notes' });
  item.document.preparation.agenda = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Existing notes', marks: [{ type: 'bold' }] }] }] };
  await app.students.save(item.document.id, item);
  await page.goto(base + '/?view=student&id=' + item.document.id);
  await expect(page.locator('.student-preparation strong')).toHaveText('Existing notes');
  await page.getByRole('button', { name: 'Edit next conversation', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Next meeting agenda', exact: true })).toHaveValue('**Existing notes**');
  await page.getByRole('button', { name: 'Done editing next conversation', exact: true }).click();
  expect((await disk(page)).preparation.agenda.type).toBe('doc');
  await page.getByRole('button', { name: 'Edit next conversation', exact: true }).click();
  await rich(page, 'Next meeting agenda', '**Existing notes**\n\nNew details'); await saved(page);
  await page.getByRole('button', { name: 'Done editing next conversation', exact: true }).click();
  await expect(page.locator('.student-preparation strong')).toHaveText('Existing notes');
  await expect(page.locator('.student-preparation')).toContainText('New details');
});


test('Chinese punctuation labels render bold in supervision previews without changing source', async ({ page }) => {
  await create(page, 'Synthetic CJK');
  await page.getByRole('button', { name: 'Add meeting', exact: true }).click();
  const source = '## 讨论\n\n- **来源：**录音\n- **现场修订：**合并章节\n\n**[论文](https://example.com)：**供参考\n\n`**代码：**保持原样`\n\n$y = x^2$\n\n<script>window.cjkInjected = true</script>';
  await rich(page, 'Discussion', source);
  await rich(page, 'Correction', '**技术澄清：**保留证据边界');
  await saved(page);
  await page.getByRole('button', { name: 'Done editing supervision record', exact: true }).click();
  const record = work(page).locator('.student-session');
  await expect(record.locator('strong')).toHaveText(['来源：', '现场修订：', '论文：', '技术澄清：']);
  await expect(record.getByRole('link', { name: '论文', exact: true })).toHaveAttribute('href', 'https://example.com');
  await expect(record.locator('code')).toHaveText('**代码：**保持原样');
  await expect(record.locator('.katex')).toHaveCount(1);
  expect(await page.evaluate(() => window.cjkInjected)).toBeUndefined();
  expect((await disk(page)).sessions[0].discussion.text).toBe(source);
  await page.reload();
  await expect(work(page).locator('.student-session strong')).toHaveText(['来源：', '现场修订：', '论文：', '技术澄清：']);
});

test('roster filters combine profile fields, current groups, search and archive status', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-20T04:00:00Z'));
  const add = async (name, profile = {}, archived = false) => {
    const item = await app.students.create({ name, profile });
    item.document.archived = archived;
    return (await app.students.save(item.document.id, item)).document.id;
  };
  const ada = await add('Ada Example', { schoolId: 'SYSU', program: 'PhD', entryYear: '2025', researchAreas: 'Robotics' });
  const grace = await add('Grace Example', { schoolId: 'SUAT', program: 'MSc', entryYear: '2026' });
  await add('Future Example', { schoolId: 'SYSU', program: 'PhD', entryYear: '2027' });
  await add('Missing Example');
  await add('Archived Example', { schoolId: 'SYSU', program: 'PhD', entryYear: '2025' }, true);
  await app.groups.create({ name: 'Current Lab', memberIds: [ada, grace], leaderId: ada });
  const oldGroup = await app.groups.create({ name: 'Former Lab', memberIds: [ada], leaderId: ada });
  oldGroup.document.archived = true;
  await app.groups.save(oldGroup.document.id, oldGroup);
  await page.reload();
  const filter = label => work(page).getByLabel(label, { exact: true });
  const choose = (label, value) => filter(label).selectOption({ label: value });
  const names = work(page).locator('.student-card h2');
  const clear = () => work(page).getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(names).toHaveCount(4);
  const schoolOptions = await filter('School').locator('option').allTextContents();
  await choose('Group', 'Current Lab'); await expect(names).toHaveText(['Ada Example', 'Grace Example']);
  await choose('School', 'SYSU'); await expect(names).toHaveText(['Ada Example']);
  await choose('Degree / program', 'PhD'); await choose('Entry year', '2025'); await choose('Current study year', 'Year 2');
  await filter('Search students').fill('ROBOTICS'); await expect(names).toHaveText(['Ada Example']);
  await expect(filter('School').locator('option')).toHaveText(schoolOptions);
  await work(page).locator('.student-card').click();
  await work(page).getByRole('button', { name: 'All students', exact: true }).click();
  await expect(filter('Entry year')).toHaveValue('value:2025'); await expect(filter('Search students')).toHaveValue('ROBOTICS');
  await choose('Current study year', 'Year 1'); await expect(names).toHaveCount(0);
  await expect(work(page)).toContainText('No students match your search or filters');
  await clear(); await expect(names).toHaveCount(4);
  await expect(filter('Search students')).toHaveValue('');
  await choose('Group', 'Former Lab (Archived)'); await expect(names).toHaveText(['Ada Example']);
  await clear(); await choose('Group', 'No group'); await expect(names).toHaveText(['Future Example', 'Missing Example']);
  await clear(); await choose('School', 'Unassigned'); await expect(names).toHaveText(['Missing Example']);
  await clear(); await choose('Degree / program', 'Unassigned'); await expect(names).toHaveText(['Missing Example']);
  await clear(); await choose('Entry year', 'Unassigned'); await expect(names).toHaveText(['Missing Example']);
  await clear(); await choose('Current study year', 'Unassigned'); await expect(names).toHaveText(['Missing Example']);
  await clear(); await choose('Current study year', 'Not started'); await expect(names).toHaveText(['Future Example']);
  await clear(); await choose('Entry year', '2026'); await expect(names).toHaveText(['Grace Example']);
  await clear(); await choose('Degree / program', 'MSc'); await expect(names).toHaveText(['Grace Example']);
  await clear(); await filter('Search students').fill('PhD'); await expect(names).toHaveCount(0);
  await clear(); await choose('Show students', 'Archived'); await choose('School', 'SYSU'); await clear();
  await expect(filter('Show students')).toHaveValue('archived'); await expect(names).toHaveText(['Archived Example']);
  await choose('Show students', 'All'); await choose('Entry year', '2025'); await expect(names).toHaveText(['Ada Example', 'Archived Example']);
  await page.reload(); await expect(filter('Entry year')).toHaveValue(''); await expect(names).toHaveCount(4);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#sidebar')).not.toBeInViewport();
  await filter('Group').focus(); await page.keyboard.press('n'); await page.keyboard.press('Tab');
  await expect(filter('Group')).toHaveValue('missing');
  const bounds = await work(page).locator('.student-roster-filters').evaluate(node => {
    const area = node.getBoundingClientRect();
    return [...node.querySelectorAll('select, button')].every(child => { const rect = child.getBoundingClientRect(); return rect.left >= Math.max(0, area.left) && rect.right <= Math.min(innerWidth, area.right) + 1; });
  });
  expect(bounds).toBe(true);
  await page.screenshot({ path: '/private/tmp/students-roster-filters-mobile.png', fullPage: true });
});

test('current study year filter follows September rollover independently of entry year', async ({ page }) => {
  await app.students.create({ name: 'Cohort Example', profile: { entryYear: '2026' } });
  await page.clock.setFixedTime(new Date('2027-08-31T04:00:00Z')); await page.reload();
  await work(page).getByLabel('Entry year', { exact: true }).selectOption({ label: '2026' });
  await work(page).getByLabel('Current study year', { exact: true }).selectOption({ label: 'Year 1' });
  await expect(work(page).locator('.student-card h2')).toHaveText(['Cohort Example']);
  await page.clock.setFixedTime(new Date('2027-09-01T04:00:00Z')); await page.reload();
  await work(page).getByLabel('Entry year', { exact: true }).selectOption({ label: '2026' });
  await work(page).getByLabel('Current study year', { exact: true }).selectOption({ label: 'Year 2' });
  await expect(work(page).locator('.student-card h2')).toHaveText(['Cohort Example']);
  await page.screenshot({ path: '/private/tmp/students-roster-filters-desktop.png', fullPage: true });
});
