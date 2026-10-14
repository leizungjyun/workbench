import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';
let root, app, base;
test.beforeEach(async ({ page }) => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldnotes-tabs-'));
  await fs.mkdir(path.join(root, 'collections'));
  await fs.writeFile(path.join(root, 'collections/One.md'), '# One');
  await fs.writeFile(path.join(root, 'collections/Two.md'), '# Two');
  await fs.writeFile(path.join(root, 'collections/Code.ipynb'), JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ id: 'test', cell_type: 'code', metadata: {}, source: ['print(1)'], outputs: [], execution_count: null }] }));
  await fs.symlink(path.resolve('dist'), path.join(root, 'dist'));
  app = await createApp(root); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await page.goto(base); await page.evaluate(() => localStorage.setItem('fieldnotes-vim', false)); await page.reload();
});
test.afterEach(async ({ context }) => { for (const page of context.pages()) await page.close(); await app.terminals.close(); await app.kernels.close(); await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }); await app.store.queue; await fs.rm(root, { recursive: true, force: true, maxRetries:3 }); });
const one = page => page.locator('#tree').getByRole('button', { name: 'One', exact: true });
test('different tabs edit different notebooks; duplicate is read-only and can acquire released ownership', async ({ page, context }) => {
  await one(page).click(); await expect(page).toHaveURL(/path=One.md/);
  const duplicate = await context.newPage(); await duplicate.goto(page.url());
  await expect(duplicate.locator('#stored-label')).toContainText('Already being edited');
  await expect(duplicate.locator('#save-note')).toBeHidden();
  await expect(duplicate.locator('#preview')).toContainText('# One'.slice(2));
  await page.locator('#tree').getByRole('button', { name: 'Two', exact: true }).click();
  await expect(page.locator('#note-title')).toHaveText('Two');
  await duplicate.locator('#claim-notebook').click(); await expect(duplicate.locator('#stored-banner')).toBeHidden();
  await duplicate.locator('button[data-mode="edit"]').click();
  await duplicate.locator('#editor .cm-content').click(); await duplicate.keyboard.press('ControlOrMeta+A'); await duplicate.keyboard.insertText('# Edited in duplicate');
  await expect.poll(() => fs.readFile(path.join(root, 'collections/One.md'), 'utf8')).toBe('# Edited in duplicate');
  await page.reload(); await expect(page.locator('#note-title')).toHaveText('Two');
});
test('modifier click opens a new tab and closing its owner releases the lock', async ({ page, context }) => {
  const newPage = context.waitForEvent('page');
  await one(page).click({ modifiers: ['ControlOrMeta'] }); const owner = await newPage;
  await expect(owner.locator('#note-title')).toHaveText('One');
  await expect(page.locator('#welcome')).toBeVisible();
  await owner.close(); await one(page).click(); await expect(page.locator('#stored-banner')).toBeHidden();
});
test('external clean changes reload and conflicts can be compared and saved separately', async ({ page }) => {
  await one(page).click(); await fs.writeFile(path.join(root, 'collections/One.md'), '# External');
  await expect(page.locator('#preview')).toContainText('External', { timeout: 10000 });
  await page.route('**/api/note', route => route.request().method() === 'PUT' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"offline"}' }) : route.continue());
  await page.locator('button[data-mode="edit"]').click(); await page.locator('#editor .cm-content').click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText('# Draft');
  await expect(page.locator('#save-label')).toHaveText('Save failed · retry');
  await fs.writeFile(path.join(root, 'collections/One.md'), '# External again');
  await expect(page.locator('#conflict')).toBeVisible({ timeout: 10000 });
  await page.locator('#compare-note').click(); await expect(page.locator('#compare-draft')).toHaveText('# Draft'); await expect(page.locator('#compare-disk')).toHaveText('# External again');
  await page.locator('#compare-dialog button').click();
  page.once('dialog', dialog => dialog.accept('Recovered.md')); await page.locator('#save-copy').click();
  await expect.poll(() => fs.readFile(path.join(root, 'collections/Recovered.md'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; })).toBe('# Draft');
  expect(await fs.readFile(path.join(root, 'collections/One.md'), 'utf8')).toBe('# External again');
});

test('duplicate Jupyter notebooks cannot edit or execute cells and preserve the owner draft', async ({ page, context }) => {
  await page.locator('#tree').getByRole('button', { name: 'Code', exact: true }).click();
  await expect(page.locator('#note-title')).toHaveText('[Untitled]');
  const duplicate = await context.newPage(); await duplicate.goto(page.url());
  await expect(duplicate.locator('#stored-label')).toContainText('Already being edited');
  await expect(duplicate.locator('#jupyter-editor button')).toHaveCount(0);
  await expect(duplicate.locator('#jupyter-editor .cm-content')).toHaveCount(0);
  await duplicate.close();
  await one(page).click();
  await page.route('**/api/note', route => route.request().method() === 'PUT' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"offline"}' }) : route.continue());
  await page.locator('button[data-mode="edit"]').click(); await page.locator('#editor .cm-content').click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText('# Unsaved owner draft');
  await expect(page.locator('#save-label')).toHaveText('Save failed · retry');
  const reader = await context.newPage(); await reader.goto(page.url()); await expect(reader.locator('#stored-label')).toContainText('Already being edited');
  expect(await reader.evaluate(() => JSON.parse(localStorage.getItem('draft:One.md')).content)).toBe('# Unsaved owner draft');
  page.once('dialog', dialog => dialog.accept());
});

test('simultaneous opens elect one writer and browser navigation retains notebook URLs', async ({ page, context }) => {
  const other = await context.newPage();
  const url = `${base}/?scope=active&path=One.md`;
  await Promise.all([page.goto(url), other.goto(url)]);
  await expect(page.locator('#note-title')).toHaveText('One'); await expect(other.locator('#note-title')).toHaveText('One');
  await expect.poll(async () => Number(await page.locator('#save-note').isVisible()) + Number(await other.locator('#save-note').isVisible())).toBe(1);
  const owner = await page.locator('#save-note').isVisible() ? page : other;
  await owner.locator('#tree').getByRole('button', { name: 'Two', exact: true }).click(); await expect(owner).toHaveURL(/path=Two.md/);
  await owner.goBack(); await expect(owner.locator('#note-title')).toHaveText('One'); await expect(owner).toHaveURL(/path=One.md/);
  await owner.goForward(); await expect(owner.locator('#note-title')).toHaveText('Two');
});


test('Cmd-click opens an editable notebook and reuses its tab on subsequent clicks', async ({ page, context }) => {
  const opened = context.waitForEvent('page');
  await one(page).click({ modifiers: ['Meta'] }); const owner = await opened;
  await expect(owner.locator('#note-title')).toHaveText('One'); await expect(owner.locator('#save-note')).toBeVisible();
  await expect(owner.locator('#stored-banner')).toBeHidden();
  await owner.evaluate(() => { window.reuseMarker = 'keep editor'; });
  await page.bringToFront(); await one(page).click({ modifiers: ['Meta'] });
  await expect.poll(() => context.pages().length).toBe(2);
  expect(await owner.evaluate(() => window.reuseMarker)).toBe('keep editor');
  await expect.poll(() => owner.evaluate(() => document.hasFocus())).toBe(true);
  await page.bringToFront(); await one(page).click();
  expect(context.pages()).toHaveLength(2); await expect(page.locator('#welcome')).toBeVisible();
  await expect.poll(() => owner.evaluate(() => document.hasFocus())).toBe(true);
});

test('Go to editing tab activates its owner without reloading or opening another tab', async ({ page, context }) => {
  await one(page).click(); await expect(page).toHaveURL(/path=One.md/); await page.evaluate(() => { window.ownerMarker = 'unsaved editor preserved'; });
  const opened = context.waitForEvent('page');
  await page.evaluate(() => window.open(location.href, '_blank')); const reader = await opened;
  await expect(reader.locator('#stored-label')).toContainText('Already being edited');
  await reader.bringToFront(); await reader.locator('#focus-notebook').click();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  expect(context.pages()).toHaveLength(2);
  expect(await page.evaluate(() => window.ownerMarker)).toBe('unsaved editor preserved');
});

test('middle-click and home/search links reuse an existing notebook tab', async ({ page, context }) => {
  const opened = context.waitForEvent('page'); await one(page).click({ button: 'middle' }); const owner = await opened;
  await expect(owner.locator('#save-note')).toBeVisible();
  await page.bringToFront(); await page.locator('.note-card').filter({ hasText: 'One' }).click({ modifiers: ['Meta'] });
  expect(context.pages()).toHaveLength(2); await expect.poll(() => owner.evaluate(() => document.hasFocus())).toBe(true);
  await page.bringToFront(); await page.locator('#search-launch').click(); await page.locator('#search-input').fill('One');
  await page.locator('.result-title').click({ modifiers: ['Meta'] });
  expect(context.pages()).toHaveLength(2); await expect.poll(() => owner.evaluate(() => document.hasFocus())).toBe(true);
});

test('heading title edits content while path moves the notebook; header and footer layout', async ({ page }) => {
  await one(page).click();
  await expect(page.locator('.workspace-tag')).toHaveCount(0);
  await expect(page.locator('.note-footer #toggle-terminal')).toBeVisible();
  const title = await page.locator('#note-title').boundingBox(), relativePath = await page.locator('#note-folder').boundingBox();
  expect(relativePath.x).toBeGreaterThan(title.x + title.width);
  expect(Math.abs(relativePath.y + relativePath.height / 2 - title.y - title.height / 2)).toBeLessThan(3);
  await page.locator('#note-title').focus(); await page.keyboard.press('Enter');
  await page.locator('#title-input').fill('A different title'); await page.getByRole('button', { name: 'Save title', exact: true }).click();
  await expect(page.locator('#note-title')).toHaveText('A different title');
  await expect.poll(() => fs.readFile(path.join(root, 'collections/One.md'), 'utf8')).toBe('# A different title');
  await expect(page.locator('#note-folder')).toHaveText('One.md');
  await page.locator('#note-folder').click(); await page.locator('#path-input').fill('Folder/Moved.md'); await page.locator('#submit-dialog').click();
  await expect(page.locator('#note-folder')).toHaveText('Folder/Moved.md');
  await expect(page.locator('#note-title')).toHaveText('A different title');
  await page.screenshot({ path: '/tmp/notebook-header-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#note-title')).toBeVisible(); await expect(page.locator('#note-folder')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: '/tmp/notebook-header-mobile.png', animations: 'disabled' });
});

test('missing headings show a hint and editing title preserves existing body', async ({ page }) => {
  await fs.writeFile(path.join(root, 'collections/One.md'), '```md\n# Example\n```\n\n## Subtitle\n\nBody');
  await one(page).click();
  await expect(page.locator('#note-title')).toHaveText('[Untitled]'); await expect(page.locator('#title-hint')).toBeVisible();
  await page.locator('#note-title').click(); await page.locator('#title-input').fill('Added heading'); await page.locator('#title-form').getByRole('button', { name: 'Save title' }).click();
  await expect(page.locator('#title-hint')).toBeHidden();
  await expect.poll(() => fs.readFile(path.join(root, 'collections/One.md'), 'utf8')).toBe('# Added heading\n\n```md\n# Example\n```\n\n## Subtitle\n\nBody');
  await page.locator('button[data-mode="edit"]').click(); await page.locator('#editor .cm-content').click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText('# Live title\n\nBody');
  await expect(page.locator('#note-title')).toHaveText('Live title');
});

test('format selection appends extensions and Jupyter titles preserve code cells', async ({ page }) => {
  await fs.mkdir(path.join(root, 'collections/Folder'));
  await page.locator('#new-note').click(); await page.locator('#path-input').fill('Folder/Fresh'); await page.locator('#submit-dialog').click();
  await expect(page.locator('#note-folder')).toHaveText('Folder/Fresh.md'); await expect(page.locator('#note-title')).toHaveText('Fresh');
  await page.locator('#new-note').click(); await page.locator('#note-format').selectOption('ipynb'); await page.locator('#path-input').fill('Folder/Python'); await page.locator('#submit-dialog').click();
  await expect(page.locator('#note-folder')).toHaveText('Folder/Python.ipynb'); await expect(page.locator('#note-title')).toHaveText('[Untitled]');
  await page.locator('#note-title').click(); await page.locator('#title-input').fill('Python notes'); await page.getByRole('button', { name: 'Save title', exact: true }).click();
  await expect(page.locator('#note-title')).toHaveText('Python notes'); await expect(page.locator('#title-hint')).toBeHidden();
  await expect.poll(async () => JSON.parse(await fs.readFile(path.join(root, 'collections/Folder/Python.ipynb'), 'utf8')).cells[0].source).toEqual(['# Python notes\n\n']);
  const saved = JSON.parse(await fs.readFile(path.join(root, 'collections/Folder/Python.ipynb'), 'utf8'));
  expect(saved.cells[1]).toMatchObject({ cell_type: 'code', source: [], outputs: [], execution_count: null });
  await page.locator('#note-title').click(); await page.locator('#title-input').fill('Revised title'); await page.getByRole('button', { name: 'Save title', exact: true }).click();
  await expect.poll(async () => JSON.parse(await fs.readFile(path.join(root, 'collections/Folder/Python.ipynb'), 'utf8')).cells.length).toBe(2);
  await page.reload(); await expect(page.locator('#note-title')).toHaveText('Revised title');
});
