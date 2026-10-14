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
test.afterEach(async ({ context }) => { for (const page of context.pages()) await page.close(); await app.terminals.close(); await app.kernels.close(); await new Promise(resolve => app.server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
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
  await page.getByLabel('Next meeting', { exact: true }).fill('2026-10-16'); await rich(page, 'Next meeting agenda', '讨论实验设计');
  const agenda = page.getByRole('textbox', { name: 'Next meeting agenda', exact: true }); await agenda.press('ControlOrMeta+A'); await page.getByRole('toolbar', { name: 'Next meeting agenda formatting' }).getByRole('button', { name: 'Bold', exact: true }).click();
  await saved(page); await page.getByRole('button', { name: 'Start meeting', exact: true }).click(); await expect(page.getByLabel('Next meeting', { exact: true })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Discussion', exact: true })).toContainText('讨论实验设计'); await expect(page.getByRole('textbox', { name: 'Discussion', exact: true }).locator('strong')).toContainText('讨论实验设计');
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

test('mobile layout, keyboard save, numbered lists, links and failed meeting-start recovery', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await create(page); await goal(page); await rich(page, 'Next meeting agenda', 'Discuss baseline'); await page.getByRole('toolbar', { name: 'Next meeting agenda formatting' }).getByRole('button', { name: 'Numbered list', exact: true }).click(); await page.keyboard.press('ControlOrMeta+S'); await saved(page);
  const agenda = page.getByRole('textbox', { name: 'Next meeting agenda', exact: true }); await agenda.click(); await agenda.press('ControlOrMeta+A'); page.once('dialog', d => d.accept('https://example.com/paper')); await page.getByRole('toolbar', { name: 'Next meeting agenda formatting' }).getByRole('button', { name: 'Link', exact: true }).click(); await saved(page); expect((await disk(page)).preparation.agenda.content[0].type).toBe('orderedList');
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
  await page.getByLabel('Entry year', { exact: true }).fill('2025');
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
  await page.getByLabel('Next meeting', { exact: true }).fill('2026-10-16'); await rich(page, 'Next meeting agenda', '讨论方法');
  await page.getByRole('textbox', { name: 'Next meeting agenda', exact: true }).press('ControlOrMeta+A');
  await page.getByRole('toolbar', { name: 'Next meeting agenda formatting' }).getByRole('button', { name: 'Bold', exact: true }).click();
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
  await create(page, 'Search student'); await rich(page, 'Next meeting agenda', 'The student said 数学二 does not test linear spaces.'); await saved(page);
  await page.getByRole('button', { name: 'Start meeting', exact: true }).click(); await saved(page);
  await goal(page, 'Archived keyword objective'); await saved(page);
  await page.getByRole('button', { name: 'Archive objective', exact: true }).click(); await saved(page);
  await page.getByRole('button', { name: 'Archive student', exact: true }).click(); await saved(page);
  const studentUrl = page.url();
  await page.locator('#search-launch').click(); await page.locator('#search-input').fill('数学二');
  await expect(page.locator('#search-summary')).toHaveText('1 matching result · 1 text match');
  await expect(page.locator('.result-group')).toContainText('Archived student');
  await expect(page.locator('.result-snippet mark')).toHaveText('数学二');
  await page.locator('.result-snippet').click(); await expect(page).toHaveURL(studentUrl);
  await expect(page.locator('.student-session')).toHaveAttribute('open', '');
  await expect(page.locator('.student-session')).toContainText('数学二');
  await page.locator('#search-launch').click(); await page.locator('#search-input').fill('Archived keyword');
  await expect(page.locator('#search-summary')).toHaveText('1 matching result · 1 text match');
  await page.locator('.result-snippet').click(); await expect(page).toHaveURL(studentUrl);
  await expect(work(page).getByText('Archived keyword objective', { exact: true }).first()).toBeVisible();
  await page.locator('#search-launch').click(); await page.locator('#search-input').fill('missing keyword');
  await expect(page.locator('.empty-message')).toContainText('No results found');
});
