import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notebookHeading, replaceNotebookHeading } from '../app/notebook-title.js';
test('notebook title uses the first root ATX level-one heading', () => {
  const source = '```md\n# Code\n```\n\n> # Quote\n\n## Subtitle\n\n# Actual ###\n\n# Later';
  assert.equal(notebookHeading(source).title, 'Actual');
  assert.equal(replaceNotebookHeading(source, 'New'), source.replace('# Actual ###', '# New'));
  assert.equal(notebookHeading('Setext\n======\n\n## Subtitle'), null);
  assert.equal(replaceNotebookHeading('Body', 'New'), '# New\n\nBody');
  assert.equal(notebookHeading('#\n').title, '');
  assert.equal(replaceNotebookHeading('Body\r\n\r\n# Old\r\nText', 'New'), 'Body\r\n\r\n# New\r\nText');
});
