import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server.js';
import { newGroupSession } from '../group-model.js';
import { updateTask, stateAt } from '../daily-model.js';
let root, app, base, records;
const daily = page => page.locator('#daily-workspace');
const taskRow = (page, id) => daily(page).locator(`[data-task="${id}"]`);
test.beforeEach(async ({ page }) => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-record-icons-')); await fs.mkdir(path.join(root, 'collections')); await fs.symlink(path.resolve('dist'), path.join(root, 'dist'));
  app = await createApp(root, { now: () => Date.parse('2026-10-20T00:00:00Z') });
  const student = await app.students.create({ name: 'Ada Example' }); student.document.profile.coursesCompleted = true; await app.students.save(student.document.id, student);
  const faculty = await app.faculty.create({ name: 'Grace Example' });
  const group = await app.groups.create({ name: 'Synthetic Lab', memberIds: [student.document.id], leaderId: student.document.id }); const session = newGroupSession(randomUUID(), group.document, '2026-10-20'); group.document.sessions.push(session); await app.groups.save(group.document.id, group);
  records = [
    { id: randomUUID(), studentId: student.document.id, title: 'Ada Example · Conversation', categoryId: 'category-1', label: 'Open student', href: `?view=student&id=${student.document.id}` },
    { id: randomUUID(), facultyId: faculty.document.id, title: 'Grace Example · Conversation', categoryId: 'category-faculty', label: 'Open faculty member', href: `?view=faculty&id=${faculty.document.id}` },
    { id: session.id, groupId: group.document.id, groupSessionId: session.id, participantIds: [student.document.id], title: 'Synthetic Lab · Workshop · A deliberately long topic for a discussion about reproducible research and collaboration', categoryId: 'category-group', label: 'Open group session', href: `?view=group&id=${group.document.id}&session=${session.id}` }
  ];
  const calendar = await app.calendar.read(); calendar.document.events = records.map(({ label, href, ...event }, index) => ({ ...event, start: `2026-10-20T0${index + 2}:00:00.000Z`, durationMinutes: 30, timeZone: 'Asia/Shanghai' })); await app.calendar.save(calendar);
  const savedDaily = await app.daily.read(); updateTask(savedDaily.document.tasks.find(t => t.id === records[1].id), '2026-10-20', { status: 'completed' }); await app.daily.save(savedDaily);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`; await page.clock.install({ time: new Date('2026-10-20T00:00:00Z') });
});
test.afterEach(async ({ context }) => { for (const page of context.pages()) await page.close(); await app.terminals.close(); await app.kernels.close(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
async function assertIcon(link, label, href) {
  await expect(link).toHaveAttribute('href', href); await expect(link).toHaveAttribute('title', label); await expect(link).toHaveText(''); await expect(link.locator('svg')).toHaveAttribute('aria-hidden', 'true');
}
test('Daily cards and preview use matching icons for every source; Calendar puts them beside Edit/Delete', async ({ page }) => {
  await page.goto(base + '/?view=daily&date=2026-10-20');
  for (const record of records) {
    const row = taskRow(page, record.id); const preview = daily(page).locator('.daily-preview-task').filter({ hasText: record.title });
    for (const parent of [row, preview]) {
      await assertIcon(parent.getByRole('link', { name: record.label, exact: true }), record.label, record.href);
      await assertIcon(parent.getByRole('link', { name: 'Reschedule in Calendar', exact: true }), 'Reschedule in Calendar', `?view=calendar&date=2026-10-20&event=${record.id}`);
    }
    await row.getByRole('button', { name: 'Details', exact: true }).click(); await expect(row.getByRole('link')).toHaveCount(2); await expect(row.locator('.daily-task-details .record-icon-link')).toHaveCount(0); await row.getByRole('button', { name: 'Hide details', exact: true }).click();
  }
  await expect(taskRow(page, records[1].id)).toHaveClass(/completed/);
  await daily(page).evaluate(n => { n.scrollTop = 0; }); await page.screenshot({ path: '/private/tmp/workbench-record-icons-daily-desktop.png', animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(daily(page).getByRole('link', { name: 'Open student', exact: true })).toHaveCount(2);
  await expect.poll(() => daily(page).evaluate(n => n.scrollWidth <= n.clientWidth)).toBe(true);
  for (const link of await taskRow(page, records[0].id).locator('.record-icon-link').all()) { const bounds = await link.boundingBox(); expect(bounds.width).toBeGreaterThanOrEqual(40); expect(bounds.height).toBeGreaterThanOrEqual(40); }
  await page.screenshot({ path: '/private/tmp/workbench-record-icons-daily-mobile.png', animations: 'disabled' });
  await page.goto(base + '/?view=calendar&date=2026-10-20');
  for (const record of records) {
    const rows = page.locator(`#calendar-workspace [data-event="${record.id}"]`); await expect(rows).toHaveCount(2);
    for (const row of await rows.all()) { await assertIcon(row.locator('.calendar-actions').getByRole('link', { name: record.label, exact: true }), record.label, record.href); await expect(row.getByRole('button', { name: 'Edit event', exact: true })).toBeVisible(); await expect(row.getByRole('button', { name: 'Delete event', exact: true })).toBeVisible(); }
  }
  expect(await page.locator('#calendar-workspace').evaluate(n => n.scrollWidth <= n.clientWidth)).toBe(true); await page.locator('#calendar-workspace .calendar-event').first().scrollIntoViewIfNeeded(); await page.screenshot({ path: '/private/tmp/workbench-record-icons-calendar-mobile.png', animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.locator('#calendar-workspace .calendar-event').first().scrollIntoViewIfNeeded(); await page.screenshot({ path: '/private/tmp/workbench-record-icons-calendar-desktop.png', animations: 'disabled' });
});
test('source icons navigate by keyboard, preserve new-tab behavior, and open the exact Group session', async ({ page, context }) => {
  for (const record of records) {
    await page.goto(base + '/?view=daily&date=2026-10-20'); const link = taskRow(page, record.id).getByRole('link', { name: record.label, exact: true }); await link.focus(); await expect(link).toBeFocused(); expect(await link.evaluate(n => getComputedStyle(n).outlineStyle)).not.toBe('none'); await page.keyboard.press('Enter'); await expect(page).toHaveURL(base + '/' + record.href);
    if (record.groupId) await expect(page.locator(`#groups-workspace [data-session="${record.groupSessionId}"]`)).toHaveAttribute('open', '');
    await page.goto(base + '/?view=calendar&date=2026-10-20'); await page.locator(`#calendar-workspace [data-event="${record.id}"]`).first().getByRole('link', { name: record.label, exact: true }).click(); await expect(page).toHaveURL(base + '/' + record.href);
  }
  await page.goto(base + '/?view=daily&date=2026-10-20'); const original = page.url(); const newPageEvent = context.waitForEvent('page'); await taskRow(page, records[0].id).getByRole('link', { name: 'Open student', exact: true }).click({ modifiers: ['ControlOrMeta'] }); const opened = await newPageEvent; await expect(opened).toHaveURL(base + '/' + records[0].href); expect(page.url()).toBe(original); await opened.close();
});
test('historical Daily icons follow the current booking and disappear after deletion without losing the source link', async ({ page }) => {
  const historical = { id: randomUUID(), facultyId: records[1].facultyId, title: 'Historical conversation', start: '2026-10-19T02:00:00.000Z', durationMinutes: 30, timeZone: 'Asia/Shanghai', categoryId: 'category-faculty' };
  let calendar = await app.calendar.read(); calendar.document.events.push(historical); await app.calendar.save(calendar); await app.daily.read();
  calendar = await app.calendar.read(); calendar.document.events.find(e => e.id === historical.id).start = '2026-10-21T02:00:00.000Z'; await app.calendar.save(calendar); const saved = await app.daily.read(); expect(stateAt(saved.document.tasks.find(t => t.id === historical.id), '2026-10-19').scheduledDate).toBe('2026-10-19');
  await page.goto(base + `/?view=daily&date=2026-10-19&task=${historical.id}`); let row = taskRow(page, historical.id); await expect(row.getByRole('link', { name: 'Reschedule in Calendar', exact: true })).toHaveAttribute('href', `?view=calendar&date=2026-10-21&event=${historical.id}`);
  await row.getByRole('link', { name: 'Reschedule in Calendar', exact: true }).click(); await expect(page.getByRole('dialog').getByLabel('Starting time', { exact: true })).toHaveValue('2026-10-21T10:00'); await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.goto(base + `/?view=daily&date=2026-10-19&task=${historical.id}`); calendar = await app.calendar.read(); calendar.document.events.find(e => e.id === historical.id).start = '2026-10-22T03:00:00.000Z'; await app.calendar.save(calendar); await page.clock.runFor(3100); await expect(row.getByRole('link', { name: 'Reschedule in Calendar', exact: true })).toHaveAttribute('href', `?view=calendar&date=2026-10-22&event=${historical.id}`);
  calendar = await app.calendar.read(); calendar.document.events = calendar.document.events.filter(e => e.id !== historical.id); await app.calendar.save(calendar); await page.clock.runFor(3100); await expect(row.getByRole('link', { name: 'Reschedule in Calendar', exact: true })).toHaveCount(0); await expect(row.getByRole('link', { name: 'Open faculty member', exact: true })).toBeVisible(); await expect(daily(page).locator('.daily-preview-task').filter({ hasText: historical.title }).getByRole('link')).toHaveCount(1);
});
test('icon links preserve Daily and Calendar drafts when saving fails', async ({ page }) => {
  await page.goto(base + '/?view=daily&date=2026-10-20'); await page.route('**/api/daily', route => route.request().method() === 'PUT' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Synthetic failure"}' }) : route.continue());
  const row = taskRow(page, records[0].id); await row.getByLabel('Task', { exact: true }).fill('Preserve edited title');
  for (const label of ['Open student', 'Reschedule in Calendar']) { await row.getByRole('link', { name: label, exact: true }).click(); await expect(daily(page).getByRole('status')).toContainText('Save failed'); await expect(page).toHaveURL(/view=daily/); await expect(row.getByLabel('Task', { exact: true })).toHaveValue('Preserve edited title'); }
  await daily(page).locator('.daily-preview-task').filter({ hasText: 'Preserve edited title' }).getByRole('link', { name: 'Open student', exact: true }).click(); await expect(page).toHaveURL(/view=daily/);
  await page.unroute('**/api/daily'); await daily(page).getByRole('button', { name: 'Retry save', exact: true }).click(); await expect(daily(page).getByRole('status')).toContainText('Saved to disk');
  await page.goto(base + '/?view=calendar&date=2026-10-20'); await page.route('**/api/calendar', route => route.request().method() === 'PUT' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Synthetic failure"}' }) : route.continue());
  const eventRow = page.locator(`#calendar-workspace [data-event="${records[0].id}"]`).first(); await eventRow.getByRole('button', { name: 'Edit event', exact: true }).click(); await page.getByRole('dialog').getByLabel('Title', { exact: true }).fill('Preserve Calendar draft'); await page.getByRole('dialog').getByRole('button', { name: 'Save event', exact: true }).click(); await expect(page.getByRole('dialog')).toContainText('Synthetic failure'); await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click(); await eventRow.getByRole('link', { name: 'Open student', exact: true }).click(); await expect(page).toHaveURL(/view=calendar/); expect(JSON.parse(await page.evaluate(() => localStorage.getItem('fieldnotes-calendar-draft'))).document.events.find(e => e.id === records[0].id).title).toContain('Preserve Calendar draft');
});
