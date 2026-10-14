import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const error = (status, message) => Object.assign(new Error(message), { status });
export const isJupyter = name => /\.ipynb$/i.test(name);
export const sourceText = source => Array.isArray(source) ? source.join('') : source || '';
export function parseNotebook(content) {
  let n; try { n = JSON.parse(content); } catch { throw error(400, 'This .ipynb file is not valid JSON.'); }
  if (!n || n.nbformat !== 4 || !Array.isArray(n.cells) || !n.metadata || typeof n.metadata !== 'object') throw error(400, 'A Jupyter nbformat 4 notebook is required.');
  for (const c of n.cells) {
    if (!c || !['code', 'markdown', 'raw'].includes(c.cell_type) || !(typeof c.source === 'string' || (Array.isArray(c.source) && c.source.every(s => typeof s === 'string'))) || (c.cell_type === 'code' && !Array.isArray(c.outputs))) throw error(400, 'The notebook contains an invalid cell.');
  }
  return n;
}
export const newNotebook = () => ({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } }, cells: [{ id: randomUUID(), cell_type: 'code', metadata: {}, source: [], outputs: [], execution_count: null }] });

export class KernelService {
  constructor(store) { this.store = store; this.environments = new Map(); this.sessions = new Map(); this.startingPaths = new Set(); this.lastDiscovery = 0; this.discovery = null; }
  async discover(force = false) {
    if (this.discovery) return this.discovery;
    if (!force && this.lastDiscovery > Date.now() - 30000) return [...this.environments.values()];
    this.discovery = this.scan().finally(() => { this.discovery = null; });
    return this.discovery;
  }
  async scan() {
    const home = os.homedir(), prefixes = new Map();
    if (process.env.WORKBENCH_TEST_PYTHON) prefixes.set(path.dirname(path.dirname(process.env.WORKBENCH_TEST_PYTHON)), 'Configured');
    const candidates = [...new Set([process.env.CONDA_EXE, 'conda', ...['miniconda3', 'anaconda3', 'miniforge3', 'mambaforge'].map(d => path.join(home, d, 'bin/conda')), '/opt/anaconda3/bin/conda', '/opt/miniconda3/bin/conda', '/opt/homebrew/Caskroom/miniforge/base/bin/conda'].filter(Boolean))];
    for (const command of candidates) {
      try { const { stdout } = await exec(command, ['env', 'list', '--json'], { timeout: 10000, maxBuffer: 1024 * 1024 }); for (const prefix of JSON.parse(stdout).envs || []) prefixes.set(prefix, 'Conda'); break; } catch { /* Try registry and conventional paths below. */ }
    }
    try { for (const prefix of (await fs.readFile(path.join(home, '.conda/environments.txt'), 'utf8')).trim().split('\n').filter(Boolean)) prefixes.set(prefix, 'Conda'); } catch { /* Conda may not be installed. */ }
    const origins = this.store.state.notebookOrigins || {};
    for (const dir of new Set(['', ...Object.values(origins)])) for (const name of ['.venv', 'venv', '.conda']) {
      const prefix = path.join(this.store.root, dir, name);
      try { await fs.access(path.join(prefix, 'bin/python')); prefixes.set(prefix, 'Project'); } catch { /* Optional project environment. */ }
    }
    if (process.env.WORKBENCH_TEST_PYTHON) prefixes.set(path.dirname(path.dirname(process.env.WORKBENCH_TEST_PYTHON)), 'Configured');
    const probe = 'import sys,importlib.util,json;print(json.dumps({"version":sys.version.split()[0],"ipykernel":importlib.util.find_spec("ipykernel") is not None,"client":importlib.util.find_spec("jupyter_client") is not None}))';
    const results = await Promise.all([...prefixes].map(async ([prefix, kind]) => {
      const python = path.join(prefix, process.platform === 'win32' ? 'python.exe' : 'bin/python');
      try {
        const { stdout } = await exec(python, ['-c', probe], { timeout: 6000 }); const info = JSON.parse(stdout);
        return { id: createHash('sha256').update(prefix).digest('hex').slice(0, 24), name: kind === 'Configured' ? 'Configured Python' : path.basename(prefix), prefix, python, kind, version: info.version, available: info.ipykernel && info.client, reason: info.ipykernel && info.client ? '' : 'Needs ipykernel and jupyter_client' };
      } catch { return null; }
    }));
    this.environments = new Map(results.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name)).map(env => [env.id, env])); this.lastDiscovery = Date.now();
    return [...this.environments.values()];
  }
  sessionList() { return [...this.sessions.values()].filter(s => s.ready).map(({ id, path, environment, cwd, name, busy }) => ({ id, path, environment, cwd, name, busy })); }
  async start(input) {
    const relative = input.path;
    if (this.startingPaths.has(relative)) throw error(409, 'This notebook kernel is already starting.');
    this.startingPaths.add(relative);
    try { return await this.startKernel(input); } finally { this.startingPaths.delete(relative); }
  }
  async startKernel({ path: relative, environment }) {
    if (!isJupyter(relative || '')) throw error(400, 'Choose a Jupyter notebook first.');
    const note = await this.store.read(relative), notebook = parseNotebook(note.content);
    if (notebook.metadata.kernelspec?.language && notebook.metadata.kernelspec.language.toLowerCase() !== 'python') throw error(400, 'Execution currently supports Python notebooks. Other languages can still be edited and previewed.');
    await this.discover(); const env = this.environments.get(environment);
    if (!env?.available) throw error(400, 'Choose an available Python environment with ipykernel and jupyter_client.');
    const existing = this.sessionList().find(s => s.path === relative && s.environment === environment);
    if (existing) return existing;
    if (this.sessions.size >= 8) throw error(409, 'Eight kernels are already open. Stop an unused kernel first.');
    const cwd = await this.store.workingDirectory(relative);
    const id = randomUUID(), bridge = fileURLToPath(new URL('./scripts/kernel_bridge.py', import.meta.url));
    const child = spawn(env.python, ['-u', bridge], { cwd, env: { ...process.env, PATH: `${path.dirname(env.python)}${path.delimiter}${process.env.PATH || ''}`, CONDA_PREFIX: env.prefix, PYTHONUNBUFFERED: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const session = { id, path: relative, environment, cwd, name: env.name, child, pending: new Map(), busy: false, ready: false, stderr: '' };
    this.sessions.set(id, session);
    child.stderr.on('data', chunk => { session.stderr = (session.stderr + chunk.toString()).slice(-4000); });
    child.stdin.on('error', () => {});
    const lines = createInterface({ input: child.stdout });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { reject(error(504, 'Kernel startup timed out.')); this.stop(id); }, 40000);
        lines.on('line', line => {
          let msg; try { msg = JSON.parse(line); } catch { return; }
          if (msg.ready) { clearTimeout(timer); session.ready = true; resolve(); }
          if (msg.id && session.pending.has(msg.id)) { const pending = session.pending.get(msg.id); session.pending.delete(msg.id); clearTimeout(pending.timer); msg.error ? pending.reject(error(400, msg.error)) : pending.resolve(msg.result); }
        });
        const ended = (code, signal) => {
          clearTimeout(timer); this.sessions.delete(id);
          const lastLine = session.stderr.trim().split('\n').at(-1);
          const reason = error(400, `Kernel ${env.name} stopped${signal ? ` (${signal})` : ''}. ${lastLine || 'Try restarting or choose another environment.'}`);
          lines.close(); child.stdout.destroy(); child.stderr.destroy();
          reject(reason); for (const pending of session.pending.values()) { clearTimeout(pending.timer); pending.reject(reason); } session.pending.clear();
        };
        child.on('error', ended); child.on('exit', ended);
      });
      return { id, environment, cwd, name: env.name };
    } catch (e) { this.stop(id); throw e; }
  }
  request(id, action, args = {}) {
    const session = this.sessions.get(id); if (!session?.ready) throw error(404, 'Kernel is not running. Start it again.');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { session.pending.delete(requestId); reject(error(504, 'Kernel did not respond. Restart it to continue.')); this.stop(id); }, action === 'execute' ? 130000 : 10000);
      session.pending.set(requestId, { resolve, reject, timer }); session.child.stdin.write(JSON.stringify({ id: requestId, action, ...args }) + '\n');
    });
  }
  async execute({ session: id, code }) {
    if (typeof code !== 'string' || code.length > 1000000) throw error(400, 'Invalid cell source.');
    const session = this.sessions.get(id); if (!session) throw error(404, 'Kernel is not running.');
    if (session.busy) throw error(409, 'The kernel is busy. Wait or interrupt it.');
    session.busy = true; try { return await this.request(id, 'execute', { code }); } finally { session.busy = false; }
  }
  stop(id) { const session = this.sessions.get(id); if (session) { this.sessions.delete(id); session.child.kill('SIGTERM'); const timer = setTimeout(() => session.child.kill('SIGKILL'), 5000); timer.unref(); session.child.once('exit', () => clearTimeout(timer)); } return { ok: true }; }
  async close() { const children = [...this.sessions.values()].map(s => s.child); for (const id of this.sessions.keys()) this.stop(id); await Promise.all(children.map(child => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); }))); }
}
