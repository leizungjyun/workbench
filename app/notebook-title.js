import { Marked } from 'marked';
const parser = new Marked();

// Inspect root Markdown blocks so headings inside code or quotes do not name a notebook.
export function notebookHeading(source) {
  const normalized = source.replace(/\r\n?/g, '\n');
  let from = 0;
  for (const token of parser.lexer(normalized)) {
    const start = normalized.indexOf(token.raw, from);
    from = start + token.raw.length;
    if (token.type === 'heading' && token.depth === 1 && /^ {0,3}#(?:[\t ]|\r?\n|$)/.test(token.raw)) {
      let original = 0;
      for (let offset = 0; offset < start; offset++, original++) {
        if (source[original] === '\r' && source[original + 1] === '\n') original++;
      }
      const line = source.slice(original).split(/\r\n?|\n/)[0];
      return { title: token.text.trim(), from: original, to: original + line.length };
    }
  }
  return null;
}

export function replaceNotebookHeading(source, title) {
  const heading = notebookHeading(source);
  const line = `# ${title}`;
  return heading ? source.slice(0, heading.from) + line + source.slice(heading.to) : `${line}\n\n${source}`;
}
