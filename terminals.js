import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as pty from 'node-pty';
import { WebSocketServer, WebSocket } from 'ws';
const exec = promisify(execFile);
const error = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const within = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const dimensions = (cols, rows) => { if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 500 || rows > 300) throw error(400, 'Invalid terminal dimensions.'); };

export class TerminalService {
  constructor(store) { this.store = store; this.sessions = new Map(); this.stopping = new Set(); }
  list() { return [...this.sessions.values()].map(({ id, path, cwd, shell, alive, exitCode }) => ({ id, path, cwd, shell, alive, exitCode })); }
  async start({ path: relative, scope = 'active', cols = 80, rows = 24 }) {
    if (this.closing) throw error(503, 'The server is stopping. Reconnect after it restarts.');
    if (scope !== 'active') throw error(403, 'Restore this notebook before opening a terminal.');
    dimensions(cols, rows);
    const cwd = await this.store.workingDirectory(relative);
    const existing = [...this.sessions.values()].find(s => s.path === relative && s.alive);
    if (existing) return this.list().find(s => s.id === existing.id);
    if ([...this.sessions.values()].filter(s => s.alive).length >= 8) throw error(409, 'Eight terminals are already open. Close an unused session first.');
    const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
    if (!path.isAbsolute(shell)) throw error(400, 'The configured shell must be an absolute executable path.');
    try { await fs.access(shell, fs.constants.X_OK); } catch { throw error(503, 'The configured shell is unavailable or not executable. Check your SHELL setting.'); }
    if (this.closing) throw error(503, 'The server is stopping. Reconnect after it restarts.');
    let child; try { child = pty.spawn(shell, ['-i'], { name: 'xterm-256color', cols, rows, cwd, env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } }); }
    catch { throw error(503, 'The shell could not start. Check your configured shell and terminal installation.'); }
    for (const s of this.sessions.values()) if (s.path === relative && !s.alive) this.sessions.delete(s.id);
    const session = { id: randomUUID(), path: relative, cwd, shell, child, alive: true, output: '', sockets: new Set() };
    this.sessions.set(session.id, session);
    child.onData(data => { session.output = (session.output + data).slice(-262144); this.send(session, { type: 'output', data }); });
    child.onExit(({ exitCode, signal }) => { session.alive = false; session.exitCode = exitCode; this.send(session, { type: 'exit', exitCode, signal }); session.resolveExit?.(); });
    return this.list().find(s => s.id === session.id);
  }
  send(session, event) { const data = JSON.stringify(event); for (const socket of session.sockets) if (socket.readyState === WebSocket.OPEN) { if (socket.bufferedAmount > 1024 * 1024) socket.close(1013, 'Reconnect to replay terminal output.'); else socket.send(data); } }
  attach(server) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
    server.on('upgrade', (req, socket, head) => {
      const port = server.address()?.port, host = req.headers.host;
      const reject = () => { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); };
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host) || req.headers.origin !== `http://${host}`) return reject();
      const url = new URL(req.url, `http://${host}`), id = /^\/api\/terminal\/([a-f\d-]+)$/.exec(url.pathname)?.[1], session = this.sessions.get(id);
      if (!session || this.stopping.has(id)) return reject();
      this.wss.handleUpgrade(req, socket, head, ws => {
        session.sockets.add(ws); ws.send(JSON.stringify({ type: 'replay', data: session.output, alive: session.alive, exitCode: session.exitCode }));
        ws.on('message', raw => {
          try {
            const message = JSON.parse(raw.toString());
            if (!session.alive) return;
            if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 16000) session.child.write(message.data);
            else if (message.type === 'resize') { dimensions(message.cols, message.rows); session.child.resize(message.cols, message.rows); }
            else throw error(400, 'Invalid terminal message.');
          } catch { ws.close(1008, 'Invalid terminal message.'); }
        });
        ws.on('close', () => session.sockets.delete(ws)); ws.on('error', () => session.sockets.delete(ws));
      });
    });
  }
  async currentDirectory(session) {
    try {
      if (process.platform === 'linux') return await fs.readlink(`/proc/${session.child.pid}/cwd`);
      const { stdout } = await exec('/usr/sbin/lsof', ['-a', '-p', String(session.child.pid), '-d', 'cwd', '-Fn'], { timeout: 2000 });
      return stdout.split('\n').find(line => line.startsWith('n'))?.slice(1) || session.cwd;
    } catch { return session.cwd; }
  }
  async affected(location) {
    if (location.scope !== 'active') return [];
    const result = [], file = await fs.realpath(location.file);
    for (const session of this.sessions.values()) if (session.alive && (session.path === location.path || session.path.startsWith(location.path + '/') || within(file, await fs.realpath(session.cwd).catch(() => session.cwd)) || within(file, await this.currentDirectory(session)))) result.push(session);
    return result;
  }
  async stop(id) {
    const session = this.sessions.get(id); if (!session) throw error(404, 'Terminal session not found.');
    this.stopping.add(id);
    try {
      if (session.alive) {
        let descendants = [];
        try { const { stdout } = await exec('ps', ['-axo', 'pid=,ppid='], { timeout: 2000 }); const pairs = stdout.trim().split('\n').map(s => s.trim().split(/\s+/).map(Number)); const known = new Set([session.child.pid]); let changed = true; while (changed) { changed = false; for (const [pid, parent] of pairs) if (known.has(parent) && !known.has(pid)) { known.add(pid); changed = true; } } descendants = [...known].filter(pid => pid !== session.child.pid).reverse(); } catch { /* Still terminate the PTY process group below. */ }
        const kill = (pid, signal) => { try { process.kill(-pid, signal); } catch {} try { process.kill(pid, signal); } catch {} };
        const exited = new Promise(resolve => { session.resolveExit = resolve; });
        for (const pid of descendants) kill(pid, 'SIGTERM'); kill(session.child.pid, 'SIGTERM');
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 500))]);
        for (const pid of descendants) kill(pid, 'SIGKILL'); if (session.alive) { kill(session.child.pid, 'SIGKILL'); await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1000))]); }
      }
      for (const ws of session.sockets) ws.close(1000, 'Session closed.'); this.sessions.delete(id);
      return { ok: true };
    } finally { this.stopping.delete(id); }
  }
  async close() { this.closing = true; await Promise.all([...this.sessions.keys()].map(id => this.stop(id).catch(() => {}))); for (const ws of this.wss?.clients || []) ws.terminate(); this.wss?.close(); }
}
