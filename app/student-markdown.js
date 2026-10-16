// Preserve saved Markdown verbatim; older rich-text documents are converted only
// for display in the source editor and stay unchanged until the user edits them.
export function markdownSource(node) {
  if (node?.type === 'markdown') return node.text;
  if (node?.type === 'text') {
    let text = node.text.replace(/[\\`*_\[\]<>#!|]/g, '\\$&');
    for (const mark of node.marks || []) {
      if (mark.type === 'bold') text = `**${text}**`;
      if (mark.type === 'italic') text = `*${text}*`;
      if (mark.type === 'link') text = `[${text}](${mark.attrs.href.replace(/[()]/g, c => c === '(' ? '%28' : '%29')})`;
    }
    return text;
  }
  if (node?.type === 'hardBreak') return '  \n';
  const children = node?.content || [];
  if (node?.type === 'heading') return `${'#'.repeat(node.attrs.level)} ${children.map(markdownSource).join('')}`;
  if (['bulletList', 'orderedList'].includes(node?.type)) return children.map((item, index) => {
    const marker = node.type === 'bulletList' ? '- ' : `${(node.attrs?.start || 1) + index}. `;
    return marker + markdownSource(item).replace(/\n/g, '\n' + ' '.repeat(marker.length));
  }).join('\n');
  return children.map(markdownSource).join(['doc', 'listItem'].includes(node?.type) ? '\n\n' : '');
}
