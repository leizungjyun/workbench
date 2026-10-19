import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Marked } from 'marked';
import { cjkStrong } from '../app/cjk-strong.js';
const parse = source => new Marked(cjkStrong()).parse(source);

test('Chinese labels ending in punctuation render bold without requiring spaces', () => {
  assert.equal(parse('**来源：**录音'), '<p><strong>来源：</strong>录音</p>\n');
  assert.equal(parse('中文**（重点）**继续'), '<p>中文<strong>（重点）</strong>继续</p>\n');
  assert.equal(parse('**来源：**PDF'), '<p><strong>来源：</strong>PDF</p>\n');
  assert.equal(parse('**Source:**中文'), '<p><strong>Source:</strong>中文</p>\n');
  assert.equal(parse('- **讨论：**正文\n- **行动：**继续'), '<ul>\n<li><strong>讨论：</strong>正文</li>\n<li><strong>行动：</strong>继续</li>\n</ul>\n');
});

test('existing emphasis, spacing and Latin intraword behavior stay unchanged', () => {
  for (const source of ['**中文**正文', '**标签：** 正文', '**English:**next', '*斜体*', '***中文***', '**未结束：', '** 有空格：**正文', '__标签：__正文']) {
    assert.equal(parse(source), new Marked().parse(source), source);
  }
});

test('code and escaped markers remain literal', () => {
  for (const source of ['`**来源：**录音`', '```md\n**来源：**录音\n```', String.raw`\*\*来源：\*\*录音`]) {
    assert.equal(parse(source), new Marked().parse(source), source);
  }
});

test('links inside and after Chinese bold labels remain structured', () => {
  assert.equal(parse('**[来源](https://example.com)：**正文'), '<p><strong><a href="https://example.com">来源</a>：</strong>正文</p>\n');
  assert.equal(parse('**来源：**[论文](https://example.com)'), new Marked().parse('**来源：**[论文](https://example.com)'));
  assert.equal(parse('**来源：**正文 **行动：**继续'), '<p><strong>来源：</strong>正文 <strong>行动：</strong>继续</p>\n');
});
