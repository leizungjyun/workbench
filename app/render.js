import { Marked } from 'marked';
import { cjkStrong } from './cjk-strong.js';
import DOMPurify from 'dompurify';
import markedKatex from 'marked-katex-extension';
import katex from 'katex';
import 'katex/dist/katex.min.css';

export function safeHTML(target, html, allowNotebookLinks = false) {
  target.innerHTML = DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select'], FORBID_ATTR: ['style'] });
  target.querySelectorAll('input').forEach(input => { if (input.type !== 'checkbox') input.remove(); else { input.disabled = true; input.setAttribute('aria-label', input.checked ? 'Completed task' : 'Incomplete task'); } });
  target.querySelectorAll('a').forEach(a => {
    const href = a.getAttribute('href') || '';
    if (/^https?:/i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    else if (!(allowNotebookLinks && !/^[a-z][a-z\d+.-]*:/i.test(href) && /\.(md|ipynb)(?:#.*)?$/i.test(href)) && !href.startsWith('#') && !href.startsWith('mailto:')) a.removeAttribute('href');
  });
}
export function renderMarkdown(target, source, attachments = {}, onOpen, alignSource = false) {
  const liveTarget = target;
  target = document.createElement('div');
  // Sanitize user HTML first, then insert only KaTeX-generated math with trust disabled.
  const formulas = [], key = `math-${crypto.randomUUID()}`;
  const extension = markedKatex({ nonStandard: true });
  for (const e of extension.extensions) e.renderer = token => { const index = formulas.push(token) - 1; return `<span data-math="${key}-${index}"></span>`; };
  const parser = new Marked(extension, cjkStrong(), { walkTokens(token) { if (token.type === 'image' && attachments[token.href]) token.href = attachments[token.href]; } });
  let html;
  if (alignSource) {
    const tokens = parser.lexer(source);
    parser.walkTokens(tokens, token => { if (token.type === 'image' && attachments[token.href]) token.href = attachments[token.href]; });
    let cursor = 0;
    const spans = [];
    for (const token of tokens) {
      const position = source.indexOf(token.raw, cursor);
      const from = position < 0 ? cursor : position;
      cursor = from + token.raw.length;
      if (token.type !== 'space') spans.push({ token, from });
    }
    html = spans.map((span, index) => {
      const part = [span.token]; part.links = tokens.links;
      const from = index === 0 ? 0 : span.from;
      const to = spans[index + 1]?.from ?? source.length;
      return `<div class="source-block" data-source-from="${from}" data-source-to="${to}"><div class="source-content">${parser.parser(part)}</div></div>`;
    }).join('');
  } else html = parser.parse(source);
  safeHTML(target, html, !!onOpen);
  if (onOpen) target.querySelectorAll('a[href]').forEach(a => { const href = a.getAttribute('href'); if (!/^[a-z][a-z\d+.-]*:/i.test(href) && /\.(md|ipynb)(?:#.*)?$/i.test(href)) a.onclick = event => { event.preventDefault(); onOpen(href); }; });
  formulas.forEach((token, i) => { const slot = target.querySelector(`[data-math="${key}-${i}"]`); if (slot) { slot.removeAttribute('data-math'); katex.render(token.text, slot, { throwOnError: false, trust: false, displayMode: token.displayMode, strict: 'ignore', maxExpand: 1000 }); } });
  target.querySelectorAll('img').forEach(img => {
    const src = img.getAttribute('src') || '';
    if (attachments[src]) img.src = attachments[src];
    else if (!Object.values(attachments).includes(src) && !/^(https?:|data:image\/(png|jpeg|gif|webp);)/i.test(src)) { img.removeAttribute('src'); img.alt = `${img.alt || 'Image'} (attachment unavailable)`; }
    img.loading = 'lazy';
  });
  if (alignSource) {
    // Keep unchanged blocks (and loaded images) mounted. Preserve block heights
    // until the alignment pass measures changed content, avoiding a collapse.
    const previous = [...liveTarget.children], next = [...target.children];
    for (let i = 0; i < next.length; i++) {
      const old = previous[i], fresh = next[i];
      if (old?.classList.contains('source-block') && fresh.classList.contains('source-block')) {
        old.dataset.sourceFrom = fresh.dataset.sourceFrom;
        old.dataset.sourceTo = fresh.dataset.sourceTo;
        if (old.firstElementChild.innerHTML !== fresh.firstElementChild.innerHTML) old.firstElementChild.replaceWith(fresh.firstElementChild);
      } else if (old) old.replaceWith(fresh);
      else liveTarget.append(fresh);
    }
    for (let i = next.length; i < previous.length; i++) previous[i].remove();
    // Unchanged links remain mounted, so refresh their navigation callbacks too.
    if (onOpen) liveTarget.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href');
      if (!/^[a-z][a-z\d+.-]*:/i.test(href) && /\.(md|ipynb)(?:#.*)?$/i.test(href)) a.onclick = event => { event.preventDefault(); onOpen(href); };
    });
  } else liveTarget.replaceChildren(...target.childNodes);

}
