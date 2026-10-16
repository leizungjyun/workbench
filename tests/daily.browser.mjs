import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
let root, app, base;
const work = page => page.locator('#daily-workspace');
const saved = page => expect(work(page).getByRole('status')).toContainText('Saved to disk');
async function add(page, title = 'Read paper', category = 'Learning') { const input = page.getByLabel(`Add task to ${category}`, { exact: true }); await input.fill(title); await input.press('Enter'); }
async function date(page, value) { await page.getByLabel('Daily date', { exact: true }).fill(value); await expect(work(page).locator('h1')).toHaveText(value); }
async function rich(page, label, value) { await page.getByRole('button', { name: `Edit ${label.toLowerCase()}`, exact: true }).click(); await page.getByLabel(label, { exact: true }).fill(value); }
const disk = async () => (await app.daily.read()).document;
test.beforeEach(async ({ page }) => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldnotes-daily-ui-')); await fs.mkdir(path.join(root, 'collections/schedule'), { recursive: true });
  await fs.writeFile(path.join(root, 'collections/Notebook.md'), '# Notebook\nneedle');
  await fs.writeFile(path.join(root, 'collections/schedule/2026.md'), '# 2026-10-10\n- 学习\n  - [ ] git github\n- 杂事\n  - Example review\n# 2026-10-09\n- 学习\n  - [ ] git github\n  - [x] Completed lecture\n# 2026-10-08\n- [ ] Do not import\n');
  await fs.symlink(path.resolve('dist'), path.join(root, 'dist')); app = await createApp(root); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
  await page.goto(`${base}/?view=daily&date=2026-10-09`); await expect(work(page).locator('h1')).toHaveText('2026-10-09');
});
test.afterEach(async ({ context }) => { for (const page of context.pages()) await page.close(); await app.terminals.close(); await app.kernels.close(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });

test('tasks, formatting, optional details, student link, notes, and exports survive reload', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const student = await app.students.create({ name: 'Student A' }); await page.reload();
  await expect(work(page).locator('.daily-group h2')).toHaveText(['Learning', 'Students', 'Projects', 'Papers', 'Development', 'Miscellaneous']);
  await page.getByLabel('Add task to Learning', { exact: true }).press('Enter'); expect((await disk()).tasks).toHaveLength(0);
  await add(page, 'needle research'); await page.getByRole('button', { name: 'Details', exact: true }).click();
  await page.getByLabel('Time', { exact: true }).fill('17:10'); await page.getByLabel('Deadline', { exact: true }).fill('2026-10-15'); await page.getByLabel('Student', { exact: true }).selectOption(student.document.id); await expect(page.getByRole('link', { name: 'Open student', exact: true })).toBeVisible();
  await rich(page, 'Task notes', '中文 needle https://example.com'); const notes = page.getByLabel('Task notes', { exact: true }); await notes.selectText(); await page.getByRole('toolbar', { name: 'Task notes formatting' }).getByRole('button', { name: 'Bold', exact: true }).click();
  await page.getByLabel('Add subtask', { exact: true }).fill('Run baseline'); await page.getByLabel('Add subtask', { exact: true }).press('Enter'); await page.getByLabel('Complete subtask Run baseline', { exact: true }).check();
  await rich(page, 'Daily notes', 'Reflection needle'); await page.keyboard.press('ControlOrMeta+s'); await saved(page);
  const doc = await disk(); expect(doc.tasks[0].versions[0].studentId).toBe(student.document.id); expect(doc.tasks[0].versions[0].details).toContain('**'); expect(doc.tasks[0].versions[0].subtasks[0].done).toBe(true);
  await page.reload(); await page.getByRole('button', { name: 'Details', exact: true }).click(); await expect(work(page).locator('.daily-prose strong')).toContainText('中文 needle'); await expect(page.getByLabel('Deadline', { exact: true })).toHaveValue('2026-10-15'); await expect(work(page)).toContainText('Reflection needle');
  for (const [button, filename] of [['Export JSON', 'workbench-daily.json'], ['Export Markdown', 'workbench-daily.md']]) { const download = page.waitForEvent('download'); await page.getByRole('button', { name: button, exact: true }).click(); expect((await download).suggestedFilename()).toBe(filename); }
  expect(errors).toEqual([]); await page.screenshot({ path: '/tmp/fieldnotes-daily.png', fullPage: true });
});

test('carry-forward preserves history; completion, reopening, scheduling, cancellation and undo', async ({ page }) => {
  await add(page); await saved(page); const id = (await disk()).tasks[0].id;
  await date(page, '2026-10-15'); await expect(work(page).locator('.daily-task')).toHaveCount(1); await expect(work(page)).toContainText('From 2026-10-09');
  await page.getByLabel('Complete Read paper', { exact: true }).check(); await saved(page);
  await date(page, '2026-10-09'); await expect(page.getByLabel('Complete Read paper', { exact: true })).not.toBeChecked(); await expect(work(page)).toContainText('Later completed on 2026-10-15');
  await date(page, '2026-10-16'); await expect(work(page).locator('.daily-task')).toHaveCount(0); await page.getByText('Finished tasks (1)', { exact: true }).click(); await page.getByRole('button', { name: 'Reopen today', exact: true }).click(); await saved(page); expect((await disk()).tasks[0].id).toBe(id);
  await page.getByRole('button', { name: 'Details', exact: true }).click(); await page.getByLabel('Reschedule to', { exact: true }).fill('2026-10-20'); await page.getByRole('button', { name: 'Reschedule', exact: true }).click(); await saved(page);
  await date(page, '2026-10-19'); await expect(work(page).locator('.daily-task')).toHaveCount(0); await date(page, '2026-10-20'); await expect(work(page).locator('.daily-task')).toHaveCount(1);
  await page.getByRole('button', { name: 'Details', exact: true }).click(); await page.getByRole('button', { name: 'Cancel task', exact: true }).click(); await expect(work(page).locator('.daily-task')).toHaveCount(0); await page.getByRole('button', { name: 'Undo task change', exact: true }).click(); await expect(work(page).locator('.daily-task')).toHaveClass(/open/); await saved(page);
});

test('category edits, hiding, ordering and adding preserve tasks', async ({ page }) => {
  await add(page); await page.getByRole('button', { name: 'Categories', exact: true }).click(); const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Category name', { exact: true }).first().fill('Reading'); await dialog.getByRole('button', { name: 'Hide', exact: true }).first().click(); await dialog.getByRole('button', { name: 'Move down', exact: true }).first().click();
  await dialog.getByLabel('New category', { exact: true }).fill('Music'); await dialog.getByRole('button', { name: 'Add category', exact: true }).click(); await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(work(page).locator('.daily-group h2').first()).toHaveText('Students'); await expect(work(page)).toContainText('Reading'); await expect(page.getByLabel('Add task to Reading', { exact: true })).toHaveCount(0); await expect(page.getByLabel('Task', { exact: true })).toHaveValue('Read paper'); await add(page, 'Piano', 'Music'); await saved(page); await page.reload(); expect((await disk()).tasks).toHaveLength(2);
});

test('global search opens matching historical tasks and daily notes with highlights', async ({ page }) => {
  await add(page, 'needle original'); await rich(page, 'Daily notes', 'needle reflection'); await saved(page);
  await date(page, '2026-10-10'); await page.getByLabel('Task', { exact: true }).fill('Renamed task'); await page.getByLabel('Complete Renamed task', { exact: true }).check(); await saved(page);
  await page.getByRole('button', { name: /Search/ }).first().click(); await page.getByLabel('Search all notes', { exact: true }).fill('needle');
  await expect(page.locator('#search-results .result-group')).toHaveCount(3); await expect(page.locator('#search-summary')).toContainText('3 matching results');
  await page.locator('#search-results .result-group').filter({ hasText: 'Renamed task' }).locator('.result-snippet').first().click(); await expect(page).toHaveURL(/view=daily&date=2026-10-09&task=/); await expect(page.getByLabel('Task', { exact: true })).toHaveValue('needle original'); await expect(page.getByLabel('Task', { exact: true })).toHaveClass(/daily-match/);
  await page.keyboard.press('ControlOrMeta+k'); await page.locator('#search-results .result-group').filter({ hasText: 'Daily notes' }).locator('.result-snippet').first().click(); await expect(work(page).locator('.daily-prose mark')).toHaveText('needle');
  await page.goBack(); await expect(work(page).locator('h1')).toHaveText('2026-10-09');
});

test('import requires preview acceptance, restricts dates, maps categories, and does not repeat', async ({ page }) => {
  const original = await fs.readFile(path.join(root, 'collections/schedule/2026.md'), 'utf8'); await page.getByRole('button', { name: 'Import from Markdown', exact: true }).click(); await page.getByLabel('Source Markdown notebook').selectOption('schedule/2026.md'); await page.getByLabel('From date', { exact: true }).fill('2026-10-09'); await page.getByLabel('Through date', { exact: true }).fill('2026-10-10'); await page.getByRole('button', { name: 'Review import', exact: true }).click(); await expect(page.getByRole('dialog')).toContainText('2 tasks'); expect((await disk()).tasks).toHaveLength(0);
  await page.getByRole('button', { name: 'Apply import', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); await saved(page); const doc = await disk(); expect(doc.tasks).toHaveLength(2); expect(doc.tasks.find(t => t.versions[0].text === 'git github').appearances).toEqual(['2026-10-09', '2026-10-10']); expect(doc.days['2026-10-10'].notes).toContain('## Miscellaneous');
  await date(page, '2026-10-11'); await expect(page.getByLabel('Task', { exact: true })).toHaveValue('git github'); await page.getByRole('button', { name: 'Import from Markdown', exact: true }).click(); await page.getByRole('button', { name: 'Review import', exact: true }).click(); await expect(page.getByRole('dialog')).toContainText('No new dates'); await expect(page.getByRole('button', { name: 'Apply import', exact: true })).toHaveCount(0); expect(await fs.readFile(path.join(root, 'collections/schedule/2026.md'), 'utf8')).toBe(original);
});

test('failed save blocks navigation, recovers draft on reload and allows retry', async ({ page }) => {
  await page.route('**/api/daily', async route => { if (route.request().method() === 'PUT') await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Simulated failure' }) }); else await route.continue(); });
  await add(page, 'Unsaved draft'); await expect(work(page).getByRole('status')).toContainText('Save failed'); await page.getByRole('button', { name: 'Next day', exact: true }).click(); await expect(work(page).locator('h1')).toHaveText('2026-10-09');
  page.on('dialog', dialog => dialog.accept()); await page.reload(); await expect(page.getByLabel('Task', { exact: true })).toHaveValue('Unsaved draft'); await expect(work(page).getByRole('status')).toContainText('Save failed');
  await page.unroute('**/api/daily'); await page.getByRole('button', { name: 'Retry save', exact: true }).click(); await saved(page); expect((await disk()).tasks[0].versions[0].text).toBe('Unsaved draft');
});

test('conflicts compare reviewed versions; a second tab is read-only and can claim editing', async ({ page, context }) => {
  await add(page); await saved(page);
  const second = await context.newPage(); await second.goto(page.url()); await expect(work(second).getByRole('status')).toContainText('Read-only'); await expect(second.getByLabel('Add task to Learning', { exact: true })).toBeDisabled();
  const file = path.join(root, '.notebook/daily/workspace.json'); const external = await disk(); external.days['2026-10-09'] = { notes: 'External notes' }; await fs.writeFile(file, JSON.stringify(external));
  await page.getByLabel('Task', { exact: true }).fill('My draft'); await expect(work(page).getByRole('status')).toContainText('Conflict');
  await page.getByRole('button', { name: 'Compare', exact: true }).click(); await expect(page.getByRole('dialog')).toContainText('External notes'); await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Overwrite with draft', exact: true }).click(); page.once('dialog', d => d.accept()); await page.getByRole('button', { name: 'Replace reviewed disk version', exact: true }).click(); await saved(page); expect((await disk()).tasks[0].versions[0].text).toBe('My draft');
  await page.getByRole('button', { name: 'Students', exact: true }).click(); await expect(page.locator('#students-workspace h1')).toHaveText('Students'); await second.getByRole('button', { name: 'Claim editing', exact: true }).click(); await saved(second); await add(second, 'Second tab task'); await saved(second); expect((await disk()).tasks).toHaveLength(2);
});

test('local date rollover carries tasks while app stays open', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-09T23:59:50') }); await page.reload(); await expect(work(page).locator('h1')).toHaveText('2026-10-09'); await page.getByRole('button', { name: 'Today', exact: true }).click(); await add(page, 'Midnight task'); await page.clock.runFor(1000); await saved(page);
  await page.clock.runFor(15000); await expect(work(page).locator('h1')).toHaveText('2026-10-10'); await expect(page.getByLabel('Task', { exact: true })).toHaveValue('Midnight task'); expect((await disk()).tasks).toHaveLength(1);
});

test('date navigation disables stale controls until the new day loads', async ({ page }) => {
  let resume, started;
  const gate = new Promise(resolve => { resume = resolve; });
  const requestStarted = new Promise(resolve => { started = resolve; });
  await page.route('**/api/daily', async route => {
    if (route.request().method() === 'GET') { started(); await gate; }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Next day', exact: true }).click(); await requestStarted;
  await expect(page.getByLabel('Add task to Learning', { exact: true })).toBeDisabled();
  resume(); await expect(work(page).locator('h1')).toHaveText('2026-10-10');
  await add(page, 'Task after navigation'); await saved(page);
  expect((await disk()).tasks[0].originDate).toBe('2026-10-10');
});

test('compact categories occupy two columns with a live day preview and notes at the top', async ({ page }) => {
  const editor = work(page).locator('.daily-editor'), preview = work(page).getByRole('complementary', { name: 'Day preview' });
  await expect(editor.locator(':scope > section').first()).toContainText('Daily notes');
  await expect(page.getByLabel('Add task to Uncategorized', { exact: true })).toHaveCount(0);
  await add(page, 'Study circuits'); await add(page, 'Review project', 'Projects');
  await rich(page, 'Daily notes', 'Today’s reflection'); await expect(preview).toContainText('Today’s reflection');
  const task = work(page).locator('.daily-task').first(); await task.getByRole('button', { name: 'Details', exact: true }).click();
  await task.getByLabel('Time', { exact: true }).fill('14:30'); await expect(preview).toContainText('14:30');
  await task.getByLabel('Task', { exact: true }).fill('Study electronics'); await expect(preview).toContainText('Study electronics');
  await task.getByRole('checkbox', { name: 'Complete Study electronics', exact: true }).check(); await expect(preview).toContainText('1 / 2 completed');
  await saved(page);
  const groups = await work(page).locator('.daily-group').all();
  const boxes = await Promise.all([editor.boundingBox(), preview.boundingBox(), ...groups.slice(0, 2).map(n => n.boundingBox())]);
  expect(boxes[0].x + boxes[0].width).toBeLessThan(boxes[1].x);
  expect(boxes[2].x).toBeLessThan(boxes[3].x); expect(Math.abs(boxes[2].y - boxes[3].y)).toBeLessThan(2);
  await page.screenshot({ path: '/tmp/fieldnotes-daily-three-columns.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(preview).toBeVisible();
});

test('remove is available without details and preserves undo, history and search', async ({ page }) => {
  await add(page, 'Remove this task'); await saved(page);
  await expect(page.getByLabel('Time', { exact: true })).toHaveCount(0);
  await work(page).getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(work(page).locator('.daily-task')).toHaveCount(0); await expect(work(page).getByRole('complementary', { name: 'Day preview' })).not.toContainText('Remove this task');
  await saved(page); expect((await disk()).tasks[0].versions.at(-1).status).toBe('cancelled');
  await page.getByRole('button', { name: 'Undo task change', exact: true }).click(); await expect(page.getByLabel('Task', { exact: true })).toHaveValue('Remove this task');
  await page.getByRole('button', { name: 'Remove', exact: true }).click(); await saved(page); await page.reload(); await expect(work(page).locator('.daily-task')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+k'); await page.getByLabel('Search all notes', { exact: true }).fill('Remove this task');
  await page.locator('#search-results .result-snippet').first().click(); await expect(page.getByLabel('Task', { exact: true })).toHaveValue('Remove this task');
  await page.getByRole('button', { name: 'Remove', exact: true }).click(); await expect(work(page).locator('.daily-task')).toHaveCount(0);
  await date(page, '2026-10-10'); await expect(work(page).locator('.daily-task')).toHaveCount(0);
});

test('legacy uncategorized disk and browser drafts merge into Miscellaneous without a false conflict', async ({ page }) => {
  await add(page, 'Legacy item', 'Miscellaneous'); await saved(page);
  const legacy = await disk(); legacy.tasks[0].versions[0].categoryId = '';
  await fs.writeFile(path.join(root, '.notebook/daily/workspace.json'), JSON.stringify(legacy));
  const revision = (await app.daily.read()).revision;
  await page.evaluate(({ document, revision }) => localStorage.setItem('fieldnotes-daily-draft', JSON.stringify({ document, revision })), { document: legacy, revision });
  await page.reload(); await saved(page);
  await expect(work(page).locator('.daily-group').filter({ has: page.getByRole('heading', { name: 'Miscellaneous', exact: true }) }).getByLabel('Task', { exact: true })).toHaveValue('Legacy item');
  await expect(work(page).getByRole('complementary', { name: 'Day preview' })).toContainText('Miscellaneous');
});

async function cardGeometry(page) {
  return work(page).locator('.daily-groups').evaluate(container => {
    const origin = container.getBoundingClientRect();
    return { height: origin.height, cards: [...container.children].map(card => {
      const box = card.getBoundingClientRect();
      return { name: card.querySelector('h2').textContent, x: box.x - origin.x, y: box.y - origin.y, width: box.width, height: box.height };
    }) };
  });
}
function expectPacked({ height, cards }, columns = 2) {
  const bottoms = Array(columns).fill(0);
  for (const card of cards) {
    const column = columns === 1 || card.x < 1 ? 0 : 1;
    expect(column).toBe(bottoms.indexOf(Math.min(...bottoms)));
    expect(Math.abs(card.y - bottoms[column])).toBeLessThan(1);
    bottoms[column] += card.height + 12;
  }
  expect(Math.abs(height - (Math.max(...bottoms) - 12))).toBeLessThan(1);
}

test('unequal cards pack into the shorter column and reflow after Details, removal and resizing', async ({ page }) => {
  for (let i = 0; i < 4; i++) await add(page, `Long Learning ${i}`);
  await add(page, 'Student preparation', 'Students');
  await page.getByLabel('Add task to Papers', { exact: true }).blur();
  await expect.poll(async () => (await cardGeometry(page)).cards[2].x).toBeGreaterThan(0);
  expectPacked(await cardGeometry(page));
  await expect(work(page).locator('.daily-group h2')).toHaveText(['Learning', 'Students', 'Projects', 'Papers', 'Development', 'Miscellaneous']);
  const first = work(page).locator('.daily-task').first();
  await first.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(first.getByLabel('Time', { exact: true })).toBeVisible();
  await expect.poll(async () => (await cardGeometry(page)).cards[0].height).toBeGreaterThan(800);
  expectPacked(await cardGeometry(page));
  await page.screenshot({ path: '/tmp/workbench-daily-packed-cards.png', fullPage: true });
  await first.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(work(page).locator('.daily-task')).toHaveCount(4);
  await expect.poll(async () => (await cardGeometry(page)).cards[0].height).toBeLessThan(600);
  expectPacked(await cardGeometry(page));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(work(page).locator('.daily-groups-positioned')).toHaveCount(0);
  expectPacked(await cardGeometry(page), 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(work(page).locator('.daily-groups-positioned')).toHaveCount(1);
  expectPacked(await cardGeometry(page));
});

test('editing height preserves columns, focus and selection until leaving the card', async ({ page }) => {
  await add(page, 'Editable task');
  for (let i = 0; i < 7; i++) await add(page, `Student task ${i}`, 'Students');
  await work(page).locator('.daily-task').nth(1).getByRole('button', { name: 'Details', exact: true }).click();
  const first = work(page).locator('.daily-task').first();
  await first.getByRole('button', { name: 'Details', exact: true }).click();
  await first.getByRole('button', { name: 'Edit task notes', exact: true }).click();
  const notes = first.getByLabel('Task notes', { exact: true }); await notes.fill('Draft note');
  await expect.poll(async () => (await cardGeometry(page)).cards[2].x).toBe(0);
  const before = await cardGeometry(page);
  // Native textarea resizing changes real card height without changing its data.
  await notes.evaluate(input => { input.style.height = '1100px'; input.setSelectionRange(2, 5); });
  await expect.poll(async () => (await cardGeometry(page)).cards[0].height).toBeGreaterThan(before.cards[0].height + 800);
  await expect.poll(async () => (await cardGeometry(page)).cards[2].y).toBeGreaterThan(before.cards[2].y + 800);
  const during = await cardGeometry(page);
  expect(during.cards.map(card => card.x)).toEqual(before.cards.map(card => card.x));
  await expect(notes).toBeFocused();
  expect(await notes.evaluate(input => [input.selectionStart, input.selectionEnd])).toEqual([2, 5]);
  for (const card of during.cards) {
    const previous = during.cards.filter(other => other.x === card.x && other.y < card.y).at(-1);
    if (previous) expect(Math.abs(card.y - previous.y - previous.height - 12)).toBeLessThan(1);
  }
  await page.getByLabel('Daily date', { exact: true }).focus();
  await expect.poll(async () => {
    try { expectPacked(await cardGeometry(page)); return true; } catch { return false; }
  }).toBe(true);
  expect((await cardGeometry(page)).cards.map(card => card.x)).not.toEqual(before.cards.map(card => card.x));
  await saved(page); expect((await disk()).tasks[0].versions[0].details).toBe('Draft note');
});

test('completed tasks move to the end of their category, with stable groups, reopening, undo and dated history', async ({ page }) => {
  await add(page, 'First task'); await add(page, 'Second task'); await add(page, 'Third task');
  await add(page, 'Separate project', 'Projects'); await saved(page);
  const ids = (await disk()).tasks.map(task => task.id);
  const learning = work(page).locator('.daily-group').filter({ has: page.getByRole('heading', { name: 'Learning', exact: true }) });
  const order = () => learning.getByLabel('Task', { exact: true }).evaluateAll(inputs => inputs.map(input => input.value));
  await page.getByLabel('Complete First task', { exact: true }).check();
  expect(await order()).toEqual(['Second task', 'Third task', 'First task']);
  await page.getByLabel('Complete Third task', { exact: true }).check();
  expect(await order()).toEqual(['Second task', 'First task', 'Third task']);
  await expect(work(page).locator('.daily-day-preview .daily-preview-title')).toHaveText(['○ Second task', '✓ First task', '✓ Third task', '○ Separate project']);
  await page.getByLabel('Complete First task', { exact: true }).uncheck();
  expect(await order()).toEqual(['First task', 'Second task', 'Third task']);
  await page.getByRole('button', { name: 'Undo task change', exact: true }).click();
  expect(await order()).toEqual(['Second task', 'First task', 'Third task']);
  await saved(page); await page.reload(); await expect.poll(order).toEqual(['Second task', 'First task', 'Third task']);
  expect((await disk()).tasks.map(task => task.id)).toEqual(ids);
  await date(page, '2026-10-10'); expect(await order()).toEqual(['Second task']);
  await expect(page.getByLabel('Task', { exact: true })).toHaveCount(2);
  await date(page, '2026-10-09'); expect(await order()).toEqual(['Second task', 'First task', 'Third task']);
});
