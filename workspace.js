import path from 'node:path';
import os from 'node:os';
export function workspacePath(args = process.argv.slice(2), env = process.env) {
  let directory = env.WORKBENCH_WORKSPACE || path.join(os.homedir(), 'Documents', 'My Notebook');
  for (let i=0; i<args.length; i++) {
    if (args[i] === '--workspace' && args[i+1]) directory = args[++i];
    else if (args[i].startsWith('--workspace=')) directory = args[i].slice(12);
    else throw new Error('Usage: node server.js [--workspace <directory>]');
  }
  if (!directory.trim()) throw new Error('A workspace directory is required.');
  return path.resolve(directory);
}
