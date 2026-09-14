import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { readBody } from './request-body.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const label = process.env.VOICE_LABEL || 'voice';
const stateDir = process.env.VOICE_STATE || path.join(os.homedir(), '.local/share/home-control/state', label);
const port = Number(process.env.MONITOR_PORT || 4458);
// The voice server the dashboard reads from. Upstream hardcoded :4455 here,
// so a server on any other port was invisible to the monitor.
const voiceOrigin = `http://${process.env.VOICE_HOST || '127.0.0.1'}:${Number(process.env.VOICE_PORT || 4455)}`;

const FETCH_TIMEOUT_MS = 1500;
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

// The dashboard talks to the voice server's passphrase-gated /api/state route.
// Log in once with the token from the state dir and reuse the session cookie.
// Reading the token is fine: this server is bound to localhost.
let cookie = null;
async function login() {
  try {
    const key = fs.readFileSync(path.join(stateDir, 'voice-token'), 'utf8').trim();
    const r = await fetch(`${voiceOrigin}/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const set = r.headers.get('set-cookie');
    await r.body?.cancel();
    if (set) { cookie = set.split(';')[0]; return true; }
  } catch {}
  return false;
}

// Poll the voice server for what it's doing right now (nowPlaying + the turn's sentences);
// the dashboard has no live push channel, so this is how it follows along. A 401 still
// counts as "online" (server is up, just needs a fresh login for next time).
async function fetchLiveState() {
  try {
    const r = await fetch(`${voiceOrigin}/api/state`, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const online = r.status === 401 || r.ok;
    if (r.ok) { try { return { online, live: await r.json() }; } catch { return { online, live: null }; } }
    await r.body?.cancel();
    if (r.status === 401) await login();
    return { online, live: null };
  } catch { return { online: false, live: null }; }
}

// The page changes the speech volume through here, since only this server holds the voice
// server's login. A 401 gets one fresh login and a retry, so an expired cookie doesn't cost
// the user a drag that did nothing.
async function postVolume(body) {
  const send = () => fetch(`${voiceOrigin}/api/volume`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  try {
    let r = await send();
    if (r.status === 401) { await r.body?.cancel(); if (await login()) r = await send(); }
    if (r.status === 401) { await r.body?.cancel(); return { status: 502, body: { ok: false, error: 'login' } }; }
    let json = {};
    try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  } catch { return { status: 502, body: { ok: false, error: 'unreachable' } }; }
}

const readEvents = () => tailLines('voice.log', 100).map(line => ({ at: line.slice(0, 24), text: line.slice(25) }));
const readTurns = () => tailLines('transcript.jsonl', 30).flatMap(line => {
  try { const t = JSON.parse(line); return [{ at: t.at, user: t.user, spoken: t.spoken, ms: t.ms }]; } catch { return []; }
});

// Assemble the full payload served at /api/activity, exactly as monitor.html expects it.
async function snapshot() {
  const { online, live } = await fetchLiveState();
  return {
    online, events: readEvents(), turns: readTurns(), session: sessionSnapshot(),
    nowPlaying: live?.nowPlaying || null, sentences: live?.sentences || [], volume: live?.volume || null,
    at: new Date().toISOString(),
  };
}

http.createServer(async (req, res) => {
  if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) { res.writeHead(403); return res.end(); }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
  if (req.url === '/api/volume' && req.method === 'POST') {
    // JSON only, from this page only: a form on another site can't send application/json
    // without a preflight this server never answers, and a browser always sends its Origin.
    const origin = req.headers.origin;
    if (!(req.headers['content-type'] || '').startsWith('application/json') || (origin && origin !== `http://${req.headers.host}`)) { res.writeHead(403); return res.end(); }
    const { status, body } = await postVolume((await readBody(req, 4096)).toString('utf8'));
    res.writeHead(status, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(body));
  }
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(fs.readFileSync(path.join(here, 'monitor.html'))); }
  if (req.url === '/api/activity') {
    try { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(await snapshot())); }
    catch { res.writeHead(500); res.end('{}'); }
    return;
  }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1', () => console.log(`Voice observatory: http://127.0.0.1:${port}`));
