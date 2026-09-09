import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const label = process.env.VOICE_LABEL || 'voice';
const state = process.env.VOICE_STATE || path.join(os.homedir(), '.local/share/jarvis-voice/state', label);
const port = Number(process.env.MONITOR_PORT || 4456);
// The voice server the dashboard reads from. Upstream hardcoded :4455 here,
// so a server on any other port was invisible to the monitor.
const voiceOrigin = `http://${process.env.VOICE_HOST || '127.0.0.1'}:${Number(process.env.VOICE_PORT || 4455)}`;
function tail(name, count, directory = state) {
  let fd;
  try {
    fd = fs.openSync(path.join(directory, name), 'r');
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - 256 * 1024);
    const bytes = Buffer.alloc(size - start);
    fs.readSync(fd, bytes, 0, bytes.length, start);
    const lines = bytes.toString('utf8').split('\n');
    if (start) lines.shift();
    return lines.filter(Boolean).slice(-count);
  } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
// Read only visible conversation and tool blocks from the voice session.
function sessionSnapshot() {
  let session;
  try { session = JSON.parse(fs.readFileSync(path.join(state, 'claude-session.json'), 'utf8')); } catch { return { id: null, entries: [] }; }
  if (!/^[a-f0-9-]{36}$/i.test(session.id || '')) return { id: null, entries: [] };
  const root = process.env.VOICE_ROOT || os.homedir();
  const project = root.replace(/[^a-zA-Z0-9]/g, '-');
  const directory = path.join(os.homedir(), '.claude', 'projects', project);
  const entries = [];
  let model = null;
  for (const line of tail(session.id + '.jsonl', 300, directory)) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.isSidechain || !['user', 'assistant'].includes(row.type)) continue;
    if (row.message?.model) model = row.message.model;
    const blocks = row.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const base = { id: (row.uuid || row.timestamp) + ':' + i, at: row.timestamp };
      if (b.type === 'text' && b.text) entries.push({ ...base, type: row.type, text: b.text.slice(0, 16000) });
      if (b.type === 'tool_use') entries.push({ ...base, type: 'tool', toolId: b.id, name: b.name, text: JSON.stringify(b.input || {}, null, 2).slice(0, 16000) });
      if (b.type === 'tool_result') {
        const content = typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content.filter(x => x.type === 'text').map(x => x.text).join('\n') : '');
        entries.push({ ...base, type: 'result', toolId: b.tool_use_id, error: !!b.is_error, text: content.slice(0, 16000) || '(No text output)' });
      }
    }
  }
  return { id: session.id, model, entries: entries.slice(-80) };
}
let cookie = null;
async function login() {
  try {
    const key = fs.readFileSync(path.join(state, 'voice-token'), 'utf8').trim();
    const r = await fetch(`${voiceOrigin}/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }), signal: AbortSignal.timeout(1500),
    });
    const set = r.headers.get('set-cookie');
    await r.body?.cancel();
    if (set) { cookie = set.split(';')[0]; return true; }
  } catch {}
  return false;
}

async function snapshot() {
  let online = false, live = null;
  // /api/state also carries what the machine is speaking right now (nowPlaying + the turn's
  // sentences). The dashboard has no live channel, so this poll is how it follows along.
  // That route sits behind the passphrase gate, so log in once with the token from the state
  // dir and keep the cookie. Reading the token is fine: this server is bound to localhost.
  try {
    const r = await fetch(`${voiceOrigin}/api/state`, {
      headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(1500),
    });
    online = r.status === 401 || r.ok;
    if (r.ok) { try { live = await r.json(); } catch {} }
    else { await r.body?.cancel(); if (r.status === 401) await login(); }
  } catch {}
  const events = tail('voice.log', 100).map(line => ({ at: line.slice(0, 24), text: line.slice(25) }));
  const turns = tail('transcript.jsonl', 30).flatMap(line => { try { const t = JSON.parse(line); return [{at:t.at,user:t.user,spoken:t.spoken,ms:t.ms}]; } catch { return []; } });
  return { online, events, turns, session: sessionSnapshot(), nowPlaying: live?.nowPlaying || null, sentences: live?.sentences || [], at: new Date().toISOString() };
}
http.createServer(async (req, res) => {
  if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) { res.writeHead(403); return res.end(); }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  if (req.url === '/') { res.setHeader('Content-Type','text/html; charset=utf-8'); return res.end(fs.readFileSync(path.join(here,'monitor.html'))); }
  if (req.url === '/api/activity') {
    try { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(await snapshot())); }
    catch { res.writeHead(500); res.end('{}'); }
    return;
  }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1', () => console.log(`Voice observatory: http://127.0.0.1:${port}`));
