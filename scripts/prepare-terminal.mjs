import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
// node-pty's npm prebuild can ship spawn-helper without its executable bit.
// Restore it after install; otherwise POSIX shells fail with posix_spawnp.
if (process.platform !== 'win32') {
  const require = createRequire(import.meta.url), root = path.dirname(require.resolve('node-pty/package.json'));
  for (const relative of [`prebuilds/${process.platform}-${process.arch}/spawn-helper`, 'build/Release/spawn-helper', 'build/Debug/spawn-helper']) {
    const file = path.join(root, relative);
    try { const stat = await fs.stat(file); await fs.chmod(file, stat.mode | 0o111); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
