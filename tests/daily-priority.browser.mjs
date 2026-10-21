import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';
import { newTask, updateTask, stateAt } from '../daily-model.js';
let root, app, base, ids;
const work = page => page.locator('#daily-workspace');
const row = (page, name) => work(page).locator(`[data-task="${ids[name]}"]`);
const priority = page => work(page).getByRole('region', { name: 'Priority tasks', exact: true });
const values = (locator, expected) => expect.poll(() => locator.evaluateAll(nodes => nodes.map(node => node.value))).toEqual(expected);
const saved = page => expect(work(page).getByRole('status')).toContainText('Saved to disk');
async function date(page, value) { await page.getByLabel('Daily date', { exact: true }).fill(value); await expect(work(page).locator('h1')).toHaveText(value); }
test.beforeEach(async ({ page }) => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-priority-ui-')); await fs.mkdir(path.join(root, 'collections')); await fs.symlink(path.resolve('dist'), path.join(root, 'dist')); app = await createApp(root, { now: () => Date.parse('2026-10-22T00:00:00Z') });
  const daily = await app.daily.read(); ids = {};
  for (const [name, category] of [['Alpha', 'category-0'], ['Beta', 'category-2'], ['Gamma', 'category-0']]) { const task = newTask(randomUUID(), '2026-10-20', name, category); ids[name] = task.id; daily.document.tasks.push(task); }
  const future = newTask(randomUUID(), '2026-10-20', 'Future priority', 'category-0'); updateTask(future, '2026-10-20', { priority: true, scheduledDate: '2026-10-25' }); daily.document.tasks.push(future); ids.Future = future.id;
  daily.document.days['2026-10-22'] = { notes: 'Synthetic daily reflection' }; await app.daily.save(daily);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
  await page.clock.install({ time: new Date('2026-10-22T00:00:00Z') }); await page.goto(base + '/?view=daily&date=2026-10-22'); await expect(work(page).locator('h1')).toHaveText('2026-10-22');
});
test.afterEach(async ({ context }) => { for (const page of context.pages()) await page.close(); await app.terminals.close(); await app.kernels.close(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });

test('priority moves unique rows above notes, retains category and order, and mirrors Day preview', async ({ page }) => {
  await expect(priority(page)).toHaveCount(0); await expect(row(page, 'Future')).toHaveCount(0);
  await page.getByLabel('Add task to Learning', { exact: true }).fill('Unsubmitted task draft');
  await row(page, 'Beta').getByRole('button', { name: 'Mark priority', exact: true }).click(); await row(page, 'Alpha').getByRole('button', { name: 'Mark priority', exact: true }).click();
  await values(priority(page).getByLabel('Task', { exact: true }), ['Alpha', 'Beta']); await expect(priority(page).locator('.daily-priority-category')).toHaveText(['Learning', 'Projects']); await expect(work(page).locator('.daily-task')).toHaveCount(3);
  expect(await priority(page).evaluate(n => n.nextElementSibling.classList.contains('daily-formatted'))).toBe(true); await expect(page.getByLabel('Add task to Learning', { exact: true })).toHaveValue('Unsubmitted task draft'); await expect(row(page, 'Alpha').getByRole('button', { name: 'Unmark priority', exact: true })).toBeFocused();
  const preview = work(page).getByRole('complementary', { name: 'Day preview' }); await expect(preview.locator('.daily-preview-priority .daily-preview-title')).toHaveText(['★ Alpha', '★ Beta']); await expect(preview.locator('.daily-preview-task')).toHaveCount(3); await expect(preview).toContainText('0 / 3 completed');
  await page.screenshot({ path: '/private/tmp/workbench-priority-desktop.png', animations: 'disabled' }); await page.setViewportSize({ width: 390, height: 844 }); await expect.poll(() => work(page).evaluate(n => n.scrollWidth <= n.clientWidth)).toBe(true); await work(page).evaluate(n => { n.scrollTop = 0; }); await page.screenshot({ path: '/private/tmp/workbench-priority-mobile.png', animations: 'disabled' });
  await row(page, 'Alpha').getByRole('button', { name: 'Unmark priority', exact: true }).click(); await expect(row(page, 'Alpha').getByRole('button', { name: 'Mark priority', exact: true })).toBeFocused(); await row(page, 'Beta').getByRole('button', { name: 'Unmark priority', exact: true }).click(); await expect(priority(page)).toHaveCount(0); await values(work(page).locator('.daily-groups .daily-task input[type=text]'), ['Alpha', 'Gamma', 'Beta']); await saved(page);
});
test('completion, reopening, removal undo, carry-forward and rescheduling preserve the priority mark', async ({ page }) => {
  await row(page, 'Alpha').getByRole('button', { name: 'Mark priority', exact: true }).click(); await row(page, 'Alpha').getByRole('checkbox', { name: 'Complete Alpha', exact: true }).check(); await expect(priority(page)).toHaveCount(0); await expect(row(page, 'Alpha')).toHaveClass(/completed/); await expect(row(page, 'Alpha').getByRole('button', { name: 'Unmark priority', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await row(page, 'Alpha').getByRole('checkbox', { name: 'Complete Alpha', exact: true }).uncheck(); await expect(priority(page).locator('.daily-task')).toHaveCount(1); await row(page, 'Alpha').getByRole('button', { name: 'Remove', exact: true }).click(); await expect(priority(page)).toHaveCount(0); await page.getByRole('button', { name: 'Undo task change', exact: true }).click(); await expect(priority(page).locator('.daily-task')).toHaveCount(1); await saved(page);
  await date(page, '2026-10-20'); await expect(priority(page)).toHaveCount(0); await date(page, '2026-10-23'); await expect(priority(page).getByLabel('Task', { exact: true })).toHaveValue('Alpha');
  await row(page, 'Alpha').getByRole('button', { name: 'Details', exact: true }).click(); await row(page, 'Alpha').getByLabel('Reschedule to', { exact: true }).fill('2026-10-26'); await row(page, 'Alpha').getByRole('button', { name: 'Reschedule', exact: true }).click(); await expect(priority(page)).toHaveCount(0); await saved(page); await date(page, '2026-10-24'); await expect(row(page, 'Alpha')).toHaveCount(0); await date(page, '2026-10-26'); await values(priority(page).getByLabel('Task', { exact: true }), ['Alpha', 'Future priority']);
  const task = (await app.daily.read()).document.tasks.find(t => t.id === ids.Alpha); expect(stateAt(task, '2026-10-20').priority).toBe(false); expect(stateAt(task, '2026-10-26').priority).toBe(true);
});
test('Remove is revealed by task hover or keyboard focus without layout shift, and remains visible on touch', async ({ page, browser }) => {
  const remove = row(page, 'Alpha').getByRole('button', { name: 'Remove', exact: true }); await page.mouse.move(0, 0); await expect(remove).toHaveCSS('opacity', '0'); const before = await row(page, 'Alpha').getByLabel('Task', { exact: true }).boundingBox(); await row(page, 'Alpha').hover(); await expect(remove).toHaveCSS('opacity', '1'); expect(await row(page, 'Alpha').getByLabel('Task', { exact: true }).boundingBox()).toEqual(before);
  await page.mouse.move(0, 0); await row(page, 'Alpha').getByRole('button', { name: 'Mark priority', exact: true }).focus(); await expect(remove).toHaveCSS('opacity', '1'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await expect(remove).toBeFocused();
  const touchContext = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } }); const touch = await touchContext.newPage(); await touch.goto(base + '/?view=daily&date=2026-10-22'); await expect(row(touch, 'Alpha').getByRole('button', { name: 'Remove', exact: true })).toHaveCSS('opacity', '1'); await expect(row(touch, 'Alpha').getByRole('button', { name: 'Mark priority', exact: true })).toBeVisible(); await touchContext.close();
});
test('failed saves recover priority drafts, protect navigation, and compare conflicts with read-only tabs', async ({ page, context }) => {
  await page.route('**/api/daily', route => route.request().method() === 'PUT' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Synthetic failure"}' }) : route.continue()); await row(page, 'Beta').getByRole('button', { name: 'Mark priority', exact: true }).click(); await expect(work(page).getByRole('status')).toContainText('Save failed'); await page.getByRole('button', { name: 'Calendar', exact: true }).click(); await expect(page).toHaveURL(/view=daily/); page.once('dialog', d => d.accept()); await page.reload(); await expect(priority(page).getByLabel('Task', { exact: true })).toHaveValue('Beta'); await page.unroute('**/api/daily'); await page.getByRole('button', { name: 'Retry save', exact: true }).click(); await saved(page);
  const external = await app.daily.read(); updateTask(external.document.tasks.find(t => t.id === ids.Beta), '2026-10-22', { priority: false }); await app.daily.save(external); await row(page, 'Alpha').getByRole('button', { name: 'Mark priority', exact: true }).click(); await page.getByRole('button', { name: 'Retry save', exact: true }).click(); await expect(work(page).getByRole('status')).toContainText('Conflict'); await page.getByRole('button', { name: 'Compare', exact: true }).click(); await expect(page.getByRole('dialog')).toContainText('"priority": true'); await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click(); await expect(priority(page).locator('.daily-task')).toHaveCount(2);
  const second = await context.newPage(); await second.goto(base + '/?view=daily&date=2026-10-22'); await expect(work(second).getByRole('status')).toContainText('Read-only'); await expect(row(second, 'Alpha').getByRole('button', { name: 'Mark priority', exact: true })).toBeDisabled(); await second.close();
});

test('Calendar-linked priority tasks keep source shortcuts and independent completion behavior', async ({ page }) => {
  const faculty = await app.faculty.create({ name: 'Synthetic colleague' }); let calendar = await app.calendar.read(); const booking = { id: randomUUID(), title: 'Synthetic colleague · Conversation', facultyId: faculty.document.id, categoryId: 'category-faculty', start: '2026-10-22T02:00:00.000Z', durationMinutes: 30, timeZone: 'Asia/Shanghai' }; calendar.document.events.push(booking); await app.calendar.save(calendar); ids.Booking = booking.id;
  await page.reload(); await row(page, 'Booking').getByRole('button', { name: 'Mark priority', exact: true }).click(); await expect(priority(page).locator('.daily-priority-category')).toHaveText('Faculty'); await expect(row(page, 'Booking').getByRole('link', { name: 'Open faculty member', exact: true })).toHaveAttribute('href', `?view=faculty&id=${faculty.document.id}`); await expect(row(page, 'Booking').getByRole('link', { name: 'Reschedule in Calendar', exact: true })).toBeVisible(); await saved(page);
  await row(page, 'Booking').getByRole('checkbox').check(); await saved(page); await expect(priority(page)).toHaveCount(0); await page.goto(base + '/?view=calendar&date=2026-10-22'); await expect(page.locator(`[data-event="${booking.id}"]`).first()).toHaveClass(/completed/);
  calendar = await app.calendar.read(); calendar.document.events.find(e => e.id === booking.id).start = '2026-10-23T02:00:00.000Z'; await app.calendar.save(calendar); await page.goto(base + '/?view=daily&date=2026-10-23'); await row(page, 'Booking').getByRole('checkbox').uncheck(); await expect(priority(page).getByLabel('Task', { exact: true })).toHaveValue(booking.title); await saved(page);
  expect((await app.faculty.read(faculty.document.id)).document.sessions).toHaveLength(0);
});
