import { renderMarkdown } from './render.js';

let disposeExport;

// Render a snapshot independently of the editor mode and its debounced preview.
export async function exportMarkdownPDF({ source, path, attachments }) {
  disposeExport?.();
  const article = document.createElement('article');
  article.id = 'pdf-export';
  article.className = 'prose';
  article.setAttribute('aria-hidden', 'true');
  renderMarkdown(article, source, attachments);
  article.querySelectorAll('img').forEach(img => { img.loading = 'eager'; });
  document.body.append(article);

  const previousTitle = document.title;
  const filename = path.split('/').at(-1).replace(/\.md$/i, '');
  let timeout;
  const cleanup = () => {
    clearTimeout(timeout);
    article.remove();
    document.body.classList.remove('exporting-pdf');
    if (document.title === filename) document.title = previousTitle;
    window.removeEventListener('afterprint', cleanup);
    if (disposeExport === cleanup) disposeExport = undefined;
  };
  disposeExport = cleanup;
  try {
    await Promise.race([
      Promise.all([
        document.fonts.ready,
        ...[...article.querySelectorAll('img[src]')].map(img => img.decode().catch(() => {
          // Preserve a readable caption when an image cannot be loaded.
          const caption = document.createElement('span');
          caption.textContent = `${img.alt || 'Image'} (image unavailable)`;
          img.replaceWith(caption);
        }))
      ]),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('PDF images or fonts took too long to load. Please try again.')), 15000); })
    ]);
    clearTimeout(timeout);
    document.title = filename;
    document.body.classList.add('exporting-pdf');
    window.addEventListener('afterprint', cleanup);
    window.print();
    // afterprint handles both saving and cancellation, including browsers where
    // print() returns before the dialog closes.
  } catch (error) {
    cleanup();
    throw error;
  }
}
