import path from 'node:path';
import { TextDecoder } from 'node:util';
export const TEXT_LIMIT = 5 * 1024 * 1024;
export const hiddenEntry = name => name.startsWith('.') || ['__pycache__', 'node_modules', 'venv', 'env'].includes(name) || /\.py[co]$/i.test(name);
export function describeFile(name, bytes) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.ipynb') return { type: 'jupyter', editable: true };
  if (['.png','.jpg','.jpeg','.gif','.webp','.avif'].includes(ext)) return { type: 'image', editable: false };
  if (ext === '.pdf') return { type: 'pdf', editable: false };
  if (bytes.length > TEXT_LIMIT) return { type: 'binary', editable: false, reason: 'Text editing is limited to 5 MB.' };
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) throw new Error('Binary');
    return { type: ext === '.md' ? 'markdown' : 'text', editable: true, content, bom: bytes.subarray(0,3).equals(Buffer.from([239,187,191])) };
  } catch { return { type: 'binary', editable: false, reason: 'This file is not editable UTF-8 text.' }; }
}
export function encodeText(content, previous) {
  const endings = [...previous.matchAll(/\r\n|\r|\n/g)].map(m => m[0]);
  const common = endings.filter(e => e === '\r\n').length > endings.length / 2 ? '\r\n' : endings.filter(e => e === '\r').length > endings.length / 2 ? '\r' : '\n';
  let index = 0; const normalized = content.replace(/\r\n|\r|\n/g, () => endings[index++] || common);
  return Buffer.from((previous.startsWith('\ufeff') ? '\ufeff' : '') + normalized.replace(/^\ufeff/, ''), 'utf8');
}
export async function fileDigest(file) {
  const { createReadStream } = await import('node:fs'); const { createHash } = await import('node:crypto');
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
