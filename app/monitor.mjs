// Home Control (the dashboard): the transmission view and analytics, served by server.mjs at its root
// (`/`, `/api/activity`, `POST /api/volume`) and reading the server's own live state.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const label = process.env.VOICE_LABEL || 'voice';
const stateDir = process.env.VOICE_STATE || path.join(os.homedir(), '.local/share/home-control/state', label);
const TAIL_WINDOW_BYTES = 256 * 1024; // only scan the last chunk of a log file, not the whole thing
const ENTRY_TEXT_LIMIT = 16000;       // cap per-entry text so one huge tool call can't bloat the payload
const SESSION_ENTRY_LIMIT = 80;
const SESSION_ID_RE = /^[a-f0-9-]{36}$/i;

// Read the last `count` non-empty lines of a file, scanning only the final
// TAIL_WINDOW_BYTES so a giant log still resolves fast.
function tailLines(name, count, directory = stateDir) {
  let fd;
  try {
    fd = fs.openSync(path.join(directory, name), 'r');
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - TAIL_WINDOW_BYTES);
    const bytes = Buffer.alloc(size - start);
    fs.readSync(fd, bytes, 0, bytes.length, start);
    const lines = bytes.toString('utf8').split('\n');
    if (start) lines.shift(); // drop a line we may have started reading mid-way through
    return lines.filter(Boolean).slice(-count);
  } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Turn one JSONL row from a Claude Code session transcript into zero or more
// dashboard entries (text / tool call / tool result), tagged with a stable id.
function entriesFromRow(row) {
  const blocks = row.message?.content;
  if (!Array.isArray(blocks)) return [];
  const entries = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const base = { id: (row.uuid || row.timestamp) + ':' + i, at: row.timestamp };
    if (block.type === 'text' && block.text) entries.push({ ...base, type: row.type, text: block.text.slice(0, ENTRY_TEXT_LIMIT) });
    if (block.type === 'tool_use') entries.push({ ...base, type: 'tool', toolId: block.id, name: block.name, text: JSON.stringify(block.input || {}, null, 2).slice(0, ENTRY_TEXT_LIMIT) });
    if (block.type === 'tool_result') {
      const content = typeof block.content === 'string' ? block.content : (Array.isArray(block.content) ? block.content.filter(x => x.type === 'text').map(x => x.text).join('\n') : '');
      entries.push({ ...base, type: 'result', toolId: block.tool_use_id, error: !!block.is_error, text: content.slice(0, ENTRY_TEXT_LIMIT) || '(No text output)' });
    }
  }
  return entries;
}

// Read only visible conversation and tool blocks from the voice session, i.e. the Claude
// Code project transcript the voice server is driving. Sidechain rows (subagent work) are
// skipped since the dashboard only shows the main conversation thread.
function sessionSnapshot() {
  let session;
  try { session = JSON.parse(fs.readFileSync(path.join(stateDir, 'claude-session.json'), 'utf8')); } catch { return { id: null, entries: [] }; }
  if (!SESSION_ID_RE.test(session.id || '')) return { id: null, entries: [] };

  const root = process.env.VOICE_ROOT || os.homedir();
  const projectDir = path.join(os.homedir(), '.claude', 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'));

  let model = null;
  const entries = [];
  for (const line of tailLines(session.id + '.jsonl', 300, projectDir)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.isSidechain || !['user', 'assistant'].includes(row.type)) continue;
    if (row.message?.model) model = row.message.model;
    entries.push(...entriesFromRow(row));
  }
  return { id: session.id, model, entries: entries.slice(-SESSION_ENTRY_LIMIT) };
}

const readEvents = () => tailLines('voice.log', 100).map(line => ({ at: line.slice(0, 24), text: line.slice(25) }));
const readTurns = () => tailLines('transcript.jsonl', 30).flatMap(line => {
  try { const t = JSON.parse(line); return [{ at: t.at, user: t.user, spoken: t.spoken, ms: t.ms }]; } catch { return []; }
});

// Assemble the full payload served at /api/activity, exactly as monitor.html expects it.
// live(): the server's { nowPlaying, sentences, rate, volume }; it is this process, so always online.
function snapshot(live) {
  return {
    online: true, events: readEvents(), turns: readTurns(), session: sessionSnapshot(),
    nowPlaying: live?.nowPlaying || null, sentences: live?.sentences || [], rate: live?.rate || 1, volume: live?.volume || null,
    at: new Date().toISOString(),
  };
}

// The dashboard's routes. Returns false for any other path, which server.mjs then handles.
// postVolume(body) -> { status, body }: the server's own volume setter.
export function createDashboard({ port, live, postVolume }) {
  return async (req, res, pathname) => {
    const volumePost = pathname === '/api/volume' && req.method === 'POST';
    if (pathname !== '/' && pathname !== '/api/activity' && !volumePost) return false;
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) { res.writeHead(403); res.end(); return true; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'");
    if (volumePost) {
      // JSON only, from this page only: a form on another site can't send application/json
      // without a preflight this server never answers, and a browser always sends its Origin.
      const origin = req.headers.origin;
      if (!(req.headers['content-type'] || '').startsWith('application/json') || (origin && origin !== `http://${req.headers.host}`)) { res.writeHead(403); res.end(); return true; }
      let raw;
      try { raw = await req.body({ maxBytes: 4096 }); } catch { if (!res.headersSent && !res.destroyed) res.writeHead(413); res.end(); return true; }
      const { status, body } = postVolume(raw.toString('utf8'));
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return true;
    }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return true; }
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fs.readFileSync(path.join(here, 'monitor.html'))); return true; }
    try { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(snapshot(live()))); }
    catch { res.writeHead(500); res.end('{}'); }
    return true;
  };
}
