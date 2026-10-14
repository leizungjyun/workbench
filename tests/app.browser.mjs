import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server.js';
import { syntheticWorkspace } from './fixtures/workspace.mjs';
let root, server, base, kernels, terminals, store;
const fixtureContent = '# UI Fixture\n\nNeedle needle NEEDLE.\n\n| Topic | Value |\n| --- | --- |\n| Markdown | Yes |\n\n```js\nconst hello = "world";\n```\n\n<script>window.previewPwned = true</script>\n<img src=x onerror="window.previewPwned=true">\n[bad](javascript:alert(1))\n';
test.beforeEach(async ({ page }) => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldnotes-browser-'));
  const manifest = await syntheticWorkspace(root);
  // Image regressions must not depend on personal schedule notes remaining in Collections.
  const imageFixture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  for (const name of ['Aug-25', 'Dec-25']) {
    const note = `schedule/${name}.md`, image = `fixtures/${name}.png`;
    await fs.mkdir(path.join(root, 'collections/schedule'), { recursive: true });
    await fs.mkdir(path.join(root, 'fixtures'), { recursive: true });
    await fs.writeFile(path.join(root, 'collections', note), `# ${name}\n\n![Schedule](image.png)\n`);
    await fs.writeFile(path.join(root, image), imageFixture);
    manifest.attachments[note] = { 'image.png': { id: `fixture-${name}`, path: image } };
  }
  await fs.writeFile(path.join(root, 'notebook-import.json'), JSON.stringify(manifest));
  await fs.symlink(path.resolve('dist'), path.join(root, 'dist'));
  for (const dir of Object.values(manifest.notebookOrigins || {})) await fs.mkdir(path.join(root, dir), { recursive: true });
  await fs.writeFile(path.join(root, 'collections/UI Fixture.md'), fixtureContent);
  ({ server, kernels, terminals, store } = await createApp(root));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base); await page.evaluate(() => localStorage.setItem('fieldnotes-vim', 'false')); await page.reload(); const noteCount = (await fs.readdir(path.join(root, 'collections'), { recursive: true })).filter(name => /\.(md|ipynb)$/i.test(name)).length; await expect(page.locator('#note-count')).toHaveText(String(noteCount));
});
test.afterEach(async ({ page }) => { await page.close(); await terminals.close(); await kernels.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await store.queue; await fs.rm(root, { recursive: true, force: true, maxRetries:3 }); });
async function openFixture(page) { await page.locator('#tree').getByRole('button', { name: 'UI Fixture', exact: true }).click({ position: { x: 30, y: 17 } }); await expect(page.locator('#note-folder')).toHaveText('UI Fixture.md'); }
async function replaceContent(page, value) { await page.locator('button[data-mode="edit"]').click(); const editor = page.locator('.cm-content'); await editor.click(); await editor.press('ControlOrMeta+A'); await page.keyboard.insertText(value); }

async function rowAction(page, name, action, section = '#tree') {
  const group = page.locator(section).getByRole('group', { name: `Actions for ${name}`, exact: true });
  await group.locator('..').hover(); await group.getByRole('button', { name: action, exact: true }).click();
}

test('synthetic collection, all view modes, syntax highlighting, sanitized preview and original images', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.screenshot({ path: '/tmp/fieldnotes-home.png', fullPage: true, animations: 'disabled' });
  await openFixture(page);
  await expect(page.locator('#preview table')).toBeVisible(); await expect(page.locator('#preview pre code')).toContainText('const hello');
  expect(await page.evaluate(() => window.previewPwned)).toBeUndefined();
  await expect(page.locator('#preview script, #preview [onerror], #preview a[href^="javascript:"]')).toHaveCount(0);
  expect(await page.locator('.cm-line span[class]').count()).toBeGreaterThan(0);
  await page.locator('button[data-mode="preview"]').click(); await expect(page.locator('.editor-pane')).toBeHidden();
  await page.locator('button[data-mode="split"]').click(); await expect(page.locator('.editor-pane')).toBeVisible();
  for (const name of ['Aug-25', 'Dec-25']) {
    await page.locator('#search-launch').click(); await page.locator('#search-input').fill(name);
    await page.locator('.result-title').filter({ hasText: name }).click();
    await expect(page.locator('#note-title')).toHaveText(name);
    await expect(page.locator('#preview img[src^="/api/attachments/"]')).toHaveCount(1);
    await page.locator('#preview img[src^="/api/attachments/"]').scrollIntoViewIfNeeded();
    await expect.poll(() => page.locator('#preview img[src^="/api/attachments/"]').evaluate(img => img.complete && img.naturalWidth > 0)).toBeTruthy();
  }
  await page.screenshot({ path: '/tmp/fieldnotes-editor.png', fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('autosave, manual save, pin persistence and recents', async ({ page }) => {
  await openFixture(page); await replaceContent(page, '# Changed\n\nA newly saved thought.');
  await expect(page.locator('#save-label')).toHaveText('Saved to disk');
  expect(await fs.readFile(path.join(root, 'collections/UI Fixture.md'), 'utf8')).toBe('# Changed\n\nA newly saved thought.');
  await rowAction(page, 'UI Fixture', 'Pin');
  await expect(page.locator('#pinned')).toContainText('UI Fixture');
  await page.reload(); await expect(page.locator('#pinned')).toContainText('UI Fixture'); await expect(page.locator('#recent')).toContainText('UI Fixture');
  await page.locator('#tree').getByRole('button', { name: 'UI Fixture', exact: true }).click(); await replaceContent(page, '# Manually saved'); await page.keyboard.press('ControlOrMeta+S');
  await expect.poll(() => fs.readFile(path.join(root, 'collections/UI Fixture.md'), 'utf8')).toBe('# Manually saved');
});

test('literal search counts and clicking a snippet selects its occurrence', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+K'); await page.locator('#search-input').fill('needle');
  await expect(page.locator('#search-summary')).toHaveText('1 matching notebook · 3 text matches');
  await expect(page.locator('.result-snippet')).toHaveCount(3);
  await page.locator('.result-snippet').nth(1).click(); await expect(page.locator('#note-title')).toHaveText('UI Fixture');
  await expect.poll(() => page.evaluate(() => window.getSelection().toString())).toBe('needle');
  await page.keyboard.press('ControlOrMeta+K'); await page.locator('#search-input').fill('zzNoSuchPhrase999');
  await expect(page.locator('#search-summary')).toHaveText('0 matching notebooks · 0 text matches');
});

test('create folders and notes, reject collisions, move pinned notes and recover deleted files', async ({ page }) => {
  await page.getByRole('button', { name: 'New folder', exact: true }).click(); await page.locator('#path-input').fill('Test Folder'); await page.locator('#submit-dialog').click();
  await expect(page.locator('#path-dialog')).toBeHidden();
  await page.getByRole('button', { name: 'New notebook', exact: true }).click(); await page.locator('#path-input').fill('Test Folder/New note'); await page.locator('#submit-dialog').click();
  await expect(page.locator('#note-title')).toHaveText('New note');
  await rowAction(page, await page.locator('#note-title').textContent(), 'Pin');
  await rowAction(page, 'New note', 'Rename/Move'); await page.locator('#path-input').fill('UI Fixture.md'); await page.locator('#submit-dialog').click();
  await expect(page.locator('#dialog-error')).not.toBeEmpty();
  await page.locator('#path-input').fill('Renamed.md'); await page.locator('#submit-dialog').click(); await expect(page.locator('#note-title')).toHaveText('New note');
  await expect(page.locator('#pinned')).toContainText('Renamed');
  page.once('dialog', dialog => dialog.accept()); await rowAction(page, 'Renamed', 'Move to Trash');
  await expect(page.locator('#welcome')).toBeVisible(); await expect(page.locator('#pinned')).not.toContainText('Renamed');
  expect((await fs.readdir(path.join(root, '.notebook/trash'))).length).toBe(1);
});

test('external-edit conflict preserves the draft until explicit overwrite or reload', async ({ page }) => {
  await openFixture(page); await fs.writeFile(path.join(root, 'collections/UI Fixture.md'), '# External edit');
  await replaceContent(page, '# My draft'); await expect(page.locator('#conflict')).toBeVisible();
  expect(await fs.readFile(path.join(root, 'collections/UI Fixture.md'), 'utf8')).toBe('# External edit');
  await expect(page.locator('.cm-content')).toContainText('# My draft');
  page.once('dialog', dialog => dialog.accept()); await page.locator('#overwrite-note').click();
  await expect(page.locator('#conflict')).toBeHidden(); await expect.poll(() => fs.readFile(path.join(root, 'collections/UI Fixture.md'), 'utf8')).toBe('# My draft');
  await fs.writeFile(path.join(root, 'collections/UI Fixture.md'), '# External again');
  await replaceContent(page, '# Another draft'); await expect(page.locator('#conflict')).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await page.locator('#reload-note').click();
  await expect(page.locator('.cm-content')).toContainText('# External again'); await expect(page.locator('#conflict')).toBeHidden();
});

test('failed saves block navigation, preserve text and recover a cached draft after refresh', async ({ page }) => {
  await openFixture(page);
  await page.route('**/api/note', route => route.request().method() === 'PUT' ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Simulated disk failure' }) }) : route.continue());
  await replaceContent(page, '# Important unsaved draft'); await expect(page.locator('#save-label')).toHaveText('Save failed · retry');
  await page.locator('#home').click(); await expect(page.locator('#notebook')).toBeVisible();
  page.once('dialog', dialog => dialog.accept()); await page.reload(); await openFixture(page);
  await expect(page.locator('.cm-content')).toContainText('# Important unsaved draft');
  await page.unroute('**/api/note'); await page.keyboard.press('ControlOrMeta+S');
  await expect.poll(() => fs.readFile(path.join(root, 'collections/UI Fixture.md'), 'utf8')).toBe('# Important unsaved draft');
});

test('mobile navigation, default preview and stacked split view have no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => localStorage.clear()); await page.reload();
  await page.getByRole('button', { name: 'Expand sidebar' }).click(); await expect(page.locator('body')).toHaveClass(/sidebar-open/); await openFixture(page);
  await expect(page.locator('.editor-pane')).toBeHidden(); await expect(page.locator('.preview-pane')).toBeVisible();
  await page.locator('button[data-mode="split"]').click(); await expect(page.locator('.editor-pane')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: '/tmp/fieldnotes-mobile.png', fullPage: true, animations: 'disabled' });
});


test('todo checkboxes and persistent Vim bindings work in Markdown edit mode', async ({ page }) => {
  await openFixture(page); await replaceContent(page, '# Tasks\n\n- [ ] Pending\n- [x] Done\n');
  await page.locator('button[data-mode="split"]').click();
  await expect(page.locator('#preview input[type=checkbox]')).toHaveCount(2);
  await expect(page.locator('#preview input').first()).not.toBeChecked(); await expect(page.locator('#preview input').nth(1)).toBeChecked();
  await page.locator('#vim-toggle').click(); await expect(page.locator('#vim-toggle')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#editor .cm-content').click(); await page.keyboard.press('Escape'); await page.keyboard.type('gg0iVIM '); await page.keyboard.press('Escape');
  await expect(page.locator('#editor .cm-content')).toContainText('VIM # Tasks');
  await page.keyboard.type(':w'); await page.keyboard.press('Enter'); await expect(page.locator('#save-label')).toHaveText('Saved to disk');
  await page.reload(); await openFixture(page); await expect(page.locator('#vim-toggle')).toHaveAttribute('aria-pressed', 'true');
});

test('imported Jupyter cells preserve embedded images, outputs and math; source search opens the cell', async ({ page }) => {
  await page.locator('#search-launch').click(); await page.locator('#search-input').fill('Ch04-circuit'); await page.locator('.result-title').click();
  await expect(page.locator('#jupyter-editor')).toBeVisible(); await expect(page.locator('.nb-cell')).toHaveCount(3);
  await expect(page.locator('.cell-markdown img').first()).toBeVisible();
  await expect.poll(() => page.locator('.cell-markdown img').first().evaluate(img => img.complete && img.naturalWidth > 0)).toBeTruthy();
  await expect(page.locator('.katex').first()).toBeVisible();
  await page.locator('#search-launch').click(); await page.locator('#search-input').fill('from phasor import');
  await page.locator('.result-snippet').first().click(); await expect(page.locator('#note-title')).toHaveText('[Untitled]');
  await expect.poll(() => page.evaluate(() => window.getSelection().toString())).toBe('from phasor import');
  await page.screenshot({ path: '/tmp/fieldnotes-jupyter.png', fullPage: true, animations: 'disabled' });
});

test('create and edit Jupyter cells, run Python, preserve execution output, and use Vim in cells', async ({ page }) => {
  test.setTimeout(60000);
  test.skip(!process.env.WORKBENCH_TEST_PYTHON, 'Set WORKBENCH_TEST_PYTHON for Python execution checks.');
  await page.getByRole('button', { name: 'New notebook', exact: true }).click(); await page.locator('#note-format').selectOption('ipynb'); await page.locator('#path-input').fill('Notebook test'); await page.locator('#submit-dialog').click();
  await expect(page.locator('#note-title')).toHaveText('[Untitled]'); await expect(page.getByLabel('Python environment')).toBeEnabled({ timeout: 20000 });
  const env = await page.getByLabel('Python environment').evaluate(select => [...select.options].find(o => !o.disabled && o.textContent.startsWith('Configured Python'))?.value || [...select.options].find(o => !o.disabled && o.value)?.value);
  expect(env).toBeTruthy(); await page.getByLabel('Python environment').selectOption(env);
  const cell = page.getByLabel('code cell 1', { exact: true }); await cell.click(); await page.keyboard.insertText('answer = 40\nanswer + 2');
  await page.getByRole('button', { name: 'Run cell 1', exact: true }).click(); await expect(page.locator('.cell-output')).toContainText('42', { timeout: 40000 });
  const saved = JSON.parse(await fs.readFile(path.join(root, 'collections/Notebook test.ipynb'), 'utf8')); expect(saved.cells[0].outputs[0].data['text/plain']).toBe('42');
  await page.getByRole('button', { name: '+ Code cell', exact: true }).click(); const second = page.getByLabel('code cell 2', { exact: true }); await second.click(); await page.keyboard.insertText('answer + 3');
  await page.getByRole('button', { name: 'Run cell 2', exact: true }).click(); await expect(page.locator('[data-cell="1"] .cell-output')).toContainText('43');
  await page.locator('#vim-toggle').click(); await second.click(); await page.keyboard.press('Escape'); await page.keyboard.type('gg0i# '); await page.keyboard.press('Escape'); await expect(second).toContainText('# answer + 3');
  await page.getByRole('button', { name: '+ Markdown cell', exact: true }).click(); await expect(page.locator('.nb-cell')).toHaveCount(3);
  for (const index of [1, 2]) {
    const cellEditor = page.locator(`[data-cell="${index}"] .cm-content`);
    const status = page.locator(`[data-cell="${index}"] .cm-vim-panel`);
    await cellEditor.focus();
    for (const shortcut of ['Escape', 'Control+[']) {
      await page.keyboard.press('i');
      await expect(status).toContainText('--INSERT--');
      await page.keyboard.press(shortcut);
      await expect(status).toContainText('--NORMAL--');
    }
  }
  await page.locator('#save-note').click(); await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('.kernel-status')).toHaveText('Kernel stopped');
});

test('long Git tutorial settles split alignment and scrolls in both directions', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${base}/?scope=active&path=toolkit%2Fgit-tutorial.md`);
  await page.locator('button[data-mode="split"]').click();
  const editor = page.locator('#editor .cm-scroller'), preview = page.locator('#preview');
  await expect(preview.locator('table')).toHaveCount(8);
  await expect.poll(() => page.evaluate(async () => { const values=[]; for(let i=0;i<12;i++){ await new Promise(r=>requestAnimationFrame(r)); values.push(document.querySelector('#preview').scrollHeight); } return Math.max(...values)-Math.min(...values); })).toBeLessThan(2);
  for (const [pane, other, fraction] of [[preview, editor, 0.08], [editor, preview, 0.4], [preview, editor, 0.75]]) {
    await other.evaluate(e => { e.scrollTop = 0; });
    await expect.poll(() => other.evaluate(e => e.scrollTop)).toBeLessThan(3);
    await expect.poll(() => pane.evaluate(e => e.scrollTop)).toBeLessThan(3);
    await pane.evaluate((e, f) => { e.scrollTop = f * (e.scrollHeight - e.clientHeight); }, fraction);
    await expect.poll(() => other.evaluate(e => e.scrollTop), { message: 'Synchronization from fraction ' + fraction }).toBeGreaterThan(500).catch(async e => { throw new Error(e.message + JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('#editor .cm-scroller,#preview')].map(n=>({id:n.id,top:n.scrollTop,height:n.scrollHeight,client:n.clientHeight,text:n.innerText.slice(0,80)}))))); });
    await expect.poll(() => page.evaluate(async () => {
      const e = document.querySelector('#editor .cm-scroller'), p = document.querySelector('#preview'), samples = [];
      for (let i = 0; i < 12; i++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        samples.push([e.scrollTop, p.scrollTop, e.scrollHeight, p.scrollHeight]);
      }
      return Math.max(...samples[0].map((_, i) => Math.max(...samples.map(s => s[i])) - Math.min(...samples.map(s => s[i]))));
    })).toBeLessThan(2);
  }
  for (const name of ['Part II — Notes Taken from the Tutorial', /^17\. Use worktrees/]) {
    const heading = preview.getByRole('heading', { name, exact: typeof name === 'string' });
    await heading.scrollIntoViewIfNeeded();
    await expect.poll(() => page.evaluate(() => {
      const e = document.querySelector('#editor .cm-scroller'), p = document.querySelector('#preview');
      const bounds = p.getBoundingClientRect();
      const block = [...p.querySelectorAll('.source-block')].find(b => b.getBoundingClientRect().top >= bounds.top && b.getBoundingClientRect().top < bounds.bottom - 40 && b.querySelector('h2,h3'));
      if (!block) return 10000;
      const title = block.querySelector('h2,h3').textContent;
      const line = [...e.querySelectorAll('.cm-line')].find(l => l.textContent.replace(/^#+\s*/, '') === title);
      return line ? Math.abs(line.getBoundingClientRect().top - block.getBoundingClientRect().top) : 10000;
    })).toBeLessThan(5);
  }
  await editor.evaluate(e => { e.scrollTop = e.scrollHeight; });
  await expect.poll(() => preview.evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThan(3);
  await preview.evaluate(e => { e.scrollTop = 0; });
  await expect.poll(() => editor.evaluate(e => e.scrollTop)).toBeLessThan(3);
});

test('Markdown split aligns corresponding source blocks at the top and bottom in both directions', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const source = Array.from({ length: 60 }, (_, i) => `## Section ${i + 1}\n\n${'A paragraph with **bold text** and a link. '.repeat(i % 4 + 1)}\n\n${i % 3 === 0 ? '> Quoted text\n> Another line\n\n' : ''}${i % 5 === 0 ? '```js\nconst x = 1;\nconsole.log(x);\n```\n\n' : ''}${i % 7 === 0 ? '<img width=300 src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6LaAAAAAASUVORK5CYII=">\n\n' : ''}`).join('');
  await fs.writeFile(path.join(root, 'collections/UI Fixture.md'), source);
  await openFixture(page); await page.locator('button[data-mode="split"]').click();
  const editor = page.locator('#editor .cm-scroller'), preview = page.locator('#preview');
  const visibleAlignment = () => page.evaluate(() => {
    const pane = document.querySelector('#preview'), bounds = pane.getBoundingClientRect();
    const headings = [...pane.querySelectorAll('.source-block')].filter(b => b.querySelector('h2') && b.getBoundingClientRect().top >= bounds.top + 4 && b.getBoundingClientRect().top < bounds.bottom - 40);
    const lines = [...document.querySelectorAll('#editor .cm-line')];
    return headings.map(b => {
      const text = b.querySelector('h2').textContent;
      const line = lines.find(l => l.textContent === `## ${text}`);
      return line ? Math.abs(line.getBoundingClientRect().top - b.getBoundingClientRect().top) : 10000;
    });
  });
  for (const [pane, fraction] of [[editor, 0.3], [preview, 0.6], [preview, 0.2], [editor, 0.75]]) {
    await pane.evaluate((e, f) => { e.scrollTop = f * (e.scrollHeight - e.clientHeight); }, fraction);
    await expect.poll(async () => { const offsets = await visibleAlignment(); return offsets.length ? Math.max(...offsets) : 10000; }).toBeLessThan(5);
  }
  await page.setViewportSize({ width: 1100, height: 900 });
  await editor.evaluate(e => { e.scrollTop = 0.4 * (e.scrollHeight - e.clientHeight); });
  await expect.poll(async () => { const offsets = await visibleAlignment(); return offsets.length ? Math.max(...offsets) : 10000; }).toBeLessThan(5);
  await editor.evaluate(e => { e.scrollTop = e.scrollHeight; });
  await expect.poll(() => preview.evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThan(3);
  await preview.evaluate(e => { e.scrollTop = 0; }); await expect.poll(() => editor.evaluate(e => e.scrollTop)).toBeLessThan(3);
  await page.locator('button[data-mode="preview"]').click(); await expect(page.locator('#editor')).toBeHidden();
  await page.locator('button[data-mode="split"]').click();
  await page.screenshot({ path: '/tmp/fieldnotes-aligned.png', animations: 'disabled' });
  expect(errors).toEqual([]);
});

test('path renames notebook; footer shows actual disk timestamp and Vim is on by default', async ({ page }) => {
  await page.evaluate(() => localStorage.removeItem('fieldnotes-vim')); await page.reload(); await openFixture(page);
  await expect(page.locator('.note-footer #vim-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.note-footer #save-note')).toBeVisible();
  await expect(page.locator('.note-actions .mode-switch')).toBeVisible();
  const initial = (await fs.stat(path.join(root, 'collections/UI Fixture.md'))).mtime.toISOString();
  await expect(page.locator('#save-time')).toHaveAttribute('datetime', initial);
  await page.locator('#vim-toggle').click(); await replaceContent(page, '# A new save');
  await expect(page.locator('#save-label')).toHaveText('Saved to disk');
  const saved = (await fs.stat(path.join(root, 'collections/UI Fixture.md'))).mtime.toISOString();
  expect(saved).not.toBe(initial); await expect(page.locator('#save-time')).toHaveAttribute('datetime', saved);
  await page.locator('#note-folder').click(); await expect(page.locator('#path-dialog')).toBeVisible();
  await page.locator('#path-input').fill('Title rename.md'); await page.locator('#submit-dialog').click();
  await expect(page.locator('#note-title')).toHaveText('A new save');
});

test('list continuation uses one newline in normal and Vim insert modes', async ({ page }) => {
  await openFixture(page);
  const file = path.join(root, 'collections/UI Fixture.md');
  for (const vim of [false, true]) {
    for (const [source, expected] of [
      ['- first\n- second', '- first\n- second\n- '],
      ['- first\n\n- second', '- first\n\n- second\n- '],
      ['1. first\n\n2. second', '1. first\n\n2. second\n3. '],
      ['- parent\n  - child', '- parent\n  - child\n  - '],
      ['- [ ] task', '- [ ] task\n- [ ] '],
    ]) {
      if (await page.locator('#vim-toggle').getAttribute('aria-pressed') === 'true') await page.locator('#vim-toggle').click();
      await replaceContent(page, source);
      if (vim) { await page.locator('#vim-toggle').click(); await page.locator('#editor .cm-content').focus(); await page.keyboard.press('A'); }
      await page.keyboard.press('Enter');
      await expect.poll(() => fs.readFile(file, 'utf8')).toBe(expected);
      if (vim) await page.keyboard.press('Escape');
    }
  }
  await page.locator('#vim-toggle').click();
  await replaceContent(page, '- first\n- '); await page.keyboard.press('Enter');
  await expect.poll(() => fs.readFile(file, 'utf8')).toBe('- first\n');
});

test('Vim Escape and Ctrl+[ leave insert mode and restore normal commands', async ({ page }) => {
  await openFixture(page);
  await replaceContent(page, 'alpha\nbeta');
  await page.locator('#vim-toggle').click();
  const content = page.locator('#editor .cm-content');
  const status = page.locator('#editor .cm-vim-panel');
  await content.focus();
  for (const shortcut of ['Escape', 'Control+[']) {
    await page.keyboard.press('i');
    await expect(status).toContainText('--INSERT--');
    await page.keyboard.type('X');
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press(shortcut);
    await expect(status).toContainText('--NORMAL--');
    await page.keyboard.type('gg0');
    await expect(content).not.toContainText('gg0');
  }
  // Input methods can translate key while leaving the physical code intact.
  for (const event of [
    { key: 'Process', code: 'Escape' },
    { key: '【', code: 'BracketLeft', ctrlKey: true },
  ]) {
    await page.keyboard.press('i');
    await expect(status).toContainText('--INSERT--');
    await content.dispatchEvent('keydown', event);
    await expect(status).toContainText('--NORMAL--');
  }
  for (const shortcut of ['Escape', 'Control+[']) {
    await page.keyboard.press('i');
    await content.dispatchEvent('compositionstart', { data: '' });
    await page.keyboard.insertText('中文');
    await page.keyboard.press(shortcut);
    await expect(status).toContainText('--NORMAL--');
    await content.dispatchEvent('compositionend', { data: '中文' });
    await expect(content).toContainText('中文');
  }
});

for (const vim of [false, true]) test(`Tab and Shift+Tab indent Markdown and Jupyter cells with Vim ${vim ? 'on' : 'off'}`, async ({ page }) => {
  await openFixture(page);
  await replaceContent(page, 'alpha\nbeta');
  if (vim) await page.locator('#vim-toggle').click();
  const markdown = page.locator('#editor .cm-content');
  await markdown.focus();
  if (vim) await page.keyboard.press('i');
  await page.keyboard.press('Tab');
  await expect(markdown).toBeFocused();
  await expect.poll(() => markdown.innerText()).toMatch(/  (alpha|beta)/);
  await page.keyboard.press('Shift+Tab');
  await expect(markdown).toBeFocused();
  await expect.poll(() => markdown.innerText()).toBe('alpha\nbeta');
  if (vim) await page.keyboard.press('Escape');
  else {
    await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Tab');
    await expect.poll(() => markdown.innerText()).toBe('  alpha\n  beta');
    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => markdown.innerText()).toBe('alpha\nbeta');
  }
  await page.locator('#save-note').click();
  await expect.poll(() => fs.readFile(path.join(root, 'collections/UI Fixture.md'), 'utf8')).toBe('alpha\nbeta');
  const notebook = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
    { id: 'code', cell_type: 'code', metadata: {}, source: ['value = 1'], execution_count: null, outputs: [] },
    { id: 'markdown', cell_type: 'markdown', metadata: {}, source: ['- item'] },
  ] };
  await fs.writeFile(path.join(root, 'collections/Tab Fixture.ipynb'), JSON.stringify(notebook));
  await page.reload();
  await page.locator('#tree').getByRole('button', { name: 'Tab Fixture', exact: true }).click();
  await page.locator('button[data-mode="edit"]').click();
  for (const [index, source] of ['value = 1', '- item'].entries()) {
    const cell = page.locator(`[data-cell="${index}"] .cm-content`);
    await cell.focus();
    if (vim) await page.keyboard.press('i');
    await page.keyboard.press('Tab');
    await expect(cell).toBeFocused();
    await expect.poll(() => cell.innerText()).toBe(`  ${source}`);
    await page.keyboard.press('Shift+Tab');
    await expect(cell).toBeFocused();
    await expect.poll(() => cell.innerText()).toBe(source);
    if (vim) await page.keyboard.press('Escape');
  }
  await page.locator('#save-note').click();
  await expect(page.locator('#save-label')).toHaveText('Saved to disk');
});

test('opt-in Vim diagnostics distinguish exit keys and mode without recording note text', async ({ page }) => {
  await page.goto(`${base}/?vim-debug=1`);
  await openFixture(page);
  await page.locator('button[data-mode="edit"]').click();
  await page.locator('#vim-toggle').click();
  await page.locator('#editor .cm-content').focus();
  await page.keyboard.press('i'); await page.keyboard.press('Escape');
  const details = page.getByLabel('Vim diagnostic details');
  await expect.poll(async () => JSON.parse(await details.inputValue()).events.length).toBe(1);
  const report = JSON.parse(await details.inputValue());
  expect(report.events[0].before.mode).toBe('INSERT');
  expect(report.events[0].after.mode.toLowerCase()).toBe('normal');
  expect(report.events[0].prevented).toBe(true);
  expect(await details.inputValue()).not.toContain('Needle');
});

test('typing preserves scroll geometry and unchanged preview blocks; edit-only mode defers rendering', async ({ page }) => {
  const source = Array.from({ length: 45 }, (_, i) => `## Section ${i + 1}\n\nStable paragraph ${i + 1}.\n\n${i % 5 === 0 ? '<img width=300 src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6LaAAAAAASUVORK5CYII=">\n\n' : ''}`).join('');
  await fs.writeFile(path.join(root, 'collections/UI Fixture.md'), source);
  await openFixture(page); await page.locator('button[data-mode="split"]').click();
  await page.locator('#editor .cm-scroller').evaluate(e => { e.scrollTop = 0.5 * (e.scrollHeight - e.clientHeight); });
  const line = page.locator('#editor .cm-line').filter({ hasText: /^Stable paragraph \d+\.$/ }).first();
  await line.click(); await page.keyboard.press('End');
  // Wait for alignment to settle before measuring the typing interaction.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 350)));
  await page.evaluate(() => {
    window.typingSamples = [];
    window.previewMutations = 0;
    window.originalBlock = document.querySelector('#preview .source-block');
    window.previewObserver = new MutationObserver(() => window.previewMutations++);
    window.previewObserver.observe(document.querySelector('#preview'), { childList: true, subtree: true });
    window.recordTyping = true;
    const sample = () => { if (!window.recordTyping) return; window.typingSamples.push(document.querySelector('#editor .cm-scroller').scrollTop); requestAnimationFrame(sample); };
    sample();
  });
  await page.keyboard.type(' typing stays stable', { delay: 25 });
  expect(await page.evaluate(() => window.previewMutations)).toBe(0);
  await expect(page.locator('#preview')).toContainText('typing stays stable');
  const readings = await page.evaluate(() => { window.recordTyping = false; window.previewObserver.disconnect(); return { top: window.typingSamples, preserved: window.originalBlock === document.querySelector('#preview .source-block') }; });
  expect(readings.preserved).toBeTruthy();
  expect(Math.max(...readings.top) - Math.min(...readings.top)).toBeLessThan(3);
  await page.locator('button[data-mode="edit"]').click();
  await expect.poll(() => page.locator('#preview > .source-block[style*="min-height"]').count()).toBe(0);
  const before = await page.locator('#preview').innerHTML();
  await page.locator('#editor .cm-content').focus(); await page.keyboard.type(' hidden preview waits');
  await expect(page.locator('#save-label')).toHaveText('Saved to disk');
  expect(await page.locator('#preview').innerHTML()).toBe(before);
  await page.locator('button[data-mode="preview"]').click();
  await expect(page.locator('#preview')).toContainText('hidden preview waits');
});

test('row menus act on their own note; Archive is searchable and preview-only; Trash restores to Archive', async ({ page }) => {
  await openFixture(page);
  await fs.writeFile(path.join(root, 'collections/Other.md'), '# Other\n\nneedle needle');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#tree')).toContainText('Other');
  await rowAction(page, 'Other', 'Pin');
  await expect(page.locator('#note-title')).toHaveText('UI Fixture');
  await expect(page.locator('#pinned')).toContainText('Other');
  await rowAction(page, 'Other', 'Archive', '#pinned');
  await expect(page.locator('#archive-count')).toHaveText('1'); await expect(page.locator('#pinned')).not.toContainText('Other');
  await page.locator('#search-launch').click(); await page.locator('#search-input').fill('needle');
  await expect(page.locator('#search-summary')).toHaveText('2 matching notebooks · 5 text matches');
  await expect(page.locator('.archive-badge')).toHaveText('Archive');
  await page.locator('.result-group').filter({ has: page.locator('.archive-badge') }).locator('.result-snippet').first().click();
  await expect(page.locator('#note-title')).toHaveText('Other'); await expect(page.locator('#stored-banner')).toContainText('Archive');
  await expect(page.locator('.editor-pane')).toBeHidden(); await expect(page.locator('#save-note')).toBeHidden(); await expect(page.locator('button[data-mode="edit"]')).toBeHidden();
  await expect(page.locator('#preview .search-target')).toHaveCount(1);
  page.once('dialog', d => d.accept()); await rowAction(page, 'Other', 'Move to Trash', '#archive-tree');
  await expect(page.locator('#trash-count')).toHaveText('1'); await expect(page.locator('#archive-count')).toHaveText('0');
  await page.locator('#search-launch').click(); await page.locator('#search-input').fill('needle'); await expect(page.locator('#search-summary')).toHaveText('1 matching notebook · 3 text matches');
  await rowAction(page, 'Other', 'Restore', '#trash-tree'); await expect(page.locator('#archive-count')).toHaveText('1');
  await rowAction(page, 'Other', 'Unarchive', '#archive-tree'); await expect(page.locator('#pinned')).toContainText('Other');
  expect(await fs.readFile(path.join(root, 'collections/Other.md'), 'utf8')).toBe('# Other\n\nneedle needle');
});

test('folder menus move all contents, support partial restore, and request alternate destinations on collisions', async ({ page }) => {
  await fs.mkdir(path.join(root, 'collections/Folder ü/Child'), { recursive: true });
  await fs.writeFile(path.join(root, 'collections/Folder ü/Child/A.md'), '# A');
  await fs.writeFile(path.join(root, 'collections/Folder ü/data.bin'), 'unrelated');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('#tree')).toContainText('Folder ü');
  await rowAction(page, 'Folder ü', 'Rename/Move'); await page.locator('#path-input').fill('Moved ü'); await page.locator('#submit-dialog').click(); await expect(page.locator('#path-dialog')).toBeHidden();
  expect(await fs.readFile(path.join(root, 'collections/Moved ü/data.bin'), 'utf8')).toBe('unrelated');
  await rowAction(page, 'Moved ü', 'New Subfolder'); await expect(page.locator('#path-input')).toHaveValue('Moved ü/'); await page.locator('#path-input').fill('Moved ü/Empty'); await page.locator('#submit-dialog').click(); await expect(page.locator('#path-dialog')).toBeHidden();
  await rowAction(page, 'Moved ü', 'Archive'); await expect(page.locator('#archive-count')).toHaveText('1');
  await page.locator('#archive-tree > details > summary').click(); await page.locator('#archive-tree .tree-children > details').filter({ has: page.locator('summary span').filter({ hasText: /^Child$/ }) }).locator('summary').first().click();
  await rowAction(page, 'A', 'Unarchive', '#archive-tree'); await expect(page.locator('#tree')).toContainText('A');
  await rowAction(page, 'Moved ü', 'Unarchive', '#archive-tree'); await expect(page.locator('#path-dialog')).toBeVisible(); await expect(page.locator('#dialog-hint')).toContainText('occupied');
  await page.locator('#path-input').fill('Recovered ü'); await page.locator('#submit-dialog').click(); await expect(page.locator('#path-dialog')).toBeHidden();
  expect(await fs.readFile(path.join(root, 'collections/Recovered ü/data.bin'), 'utf8')).toBe('unrelated');
  expect(await fs.readFile(path.join(root, 'collections/Moved ü/Child/A.md'), 'utf8')).toBe('# A');
  let message; page.once('dialog', d => { message = d.message(); d.accept(); }); await rowAction(page, 'Recovered ü', 'Move to Trash');
  await expect(page.locator('#trash-count')).toHaveText('1'); expect(message).toContain('Recovered ü'); expect(message).toContain('1 files');
  await rowAction(page, 'Recovered ü', 'Restore', '#trash-tree'); await expect(page.locator('#trash-count')).toHaveText('0');
});

test('menus support keyboard focus and mobile touch; destructive operations confirm; failed saves block archive', async ({ page }) => {
  const group = page.locator('#tree').getByRole('group', { name: 'Actions for UI Fixture', exact: true });
  await group.getByRole('button', { name: 'Pin', exact: true }).focus(); await expect(group).toHaveCSS('opacity', '1');
  await page.keyboard.press('End'); await expect(group.getByRole('button', { name: 'Move to Trash', exact: true })).toBeFocused();
  await page.keyboard.press('Home'); await expect(group.getByRole('button', { name: 'Pin', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.locator('#tree').getByRole('button', { name: 'UI Fixture', exact: true })).toBeFocused();
  await openFixture(page); await page.route('**/api/note', route => route.request().method() === 'PUT' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Disk failure"}' }) : route.continue());
  await replaceContent(page, '# Preserve my draft'); await rowAction(page, 'UI Fixture', 'Archive'); await expect(page.locator('#save-label')).toHaveText('Save failed · retry'); await expect(page.locator('#archive-count')).toHaveText('0'); await expect(page.locator('.cm-content')).toContainText('Preserve my draft');
  await page.unroute('**/api/note'); await page.keyboard.press('ControlOrMeta+S'); await expect(page.locator('#save-label')).toHaveText('Saved to disk');
  await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#toggle-sidebar').click();
  const canceledTrash = page.waitForEvent('dialog').then(d => d.dismiss()); await rowAction(page, 'UI Fixture', 'Move to Trash'); await canceledTrash; await expect(page.locator('#trash-count')).toHaveText('0');
  page.once('dialog', d => d.accept()); await rowAction(page, 'UI Fixture', 'Move to Trash'); await expect(page.locator('#trash-count')).toHaveText('1');
  const canceledPurge = page.waitForEvent('dialog').then(d => d.dismiss()); await rowAction(page, 'UI Fixture', 'Delete Permanently', '#trash-tree'); await canceledPurge; await expect(page.locator('#trash-count')).toHaveText('1');
  const canceledEmpty = page.waitForEvent('dialog').then(d => d.dismiss()); await page.locator('#empty-trash').click(); await canceledEmpty; await expect(page.locator('#trash-count')).toHaveText('1');
  await page.screenshot({ path: '/tmp/fieldnotes-storage-mobile.png', fullPage: true });
  page.once('dialog', d => d.accept()); await page.locator('#empty-trash').click(); await expect(page.locator('#trash-count')).toHaveText('0'); await expect(page.locator('#trash-tree')).toContainText('Trash is empty');
});

test('archived Jupyter displays saved cells and outputs without execution controls', async ({ page }) => {
  await page.locator('#search-launch').click(); await page.locator('#search-input').fill('Ch10-Sinusoidal'); await page.locator('.result-title').click();
  await expect(page.locator('#note-title')).toHaveText('[Untitled]');
  await rowAction(page, 'Ch10-Sinusoidal Steady-State Analysis', 'Archive', '#recent');
  await page.locator('#archive-tree .note-link').click(); await expect(page.locator('#stored-banner')).toContainText('Archive');
  await expect(page.locator('.nb-cell')).not.toHaveCount(0); await expect(page.locator('#jupyter-editor .cm-content')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Start kernel', exact: true })).toHaveCount(0);
  await expect(page.locator('.cell-output')).toHaveCount(8); await expect(page.locator('.cell-output').first()).not.toBeEmpty();
  await page.screenshot({ path: '/tmp/fieldnotes-archive-jupyter.png', fullPage: true });
  await page.locator('#restore-current').click(); await expect(page.locator('#archive-count')).toHaveText('0');
});

test('archived original images remain available and legacy Trash recovers without invented paths', async ({ page }) => {
  for (const name of ['Aug-25', 'Dec-25']) {
    await page.locator('#search-launch').click(); await page.locator('#search-input').fill(name); await page.locator('.result-title').filter({ hasText: name }).click();
    await rowAction(page, name, 'Archive', '#recent'); await page.locator('#archive-tree').getByRole('button', { name, exact: true }).click();
    const image = page.locator('#preview img[src^="/api/attachments/"]'); await image.scrollIntoViewIfNeeded(); await expect.poll(() => image.evaluate(img => img.complete && img.naturalWidth > 0)).toBeTruthy();
  }
  await kernels.close(); await terminals.close(); await new Promise(resolve => server.close(resolve)); await store.queue;
  const files = ['1791340000000-11111111-1111-4111-8111-111111111111-test.md', '1791340001000-22222222-2222-4222-8222-222222222222-test.md'];
  for (const name of files) await fs.writeFile(path.join(root, '.notebook/trash', name), '# test\n');
  const port = Number(new URL(base).port); ({ server, kernels, terminals, store } = await createApp(root)); await new Promise(resolve => server.listen(port, '127.0.0.1', resolve)); await page.reload();
  await page.locator('#trash-section > summary').click(); await expect(page.locator('#trash-count')).toHaveText('2'); await expect(page.locator('#trash-tree .stored-detail').first()).toContainText('Original location unknown');
  await page.locator('#trash-tree .sidebar-row').first().hover(); await page.locator('#trash-tree .row-actions').first().getByRole('button', { name: 'Restore', exact: true }).click(); await expect(page.locator('#trash-count')).toHaveText('1');
  await page.locator('#trash-tree .sidebar-row').first().hover(); await page.locator('#trash-tree .row-actions').first().getByRole('button', { name: 'Restore', exact: true }).click(); await expect(page.locator('#path-dialog')).toBeVisible(); await page.locator('#path-input').fill('Recovered legacy.md'); await page.locator('#submit-dialog').click(); await expect(page.locator('#trash-count')).toHaveText('0');
  await expect(page.locator('#archive-count')).toHaveText('2');
});

test('a failed open draft does not prevent managing an unrelated sidebar row', async ({ page }) => {
  await fs.writeFile(path.join(root, 'collections/Separate.md'), '# Separate'); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(page.locator('#tree')).toContainText('Separate');
  await openFixture(page); await page.route('**/api/note', route => route.request().method() === 'PUT' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Disk failure"}' }) : route.continue());
  await replaceContent(page, '# Unsaved draft'); await expect(page.locator('#save-label')).toHaveText('Save failed · retry');
  await rowAction(page, 'Separate', 'Pin'); await rowAction(page, 'Separate', 'Archive'); await expect(page.locator('#archive-count')).toHaveText('1');
  await expect(page.locator('#note-title')).toHaveText('Unsaved draft'); await expect(page.locator('.cm-content')).toContainText('Unsaved draft');
  await page.unroute('**/api/note'); await page.keyboard.press('ControlOrMeta+S'); await expect(page.locator('#save-label')).toHaveText('Saved to disk');
});

async function terminalShortcut(page) { const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform)); return mac ? 'Meta' : 'Control'; }
async function shellCommand(page, command) { await expect.poll(async () => (await terminalOutput(page)).trim(), { timeout: 10000 }).toMatch(/[$#➜]\s*$/u); const input = page.locator('#terminal-host .xterm-helper-textarea'); await input.focus(); await page.keyboard.insertText(command); await page.keyboard.press('Enter'); }
async function terminalOutput(page) { return page.locator('#terminal-host .xterm-screen').innerText(); }

test('top sidebar controls and app shortcuts work from editor, search, terminal and mobile', async ({ page }) => {
  const mod = await terminalShortcut(page);
  expect(await page.locator('#collapse-sidebar').evaluate(e => e.closest('.sidebar-heading') !== null)).toBe(true); await expect(page.locator('.sidebar-footer button')).toHaveCount(0);
  await page.locator('#collapse-sidebar').click(); await expect(page.locator('body')).toHaveClass(/sidebar-collapsed/); await page.locator('#toggle-sidebar').click(); await expect(page.locator('body')).not.toHaveClass(/sidebar-collapsed/);
  await page.keyboard.press(`${mod}+j`); await expect(page.locator('#notice')).toContainText('Open a notebook first');
  await openFixture(page); await page.locator('#vim-toggle').click(); await page.locator('.cm-content').focus(); await page.keyboard.press(`${mod}+b`); await expect(page.locator('body')).toHaveClass(/sidebar-collapsed/); await page.keyboard.press(`${mod}+b`);
  await page.keyboard.press(`${mod}+j`); await expect(page.locator('#terminal-panel')).toBeVisible(); await expect(page.locator('#terminal-status')).toHaveText('Connected');
  await page.keyboard.press(`${mod}+b`); await expect(page.locator('body')).toHaveClass(/sidebar-collapsed/); await page.keyboard.press(`${mod}+b`); await page.keyboard.press(`${mod}+j`); await expect(page.locator('#terminal-panel')).toBeHidden();
  await page.locator('#search-launch').click(); await page.locator('#search-input').focus(); await page.keyboard.press(`${mod}+b`); await expect(page.locator('body')).toHaveClass(/sidebar-collapsed/); await page.keyboard.press(`${mod}+b`);
  await page.setViewportSize({ width: 390, height: 844 }); await page.keyboard.press(`${mod}+b`); await expect(page.locator('body')).toHaveClass(/sidebar-open/); await page.locator('#collapse-sidebar').click(); await expect(page.locator('body')).not.toHaveClass(/sidebar-open/);
  await page.keyboard.press('Escape'); await page.keyboard.press(`${mod}+j`); await expect(page.locator('#terminal-panel')).toBeVisible(); await expect(page.locator('#terminal-status')).toHaveText('Connected');
  expect(await page.locator('#terminal-panel').evaluate(e => e.getBoundingClientRect().bottom)).toBeLessThanOrEqual(844);
  await page.screenshot({ path: '/tmp/fieldnotes-terminal-mobile.png', fullPage: true });
});

test('per-notebook terminal input, hiding, switching, reconnecting, resize and close preserve shell state', async ({ page }) => {
  await fs.writeFile(path.join(root, 'collections/Separate.md'), '# Separate'); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(page.locator('#tree')).toContainText('Separate');
  await openFixture(page); const mod = await terminalShortcut(page); await page.keyboard.press(`${mod}+j`); await expect(page.locator('#terminal-status')).toHaveText('Connected');
  await shellCommand(page, "export NOTEBOOK_VALUE=42; printf 'FIRST_%s\\n' \"$NOTEBOOK_VALUE\""); await expect.poll(() => terminalOutput(page)).toContain('FIRST_42');
  await page.keyboard.press(`${mod}+j`); await expect(page.locator('#terminal-panel')).toBeHidden(); await page.keyboard.press(`${mod}+j`); await expect.poll(() => terminalOutput(page)).toContain('FIRST_42');
  const initialHeight = await page.locator('#terminal-panel').evaluate(e => e.clientHeight); await page.locator('#terminal-divider').focus(); await page.keyboard.press('ArrowUp'); expect(await page.locator('#terminal-panel').evaluate(e => e.clientHeight)).toBeGreaterThan(initialHeight);
  await page.locator('#tree').getByRole('button', { name: 'Separate', exact: true }).click({ position: { x: 30, y: 17 } }); await expect(page.locator('#terminal-title')).toHaveText('Separate'); await expect(page.locator('#terminal-status')).toHaveText('Connected');
  await shellCommand(page, "printf 'SECOND_%s\\n' \"${NOTEBOOK_VALUE-unset}\""); await expect.poll(() => terminalOutput(page)).toContain('SECOND_unset');
  await openFixture(page); await expect(page.locator('#terminal-title')).toHaveText('UI Fixture'); await shellCommand(page, "printf 'RETURNED_%s\\n' \"$NOTEBOOK_VALUE\""); await expect.poll(() => terminalOutput(page)).toContain('RETURNED_42');
  const ids = terminals.list().map(s => s.id); await page.reload(); await openFixture(page); await page.keyboard.press(`${mod}+j`); await expect(page.locator('#terminal-status')).toHaveText('Connected'); expect(terminals.list().map(s => s.id)).toEqual(ids); await expect.poll(() => terminalOutput(page)).toContain('RETURNED_42');
  await page.screenshot({ path: '/tmp/fieldnotes-terminal.png', fullPage: true });
  await shellCommand(page, 'exit'); await expect(page.locator('#terminal-status')).toContainText('Shell exited'); await page.getByRole('button', { name: 'New session', exact: true }).click(); await expect(page.locator('#terminal-status')).toHaveText('Connected');
  await page.locator('#close-terminal').click(); await expect(page.locator('#terminal-panel')).toBeHidden(); expect(terminals.list().filter(s => s.path === 'UI Fixture.md')).toHaveLength(0);
});

test('terminals use imported Jupyter directories and lifecycle confirmations preserve commands on cancellation', async ({ page }) => {
  await page.locator('#search-launch').click(); await page.locator('#search-input').fill('Ch04-circuit'); await page.locator('.result-title').click(); await expect(page.locator('#note-title')).toHaveText('4. Circuit Theorem'); const mod = await terminalShortcut(page); await page.keyboard.press(`${mod}+j`); await expect(page.locator('#terminal-status')).toHaveText('Connected');
  await expect(page.locator('#terminal-cwd')).toHaveText(path.join(root, 'circuits/electric circuits-7th')); await shellCommand(page, "printf 'IMPORTED_CWD_%s\\n' \"$PWD\""); await expect.poll(() => terminalOutput(page)).toContain(path.join(root, 'circuits/electric circuits-7th'));
  const canceled = page.waitForEvent('dialog').then(d => { expect(d.message()).toContain('affected terminal'); return d.dismiss(); }); await rowAction(page, 'Ch04-circuit theorems', 'Archive', '#recent'); await canceled; await expect(page.locator('#archive-count')).toHaveText('0'); expect(terminals.list()[0].alive).toBe(true);
  const confirmed = page.waitForEvent('dialog').then(d => d.accept()); await rowAction(page, 'Ch04-circuit theorems', 'Archive', '#recent'); await confirmed; await expect(page.locator('#archive-count')).toHaveText('1'); expect(terminals.list()).toHaveLength(0);
  await page.locator('#archive-tree .note-link').click(); await expect(page.locator('#stored-banner')).toContainText('Archive'); await expect(page.locator('#toggle-terminal')).toBeDisabled(); await page.keyboard.press(`${mod}+j`); await expect(page.locator('#terminal-panel')).toBeHidden(); await expect(page.locator('#notice')).toContainText('Restore this notebook');
});

test('mixed files edit text, preserve BOM/newlines, search Archive, preview images/PDFs and download binary data', async ({ page }) => {
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  await fs.writeFile(path.join(root,'collections/helper.py'),Buffer.from('\ufeffvalue = "file needle"\r\nprint(value)\r\n'));
  await fs.writeFile(path.join(root,'collections/picture.png'),png); await fs.writeFile(path.join(root,'collections/document.pdf'),'%PDF-1.4\n%%EOF\n'); await fs.writeFile(path.join(root,'collections/opaque.bin'),Buffer.from([0,255,1])); await fs.writeFile(path.join(root,'collections/page.html'),'<script>window.fileExecuted=true</script>');
  await page.evaluate(()=>window.dispatchEvent(new Event('focus'))); await expect(page.locator('#tree')).toContainText('helper.py'); await page.locator('#tree').getByRole('button',{name:'helper.py',exact:true}).click();
  await expect(page.locator('#note-title')).toHaveText('helper.py'); await page.locator('button[data-mode="edit"]').click(); await expect.poll(()=>page.locator('#editor .cm-line span[class]').count()).toBeGreaterThan(0);
  await page.locator('#editor .cm-content').click(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.insertText('value = "file needle"\nprint(99)\n'); await page.keyboard.press('ControlOrMeta+S'); await expect(page.locator('#save-label')).toHaveText('Saved to disk'); expect(await fs.readFile(path.join(root,'collections/helper.py'),'utf8')).toBe('\ufeffvalue = "file needle"\r\nprint(99)\r\n');
  await rowAction(page,'helper.py','Archive'); await page.locator('#search-launch').click(); await page.locator('#search-input').fill('file needle'); await expect(page.locator('.archive-badge')).toHaveText('Archive'); await page.locator('.result-snippet').click(); await expect(page.locator('#preview')).toContainText('file needle'); await expect(page.locator('#save-note')).toBeHidden();
  await page.locator('#tree').getByRole('button',{name:'picture.png',exact:true}).click(); await expect.poll(()=>page.locator('#file-viewer img').evaluate(e=>e.complete&&e.naturalWidth>0)).toBeTruthy(); await expect(page.locator('#toggle-terminal')).toBeEnabled();
  await page.locator('#tree').getByRole('button',{name:'document.pdf',exact:true}).click(); await expect(page.locator('#file-viewer iframe')).toHaveAttribute('src',/preview=true/);
  await page.locator('#tree').getByRole('button',{name:'opaque.bin',exact:true}).click(); await expect(page.locator('#file-viewer')).toContainText('not editable UTF-8'); await expect(page.getByRole('link',{name:'Download file'})).toBeVisible(); await expect(page.locator('.mode-switch')).toBeHidden();
  await page.locator('#tree').getByRole('button',{name:'page.html',exact:true}).click(); await expect(page.locator('#editor')).toContainText('window.fileExecuted'); expect(await page.evaluate(()=>window.fileExecuted)).toBeUndefined();
  await page.screenshot({path:'/tmp/workbench-mixed-files.png',fullPage:true,animations:'disabled'});
});
