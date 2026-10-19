// CommonMark treats punctuation before a closing delimiter as intraword when
// prose follows without a space. Chinese labels commonly use **标题：**正文.
// Extend only that case; leave other emphasis rules to Marked.
export function cjkStrong() {
  return { extensions: [{
    name: 'cjkStrong',
    level: 'inline',
    start(source) { const index = source.indexOf('**'); return index < 0 ? undefined : index; },
    tokenizer(source) {
      const match = /^\*\*(?!\*)([^*\\`<>\n]+?)\*\*(?!\*)/u.exec(source);
      if (!match) return;
      const text = match[1], following = source.slice(match[0].length);
      if (text !== text.trim() || !/\p{P}$/u.test(text)) return;
      if (!/^[\p{L}\p{N}]/u.test(following)) return;
      if (!/\p{Script=Han}/u.test(text) && !/^\p{Script=Han}/u.test(following)) return;
      return { type: 'cjkStrong', raw: match[0], text, tokens: this.lexer.inlineTokens(text) };
    },
    renderer(token) { return `<strong>${this.parser.parseInline(token.tokens)}</strong>`; }
  }] };
}
