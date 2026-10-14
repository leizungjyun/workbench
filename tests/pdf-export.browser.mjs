import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';

let root, app, base;
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const source = `# PDF 测试\n\n- [x] Complete\n\n| Topic | Value |\n| --- | --- |\n| Math | $x^2$ |\n\n$$\\int_0^1 x\\,dx = \\frac12$$\n\n\`\`\`js\n${'const longLine = "' + 'a'.repeat(200) + '";'}\n\`\`\`\n\n![Fixture](${image})\n\n<script>window.pdfPwned = true</script>\n`;

test.beforeEach(async ({ page }) => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-pdf-'));
  await fs.mkdir(path.join(root, 'collections'));
  await fs.writeFile(path.join(root, 'collections/Export.md'), source);
  await fs.writeFile(path.join(root, 'collections/Code.ipynb'), JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }));
  await fs.symlink(path.resolve('dist'), path.join(root, 'dist'));
  app = await createApp(root);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await page.goto(`${base}/?path=Export.md`);
  await page.evaluate(() => { localStorage.setItem('fieldnotes-vim', false); });
  await page.reload();
  await expect(page.locator('#note-title')).toHaveText('PDF 测试');
  await page.evaluate(() => { window.print = () => { window.printCalls = (window.printCalls || 0) + 1; }; });
});

test.afterEach(async ({ page }) => {
  await page.close(); await app.terminals.close(); await app.kernels.close();
  app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
});

test('exports rendered notebook in every mode, paginates and cleans up after cancellation', async ({ page }, testInfo) => {
  const originalTitle = await page.title();
  for (const mode of ['edit', 'split', 'preview']) {
    await page.locator(`button[data-mode="${mode}"]`).click();
    await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.printCalls)).toBe(['edit', 'split', 'preview'].indexOf(mode) + 1);
    const article = page.locator('#pdf-export');
    await expect(article.locator('table')).toHaveCount(1);
    await expect(article.locator('.katex')).toHaveCount(2);
    await expect(article.locator('input[type=checkbox]')).toBeChecked();
    expect(await article.locator('img').evaluate(img => img.complete && img.naturalWidth > 0)).toBeTruthy();
    await expect(article.locator('script, [onerror]')).toHaveCount(0);
    expect(await page.evaluate(() => window.pdfPwned)).toBeUndefined();
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('#notebook')).toBeHidden();
    await expect(article).toBeVisible();
    const padding = await article.evaluate(el => getComputedStyle(el).paddingTop);
    expect(parseFloat(padding)).toBeCloseTo(25 * 96 / 25.4, 2);
    expect(await article.evaluate(el => el.scrollWidth <= el.clientWidth)).toBeTruthy();
    if (mode === 'preview') {
      // Exercise Chromium's real PDF renderer, including content beyond page one.
      await article.evaluate(el => { for (let i = 0; i < 100; i++) { const p = document.createElement('p'); p.textContent = `Paragraph ${i}: paginated notebook content.`; el.append(p); } });
      const pdf = await page.pdf({ path: testInfo.outputPath('notebook.pdf'), preferCSSPageSize: true });
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(pdf.toString('latin1').match(/\/Type \/Page\b/g).length).toBeGreaterThan(1);
    }
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await expect(article).toHaveCount(0);
    await expect(page.locator('#notebook')).toBeVisible();
    expect(await page.title()).toBe(originalTitle);
  }
});

test('content keeps 2.5 cm padding with zero print margins and a mobile viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addStyleTag({ content: '@media print { @page { margin: 0 } }' });
  await page.locator('#export-pdf').click();
  await expect.poll(() => page.evaluate(() => window.printCalls)).toBe(1);
  await page.emulateMedia({ media: 'print' });
  const geometry = await page.locator('#pdf-export').evaluate(el => {
    const style = getComputedStyle(el), outer = el.getBoundingClientRect(), heading = el.querySelector('h1').getBoundingClientRect();
    return { padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(parseFloat), left: heading.left - outer.left, top: heading.top - outer.top, clone: style.boxDecorationBreak };
  });
  for (const padding of geometry.padding) expect(padding).toBeCloseTo(25 * 96 / 25.4, 2);
  expect(geometry.left).toBeCloseTo(25 * 96 / 25.4, 1);
  expect(geometry.top).toBeCloseTo(25 * 96 / 25.4, 1);
  expect(geometry.clone).toBe('clone');
  await page.pdf({ path: testInfo.outputPath('padding.pdf'), preferCSSPageSize: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
});

test('exports unsaved source despite failed save and stale edit-mode preview', async ({ page }) => {
  await page.route('**/api/note', route => route.request().method() === 'PUT' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"offline"}' }) : route.continue());
  await page.locator('button[data-mode="edit"]').click();
  await page.locator('#editor .cm-content').click(); await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('# Unsaved snapshot\n\nLatest draft.');
  await expect(page.locator('#save-label')).toHaveText('Save failed · retry');
  await page.locator('#export-pdf').click();
  await expect.poll(() => page.evaluate(() => window.printCalls)).toBe(1);
  await expect(page.locator('#pdf-export h1')).toHaveText('Unsaved snapshot');
  await expect(page.locator('#pdf-export')).toContainText('Latest draft.');
  expect(await fs.readFile(path.join(root, 'collections/Export.md'), 'utf8')).toBe(source);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('#editor .cm-content')).toContainText('Latest draft.');
});

test('read-only markdown can export; Jupyter does not show markdown export', async ({ page, context }) => {
  const duplicate = await context.newPage();
  await duplicate.goto(page.url());
  await expect(duplicate.locator('#stored-banner')).toBeVisible();
  await expect(duplicate.locator('#export-pdf')).toBeVisible();
  await duplicate.close();
  await page.locator('#tree').getByRole('button', { name: 'Code', exact: true }).click();
  await expect(page.locator('#export-pdf')).toBeHidden();
});
