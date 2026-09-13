#!/usr/bin/env node
// Voice chat with the agent in this folder: text in (dictated on the phone), `claude -p` in CONTEXT
// with a persistent session and the voice-mode prompt, edge-tts out. Binds to localhost only;
// Tailscale Serve puts HTTPS in front of it (see README.md next to this file).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readBody } from './request-body.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.VOICE_ROOT || os.homedir();
const LABEL = process.env.VOICE_LABEL || 'voice';
const STATE = process.env.VOICE_STATE || path.join(os.homedir(), '.local', 'share', 'home-control', 'state', LABEL);
const AUDIO_DIR = path.join(STATE, 'audio');
const TOKEN_FILE = process.env.VOICE_TOKEN || path.join(STATE, 'voice-token');
const SESSIONS_FILE = path.join(STATE, 'logins.json');
const CLAUDE_SESSION_FILE = path.join(STATE, 'claude-session.json');
const TRANSCRIPT = path.join(STATE, 'transcript.jsonl');
const LOG = path.join(STATE, 'voice.log');
const EDGE_TTS = process.env.VOICE_EDGE_TTS || path.join(os.homedir(), '.local', 'share', 'home-control', 'venv', 'bin', 'edge-tts');
const PORT = Number(process.env.VOICE_PORT || 4455);
const HOST = process.env.VOICE_HOST || '127.0.0.1';

const VOICES = { en: process.env.VOICE_VOICE_EN || 'en-US-AndrewMultilingualNeural', he: process.env.VOICE_VOICE_HE || 'he-IL-AvriNeural' };
const OWNER = process.env.VOICE_OWNER || 'the user';
// Names the pages carry, filled in when they are served so the tracked files stay untouched.
const AGENT_NAME = process.env.VOICE_AGENT_NAME || 'Home Control';
const PWA_NAME = process.env.VOICE_PWA_NAME || 'Home';
const TTS_PYTHON = process.env.HOME_CONTROL_TTS_PYTHON || 'python3';
const MODEL = process.env.VOICE_MODEL || '';
const EFFORT = process.env.VOICE_EFFORT || '';
const REWRITE_MODEL = process.env.VOICE_REWRITE_MODEL || 'claude-haiku-4-5-20251001';
// Off means: a page-shaped reply is still de-markdowned (stripMarkdown), just not sent to
// Haiku to be reworded for the ear first. That second call is real extra cost, not free
// polish - asked about at install time, see VOICE_SPEECH_REWRITE in config.env.
const SPEECH_REWRITE_ON = process.env.VOICE_SPEECH_REWRITE !== 'off';
// By design: the voice agent is not limited on the machine — the same tools a session has, minus the secrets (denied below).
const ALLOWED_TOOLS = [
  'Read', 'Grep', 'Glob', 'Edit', 'Write', 'WebFetch', 'WebSearch',
  'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(date:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(find:*)', 'Bash(grep:*)',
  'Bash(sqlite3:*)', 'Bash(python3:*)', 'Bash(node:*)', 'Bash(ffmpeg:*)', 'Bash(ffprobe:*)', 'Bash(curl:*)', 'Bash(mkdir:*)', 'Bash(cp:*)', 'Bash(mv:*)',
];
// Handing work to another live Claude Code session on this machine. Opt-in, and
// off unless install.sh was explicitly told otherwise, because it widens who can
// act on a spoken request. The rule that goes with it is in voice-mode.md:
// lacking a tool is a reason to delegate; having been refused is not.
if ((process.env.VOICE_PEER_DELEGATION || '').toLowerCase() === 'on') {
  ALLOWED_TOOLS.push('ListAgents', 'SendMessage');
}
const PERMISSION_SETTINGS = JSON.stringify({
  permissions: {
    deny: [
      'Read(./**/secrets/**)', 'Read(./**/credentials*)', 'Read(./**/.env*)',
      'Edit(./**/secrets/**)', 'Edit(./**/credentials*)', 'Edit(./**/.env*)',
      'Write(./**/secrets/**)', 'Write(./**/credentials*)', 'Write(./**/.env*)',
    ],
  },
});

fs.mkdirSync(AUDIO_DIR, { recursive: true });

// what stays awake between conversations, and for how long (the agent itself always stays up; see spawnClaude)
const IDLE = { ttsWarmMs: 5 * 60 * 1000, whisperMs: 2 * 60 * 60 * 1000 };
let lastTurnAt = 0;

// ---------- small helpers ----------
const log = (line) => {
  const s = `${new Date().toISOString()} ${line}\n`;
  fs.appendFileSync(LOG, s);
  process.stdout.write(s);
};
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const clientIp = (req) => req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
// request-body.mjs owns bounded request reads.
const parseCookies = (req) => Object.fromEntries(
  (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]),
);
const readJsonBody = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
const readJsonRequest = async (req) => readJsonBody((await readBody(req)).toString('utf8'));
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const html = (res, file, code = 200) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(fs.readFileSync(path.join(HERE, file), 'utf8').replaceAll('__PWA_NAME__', PWA_NAME).replaceAll('__AGENT__', AGENT_NAME.toUpperCase())); };

// ---------- the gate: one passphrase, a cookie once it is typed ----------
const WORDS_FILES = ['/usr/share/dict/words', '/usr/share/dict/american-english', '/usr/share/dict/cracklib-small', '/usr/share/words'];
// macOS ships /usr/share/dict/words; most Linux boxes do not. Fall back to a built-in list
// so the gate works everywhere (5 words from >=200 -> ~38 bits, plus the 5-try lockout).
const FALLBACK_WORDS = ('able acid aged also area army away baby back ball band bank base bath bear beat been beer bell belt bend bent best bike bird bite blue boat body bone book boot born both bowl cage cake call calm came camp card care cart case cash cast cell chat chip city clay clip club coal coat code cold come cook cool cope copy cord core corn cost crew crop dark data date dawn days dead deal dear debt deck deep deer desk dial diet disc dish dock does dome done door dose down draw drew drop drum dual duck dust duty each earn ease east easy edge exit face fact fade fail fair fall farm fast fate fear feed feel feet fell felt file fill film find fine fire firm fish five flag flat flew flow foam fold folk food foot fork form fort four free from fuel full fund gain game gate gave gear gene gift girl give glad goal goat gold golf gone good gray grew grid grim grow gulf hair half hall hand hang hard harm hats have hawk head heal heap hear heat held hell helm help herb herd here hero hide high hill hint hire hold hole holy home hope horn host hour huge hunt hurt idea inch iron item jazz join joke jump jury just keen keep kept kick kind king kiss knee knew knot know lace lack lady laid lake lamb lamp land lane last late lawn lead leaf lean leap left lend lens less lift like limb lime line link lion list live load loan lock loft logo lone long look loop lord lose loss lost loud love luck lump lung made mail main make male mall many mark mask mass mast mate math meal mean meat meet melt menu mere mesh mild mile milk mill mind mine mint miss mist mode mood moon more moss most move much must nail name near neat neck need nest news next nice node none noon norm nose note noun oak oath obey odds okay omit once only onto open oral oven over pace pack page paid pain pair pale palm park part pass past path peak pear peer pile pine pink pipe pity plan play plot plug plus poem poet pole poll pond pool poor port pose post pour pray prep prey pull pump pure push quit quiz race rack rage raid rail rain rank rare rate read real reef rely rent rest rice rich ride ring riot rise risk road roar rock role roll roof room root rope rose ruby rule rush safe sage said sail salt same sand save scan seal seat seed seek seem seen self sell send sent ship shoe shop shot show side sign silk sing sink site size skin skip sky slab slam sled slid slim slip slot slow snap snow soap soft soil sold sole solo some song soon sort soul soup sour spin spot star stay stem step stir stop such suit sung sure surf swam swap swim tail take tale talk tall tank tape task team tear tech tell tend tent term test text than that them then they thin this thus tide tidy tile till time tiny tire toll tone took tool tour town trap tray tree trim trip true tube tune turn twin type unit upon urge used user vast vent very vessel view vine visa void volt vote wage wait wake walk wall want ward warm warn wash wave weak wear week well went were west what when whom wide wife wild will wind wine wing wipe wire wise wish with wolf wood wool word wore work worm worn wrap yard yarn yeah year your zero zone').split(' ');
const makePassphrase = () => {
  let words = null;
  for (const f of WORDS_FILES) {
    try { const w = fs.readFileSync(f, 'utf8').split('\n').filter((x) => /^[a-z]{4,7}$/.test(x)); if (w.length > 500) { words = w; break; } } catch {}
  }
  if (!words) words = FALLBACK_WORDS;
  return Array.from({ length: 5 }, () => words[crypto.randomInt(words.length)]).join('-');
};
const passphrase = () => {
  if (!fs.existsSync(TOKEN_FILE)) {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, makePassphrase() + '\n', { mode: 0o600 });
    log('gate: new passphrase written');
  }
  return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
};
const logins = readJson(SESSIONS_FILE, {});
const failures = { count: 0, until: 0 };
const LOCKOUT_MS = 15 * 60 * 1000;
const isLoggedIn = (req) => {
  const c = parseCookies(req).voice;
  return Boolean(c && logins[c]);
};
const tryLogin = (key, res, req) => {
  if (Date.now() < failures.until) return false;
  const given = Buffer.from(String(key || '').trim());
  const want = Buffer.from(passphrase());
  const ok = given.length === want.length && crypto.timingSafeEqual(given, want);
  if (!ok) {
    failures.count += 1;
    if (failures.count >= 5) { failures.until = Date.now() + LOCKOUT_MS; failures.count = 0; log(`gate: locked for 15 min after 5 failures (${clientIp(req)})`); }
    else log(`gate: wrong passphrase (${clientIp(req)})`);
    return false;
  }
  failures.count = 0;
  const id = crypto.randomBytes(24).toString('hex');
  logins[id] = { at: new Date().toISOString(), ip: clientIp(req), ua: req.headers['user-agent'] || '' };
  writeJson(SESSIONS_FILE, logins);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `voice=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${180 * 24 * 3600}${secure}`);
  log(`gate: login ok (${clientIp(req)})`);
  return true;
};

// ---------- the event log: every output event, from a live turn or a delayed relay reply,
// in one ordered, bounded list. This is the reliability backbone behind /api/events — a phone
// that was backgrounded (or asleep) polls it and catches up on anything the per-turn SSE
// stream never reached it, including a relay reply that lands after its own turn already
// closed. Kept small so a long-running process never grows it without bound: capped by count
// and by age, whichever trims first.
const EVENT_LOG_MAX = 500;
const EVENT_LOG_MS = 30 * 60 * 1000;
// Generated once per process start. A client persists {cursor, bootId}; if this doesn't match
// what it has stored, the server restarted (and its in-memory eventLog is gone/rebuilt) — the
// client must reset its cursor to 0 rather than polling forever with a cursor that can never
// match again (a stale cursor higher than anything in a fresh log returns nothing, silently,
// forever).
const BOOT_ID = crypto.randomBytes(8).toString('hex');
let eventLog = [];
let eventSeq = 0;
// `at` is the human-readable stamp (for reading the log by eye); `ts` is the same instant as a
// number, so the age trim below never has to re-parse a date string.
const logEvent = (turnId, ev) => {
  eventSeq += 1;
  const now = Date.now();
  const entry = { id: eventSeq, at: new Date(now).toISOString(), ts: now, turnId, ...ev };
  eventLog.push(entry);
  const cutoff = now - EVENT_LOG_MS;
  while (eventLog.length > EVENT_LOG_MAX || (eventLog.length && eventLog[0].ts < cutoff)) eventLog.shift();
  return entry;
};

// ---------- claude ----------
const claudeSession = () => readJson(CLAUDE_SESSION_FILE, { id: null, turns: 0 });
const saveClaudeSession = (s) => writeJson(CLAUDE_SESSION_FILE, s);

const childEnv = () => { const e = { ...process.env }; delete e.CLAUDECODE; delete e.CLAUDE_CODE_ENTRYPOINT; return e; };

// One long-lived `claude` process: turns go in as stream-json user messages on stdin, so a turn
// skips process start-up and session loading. It runs all the time, from server start, not only
// while someone is talking: other Claude Code sessions on this machine reach the agent by messaging
// that process, and with no process there is nobody to message. If it exits it is started again
// (resuming the session) after a wait that doubles while it keeps dying, so a broken login or CLI
// can't spin.
let claudeProc = null;
let turnHandler = null;
let turnProc = null;   // the process the phone turn in flight was written to
const TURN_TIMEOUT_MS = 15 * 60 * 1000;
const RESPAWN = { minMs: 2000, maxMs: 5 * 60 * 1000, stableMs: 60 * 1000 };
let respawnDelay = RESPAWN.minMs;
let respawnTimer = null;
const claudeArgs = (session, newId) => {
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--append-system-prompt-file', path.join(HERE, 'voice-mode.md'),
    '--permission-mode', 'acceptEdits',
    '--allowedTools', ...ALLOWED_TOOLS,
    '--settings', PERMISSION_SETTINGS,
  ];
  if (MODEL) args.push('--model', MODEL);
  if (EFFORT) args.push('--effort', EFFORT);
  if (session.id) args.push('--resume', session.id);
  else args.push('--session-id', newId);
  return args;
};
const spawnClaude = () => {
  const session = claudeSession();
  const child = spawn('claude', claudeArgs(session, crypto.randomUUID()), { cwd: ROOT, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  const startedAt = Date.now();
  let costSeen = 0;   // the CLI reports cost as a running total for its own process
  let buf = '';
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      // Every reply counts toward the session's cost, whoever asked for it. A process already
      // stopped (a reset) may still finish a reply; that one belongs to the old conversation.
      if (ev.type === 'result' && child === claudeProc) {
        const s = claudeSession();
        const cost = Number(ev.total_cost_usd) || 0;
        // A brand-new session is only saved once it has a reply; an agent that was never spoken
        // to has nothing on disk to resume.
        saveClaudeSession({ ...s, id: s.id || ev.session_id || null, costUsd: (s.costUsd || 0) + Math.max(0, cost - costSeen) });
        costSeen = cost;
      }
      if (turnHandler && child === turnProc) { turnHandler(ev); continue; }
      // No turn is waiting (another session woke the agent): speak its reply anyway instead of
      // dropping it (never silently lost — the room hears it even if nobody's phone is around),
      // and log the same rendered events under a relay turn id so a polling phone picks them up.
      if (ev.type === 'result' && !ev.is_error && ev.result) {
        lastTurnAt = Date.now();
        const relayTurnId = `relay-${crypto.randomBytes(6).toString('hex')}`;
        (async () => {
          const spoken = stripMarkdown(ev.result);
          const groups = sentenceGroups(spoken);
          const renders = groups.map((g) => speak(g).catch(() => null));
          for (let i = 0; i < renders.length; i++) {
            const a = await renders[i];
            if (a) { playLocally(a.file, i, groups[i]); logEvent(relayTurnId, { type: 'audio', url: a.url, index: i, text: groups[i] }); }
          }
          logEvent(relayTurnId, { type: 'text', text: spoken, full: ev.result, from: relaySender(ev.session_id || claudeSession().id) });
        })();
      }
    }
  });
  child.on('exit', (code) => {
    log(`claude process exited ${code}${stderr ? ': ' + stderr.trim().split('\n').pop().slice(0, 160) : ''}`);
    if (turnProc === child) turnHandler?.({ type: 'process_exit', code, stderr });
    if (claudeProc !== child) return;   // stopped on purpose: stopClaude starts the next one
    claudeProc = null;
    if (Date.now() - startedAt > RESPAWN.stableMs) respawnDelay = RESPAWN.minMs;
    log(`agent process restarting in ${Math.round(respawnDelay / 1000)}s`);
    clearTimeout(respawnTimer);
    respawnTimer = setTimeout(ensureClaude, respawnDelay);
    respawnDelay = Math.min(respawnDelay * 2, RESPAWN.maxMs);
  });
  log(`agent process started (${session.id ? 'resuming ' + session.id : 'new session'})`);
  return child;
};
const ensureClaude = () => { clearTimeout(respawnTimer); respawnTimer = null; if (!claudeProc) claudeProc = spawnClaude(); };
// Ends the running process (a reset, or a turn that hung) and starts a fresh one once it is gone,
// so the agent is reachable again straight away and two processes never share the session.
const stopClaude = () => {
  const p = claudeProc;
  claudeProc = null;
  if (!p) return ensureClaude();
  const kill = setTimeout(() => { try { p.kill(); } catch {} }, 2000);
  p.once('exit', () => { clearTimeout(kill); ensureClaude(); });
  try { p.stdin.end(); } catch {}
};
process.on('exit', () => claudeProc?.kill());

// Runs one turn; calls onEvent for status while it runs; resolves {text, sessionId, cost}.
const runTurn = (text, onEvent) => new Promise((resolve, reject) => {
  if (!claudeProc) { onEvent({ type: 'status', text: claudeSession().id ? 'waking the agent, resuming our conversation' : 'waking the agent, first read of the folder', startup: true }); ensureClaude(); }
  turnProc = claudeProc;
  const session = claudeSession();
  let sessionId = session.id;
  let lastText = '';
  const timer = setTimeout(() => { turnHandler = null; turnProc = null; stopClaude(); reject(new Error('the agent took too long; the process was restarted')); }, TURN_TIMEOUT_MS);
  const finish = (fn) => { clearTimeout(timer); turnHandler = null; turnProc = null; fn(); };
  turnHandler = (ev) => {
    if (ev.type === 'process_exit') return finish(() => reject(new Error(ev.stderr?.trim().split('\n').pop()?.slice(0, 160) || `claude exited ${ev.code}`)));
    if (ev.session_id) sessionId = ev.session_id;
    if (ev.type === 'stream_event' && !ev.parent_tool_use_id && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta' && ev.event.delta.text) {
      onEvent({ type: 'delta', text: ev.event.delta.text });
    }
    if (ev.type === 'assistant') {
      for (const block of ev.message?.content || []) {
        if (block.type === 'tool_use') onEvent({ type: 'status', text: describeTool(block) });
        if (block.type === 'text' && block.text) { lastText = block.text; onEvent({ type: 'partial', text: block.text }); }
      }
    }
    if (ev.type === 'result') {
      if (ev.is_error) return finish(() => reject(new Error(ev.result || 'the agent returned an error')));
      saveClaudeSession({ ...claudeSession(), id: sessionId, turns: (session.id === sessionId ? session.turns : 0) + 1, at: new Date().toISOString() });
      finish(() => resolve({ text: ev.result || lastText || '', sessionId, cost: ev.total_cost_usd }));
    }
  };
  claudeProc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
});

const describeTool = (block) => {
  const i = block.input || {};
  const rel = (p) => (p ? path.relative(ROOT, p) : '');
  switch (block.name) {
    case 'Read': return `reading ${rel(i.file_path)}`;
    case 'Edit': case 'Write': return `writing ${rel(i.file_path)}`;
    case 'Grep': return `searching for "${i.pattern}"`;
    case 'Glob': return `listing ${i.pattern}`;
    case 'Bash': return `running ${String(i.command || '').slice(0, 40)}`;
    default: return `using ${block.name}`;
  }
};

// The voice-fit pass: anything that still looks like a page gets rewritten for the ear.
const looksLikePage = (t) => t.length > 900 || /(^|\n)\s*([-*•]|\d+\.)\s/.test(t) || /(^|\n)#{1,6}\s/.test(t) || /```|\|.*\|/.test(t) || /https?:\/\//.test(t);
const rewriteForSpeech = (text, lang) => new Promise((resolve) => {
  const instructions = `You turn a written reply into something said aloud. The text is an agent speaking to ${OWNER}: keep "I" for the agent and "you" for ${OWNER} exactly as written, keep the meaning, and keep the language of the original (${lang === 'he' ? 'Hebrew' : 'the same language as the text'}). Output plain spoken sentences only: no markdown, no lists, no headings, no code, no URLs, no file paths. At most 120 words. If the original offers detail, end with one short question about which part to hear. Output only the spoken text.`;
  const child = spawn('claude', ['-p', text, '--output-format', 'json', '--model', REWRITE_MODEL, '--allowedTools', '', '--system-prompt', instructions],
    { cwd: STATE, env: childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.on('close', () => {
    try { const r = JSON.parse(out); resolve(r.is_error ? text : (r.result || text)); } catch { resolve(text); }
  });
  child.on('error', () => resolve(text));
});

const stripMarkdown = (t) => t
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/`([^`]*)`/g, '$1')
  .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1')
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/^\s*[-*•]\s+/gm, '')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/[ \t]+\n/g, '\n').trim();

// ---------- transcription: whisper.cpp's own server, spawned here, model loaded once ----------
const WHISPER_PORT = Number(process.env.WHISPER_PORT || 4456);
const WHISPER_URL = (process.env.WHISPER_URL || '').replace(/\/$/, '');
const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(os.homedir(), '.local', 'share', 'home-control', 'models', 'ggml-large-v3-turbo.bin');
let whisper = null;
const WHISPER_BASE = () => WHISPER_URL || `http://${HOST}:${WHISPER_PORT}`;
const startWhisper = () => {
  if (WHISPER_URL) return;            // transcription lives on another machine
  if (whisper) return;
  if (!fs.existsSync(WHISPER_MODEL)) { log(`whisper: model missing at ${WHISPER_MODEL} — voice input off, text only`); return; }
  whisper = spawn('whisper-server', ['-m', WHISPER_MODEL, '--host', HOST, '--port', String(WHISPER_PORT), '-l', 'auto', '-nt', '-t', '8'], { stdio: ['ignore', 'ignore', 'pipe'] });
  whisper.stderr.on('data', (d) => { const line = String(d).trim(); if (/error|failed/i.test(line)) log(`whisper: ${line.slice(0, 200)}`); });
  whisper.on('exit', (code) => { log(`whisper exited ${code}`); whisper = null; });
  log(`whisper starting on ${HOST}:${WHISPER_PORT}`);
  const silence = Buffer.alloc(44 + 32000);
  silence.write('RIFF', 0); silence.writeUInt32LE(36 + 32000, 4); silence.write('WAVE', 8); silence.write('fmt ', 12); silence.writeUInt32LE(16, 16); silence.writeUInt16LE(1, 20); silence.writeUInt16LE(1, 22);
  silence.writeUInt32LE(16000, 24); silence.writeUInt32LE(32000, 28); silence.writeUInt16LE(2, 32); silence.writeUInt16LE(16, 34); silence.write('data', 36); silence.writeUInt32LE(32000, 40);
  const warm = async (tries) => { try { await transcribe(silence); log('whisper warm'); } catch { if (tries > 0) setTimeout(() => warm(tries - 1), 2000); } };
  setTimeout(() => warm(10), 3000);
};
process.on('exit', () => whisper?.kill());
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { whisper?.kill(); process.exit(0); });

// Phrases whisper produces for silence and breath; an utterance that is only one of these is dropped.
// Whisper's known silence artifacts; a real short answer ("yes", "okay", "תודה") is never dropped.
const HALLUCINATIONS = /^(you\.?|subtitles by .*|תרגום .*|כתוביות .*|\[.*\]|\(.*\)|\.+)$/i;
const whisperReady = async (onStage) => {
  if (!WHISPER_URL && !whisper) { startWhisper(); onStage?.('loading the ear (Whisper)'); }
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${WHISPER_BASE()}/`, { method: 'GET' }); if (r.ok || r.status === 404 || r.status === 405) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('whisper did not come up');
};
const transcribe = async (wav, onStage) => {
  await whisperReady(onStage);
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  const res = await fetch(`${WHISPER_BASE()}/inference`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`whisper ${res.status}`);
  const text = String((await res.json()).text || '').replace(/\s+/g, ' ').trim();
  return HALLUCINATIONS.test(text) ? '' : text;
};

// ---------- tts ----------
const hebrewShare = (t) => {
  const letters = t.replace(/[^\p{L}]/gu, '');
  if (!letters) return 0;
  return (letters.match(/[\u0590-\u05FF]/g) || []).length / letters.length;
};
const detectLang = (t) => (hebrewShare(t) > 0.4 ? 'he' : 'en');
const TTS_PORT = Number(process.env.TTS_PORT || 4457);
let ttsWorker = null;
const startTts = () => {
  ttsWorker = spawn(TTS_PYTHON, [path.join(HERE, 'tts.py')], { env: { ...process.env, TTS_PORT: String(TTS_PORT) }, stdio: ['ignore', 'ignore', 'pipe'] });
  ttsWorker.stderr.on('data', (d) => log(`tts: ${String(d).trim().slice(0, 200)}`));
  ttsWorker.on('exit', (code) => { log(`tts worker exited ${code}`); ttsWorker = null; });
};
process.on('exit', () => ttsWorker?.kill());
const warmTts = (lang) => { if (!ttsWorker) return; fetch(`http://${HOST}:${TTS_PORT}/speak`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: lang === 'he' ? 'כן' : 'Yes', voice: VOICES[lang] }) }).catch(() => {}); };
setInterval(() => { if (Date.now() - lastTurnAt < IDLE.ttsWarmMs) { warmTts('en'); warmTts('he'); } }, 45000);
setInterval(() => {
  if (busy || !lastTurnAt) return;
  const idle = Date.now() - lastTurnAt;
  if (whisper && idle > IDLE.whisperMs) { log(`idle ${Math.round(idle / 60000)} min: whisper unloaded (reloads on the next turn)`); whisper.kill(); }
}, 60000);
// Plays each turn's audio on this machine's own output, in addition to sending it to the
// phone. Chained on localQueue so sentence N+1 never starts until N's player process has
// exited — same rule the phone's playNext() already follows client-side; without it, two
// sentences rendered close together spawn overlapping players and blob together.
// Fire-and-forget from the caller's perspective: playback failure never breaks the phone side.
const LOCAL_PLAYER = process.env.VOICE_LOCAL_PLAYER || 'mpv';
// Speaking speed. The phone can only speed up its own <audio>; this is the same setting applied
// to the machine's own output — the one the TV plays — so a tap on the phone changes what the
// room hears too. On disk, so a restart doesn't quietly drop back to 1x.
const RATE_FILE = path.join(STATE, 'speech-rate.json');
const SPEECH_RATES = [0.75, 1, 1.25, 1.5, 1.75];
let speechRate = (() => { const r = Number(readJson(RATE_FILE, {}).rate); return SPEECH_RATES.includes(r) ? r : 1; })();
const setSpeechRate = (r) => {
  r = Number(r);
  if (!SPEECH_RATES.includes(r)) return false;
  speechRate = r;
  try { writeJson(RATE_FILE, { rate: r }); } catch (e) { log(`speech rate not saved: ${e.message}`); }
  log(`speech rate -> ${r}x`);
  return true;
};
// Away mode: when true, replies are still sent to the phone as normal, but this machine's own
// speakers stay silent — no TTS on the machine or the TV it drives. Set directly by the agent
// (it has filesystem access) when Liran says he's leaving/back — no route needed for a single
// bool nothing else ever sets. Checked at play time (once per sentence), so a plain file write
// takes effect immediately without a server restart or an HTTP round trip to itself — but the
// value is cached against the file's mtime, so the common case is one stat() rather than a read
// plus a JSON.parse on every sentence. A missing file means not away.
const AWAY_FILE = path.join(STATE, 'away.json');
let awayCache = false, awayMtime = null;
const isAway = () => {
  let mtime = null;
  try { mtime = fs.statSync(AWAY_FILE).mtimeMs; } catch {}
  if (mtime === awayMtime) return awayCache;
  awayMtime = mtime;
  awayCache = mtime === null ? false : !!readJson(AWAY_FILE, {}).away;
  return awayCache;
};
let localQueue = Promise.resolve();
let localTurn = 0;
let localChild = null;
// What the machine is saying out loud right now, and the whole turn's sentences.
// The dashboard has no live channel of its own — it polls this through /api/state,
// which is what lets it highlight the sentence being spoken and scroll to it.
let nowPlaying = null;          // { index, text } while a sentence is playing
let turnSentences = [];         // every sentence of the current turn, in order
const resetSpokenState = () => { nowPlaying = null; turnSentences = []; };
const playLocally = (file, index = null, text = '') => {
  const myTurn = localTurn;
  if (text && index !== null) turnSentences[index] = text;
  localQueue = localQueue.then(() => new Promise((resolve) => {
    if (myTurn !== localTurn) return resolve(); // skipped before its turn came up
    if (isAway()) return resolve(); // away mode: phone still gets it, this machine stays silent
    if (index !== null) nowPlaying = { index, text };
    const clear = () => { if (nowPlaying && nowPlaying.index === index) nowPlaying = null; };
    const tryFfplay = (origErr) => {
      const fp = spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', ...(speechRate === 1 ? [] : ['-af', `atempo=${speechRate}`]), file], { stdio: 'ignore' });
      localChild = fp;
      fp.on('error', (e) => { log(`local playback failed: no mpv or ffplay (${origErr?.message || e.message})`); localChild = null; clear(); resolve(); });
      fp.on('exit', () => { localChild = null; clear(); resolve(); });
    };
    if (LOCAL_PLAYER === 'ffplay') { tryFfplay(); return; }
    const child = spawn(LOCAL_PLAYER, ['--no-terminal', '--really-quiet', `--speed=${speechRate}`, file], { stdio: 'ignore' });
    localChild = child;
    child.on('error', tryFfplay);
    child.on('exit', () => { localChild = null; clear(); resolve(); });
  }));
};
// Skip: bumps localTurn so anything already queued but not yet playing becomes a no-op, and
// kills whatever's playing right now. Mirrors the phone's own currentTurn/interrupt() pattern.
const skipLocal = () => { localTurn++; nowPlaying = null; if (localChild) { try { localChild.kill(); } catch {} } };
const speakViaCli = (text, voice, out) => new Promise((resolve, reject) => {
  const txt = out.replace(/\.mp3$/, '.txt');
  fs.writeFileSync(txt, text);
  const child = spawn(EDGE_TTS, ['--voice', voice, '--file', txt, '--write-media', out], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => { fs.rmSync(txt, { force: true }); code === 0 && fs.existsSync(out) ? resolve() : reject(new Error(`tts failed: ${err.trim().split('\n').pop() || code}`)); });
  child.on('error', reject);
});
const speak = async (text, lang = detectLang(text)) => {
  const id = crypto.randomBytes(8).toString('hex');
  const out = path.join(AUDIO_DIR, `${id}.mp3`);
  const voice = VOICES[lang];
  let done = false;
  if (ttsWorker) {
    try {
      const res = await fetch(`http://${HOST}:${TTS_PORT}/speak`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice }) });
      if (res.ok) { fs.writeFileSync(out, Buffer.from(await res.arrayBuffer())); done = true; }
      else log(`tts worker ${res.status}: ${(await res.text()).slice(0, 120)} — falling back to the cli`);
    } catch (e) { log(`tts worker unreachable (${e.message}) — falling back to the cli`); }
  }
  if (!done) await speakViaCli(text, voice, out);
  return { url: `/audio/${id}.mp3`, file: out, lang };
};
// One sentence's audio: tell the phone, and start it playing locally too.
const emitAudio = (send, audio, index, text) => { send({ type: 'audio', url: audio.url, index, text }); playLocally(audio.file, index, text); };
// Sentences are spoken as the model writes them: each complete sentence goes to TTS at once,
// renders in parallel with the next, and is sent to the phone in order.
const SENTENCE_END = /[.!?׃]["'”)]?(?=\s)|\n/g;
const makeSpeaker = (send, lang) => {
  let pending = '';
  const spoken = [];
  let chain = Promise.resolve();
  let count = 0;
  const say = (raw) => {
    const text = stripMarkdown(raw).replace(/\s+/g, ' ').trim();
    if (!text) return;
    const index = count++;
    spoken.push(text);
    const t0 = Date.now();
    const render = speak(text, hebrewShare(text) > 0.4 ? 'he' : lang).then((a) => { log(`tts ${index}: ${Date.now() - t0}ms for ${text.length} chars`); return a; }).catch((e) => { log(`tts failed on a sentence: ${e.message}`); return null; });
    chain = chain.then(async () => { const a = await render; if (a) emitAudio(send, a, index, text); });
  };
  return {
    // everything up to the last sentence end is spoken now; the tail waits for more words
    feed(delta) {
      pending += delta;
      let cut = -1;
      for (const m of pending.matchAll(SENTENCE_END)) cut = m.index + m[0].length;
      if (count === 0 && cut < 0) { const clause = pending.search(/[,;:—–](?=\s)/); if (clause >= 30) cut = clause + 1; }
      if (cut > 0 && pending.slice(0, cut).trim().length >= 12) { say(pending.slice(0, cut)); pending = pending.slice(cut); }
    },
    async finish() { if (pending.trim()) say(pending); pending = ''; await chain; return spoken.join(' '); },
    get count() { return count; },
  };
};
const sentenceGroups = (text) => {
  const sentences = text.replace(/\s+/g, ' ').match(/[^.!?׃]+[.!?׃]+["'”]?\s*|[^.!?׃]+$/g) || [text];
  const groups = [];
  let cur = '';
  for (const sn of sentences) { cur += sn; if (cur.length >= 90) { groups.push(cur.trim()); cur = ''; } }
  if (cur.trim()) groups.push(cur.trim());
  return groups;
};
const pruneAudio = () => {
  const files = fs.readdirSync(AUDIO_DIR).filter((f) => f.endsWith('.mp3')).map((f) => ({ f, t: fs.statSync(path.join(AUDIO_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(120)) fs.rmSync(path.join(AUDIO_DIR, f), { force: true });
};

// ---------- http ----------
let busy = false;
const sse = (res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  return (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
};

// Fallback for when the model streamed no speakable sentences: rewrite the result text for
// the ear if it looks like a page, then speak it in parallel-rendered, in-order chunks —
// same playback shape as makeSpeaker, just not streamed sentence-by-sentence.
const speakFallback = async (turnText, lang, send, onAudio) => {
  let spoken = stripMarkdown(turnText);
  if (SPEECH_REWRITE_ON && looksLikePage(turnText)) {
    send({ type: 'status', text: 'fitting for voice' });
    spoken = stripMarkdown(await rewriteForSpeech(turnText, lang));
  }
  if (!spoken) spoken = lang === 'he' ? 'סיימתי, אבל לא יצא לי טקסט להקריא.' : 'Done, but I have no text to read back.';
  const groups = sentenceGroups(spoken);
  const renders = groups.map((g) => speak(g, detectLang(spoken)));
  for (let i = 0; i < renders.length; i++) {
    const audio = await renders[i];
    onAudio();
    emitAudio(send, audio, i, groups[i]);
  }
  return spoken;
};

const handleTurn = async (req, res) => {
  if (busy) { log('turn refused: busy'); return json(res, 409, { error: 'busy' }); }
  busy = true;
  resetSpokenState();
  lastTurnAt = Date.now();
  const turnId = crypto.randomBytes(6).toString('hex');
  const sendRaw = sse(res);
  // Every event the phone gets live over this turn's SSE stream is also appended to the shared
  // event log, so a phone that reconnects later — or another device polling /api/events — can
  // catch up on the same turn.
  // The id is assigned by the log, then stamped onto the very event the phone receives live, so
  // the client can advance its catch-up cursor past it right away — otherwise the poller has no
  // way to know a live-streamed event was already shown, and re-renders every turn a second time.
  const send = (ev) => { const entry = logEvent(turnId, ev); sendRaw({ ...ev, id: entry.id }); };
  const started = Date.now();
  try {
    let text, lang;
    if ((req.headers['content-type'] || '').startsWith('audio/')) {
      const wav = await readBody(req, 20e6);
      send({ type: 'status', text: 'transcribing' });
      text = await transcribe(wav, (stage) => send({ type: 'status', text: stage, startup: true }));
      if (!text) { log(`ignored: nothing usable in ${wav.length} bytes of audio`); send({ type: 'ignored' }); return; }
      lang = detectLang(text);
      send({ type: 'transcript', text });
      log(`heard (${Date.now() - started}ms): ${text.slice(0, 80)}`);
    } else {
      const body = await readJsonRequest(req);
      text = String(body.text || '').trim();
      if (!text) { send({ type: 'error', text: 'empty' }); return; }
      lang = body.lang === 'he' ? 'he' : detectLang(text);
    }
    const first = !claudeSession().id;
    send({ type: 'status', text: first ? 'waking up' : 'thinking' });
    warmTts(lang);
    let firstAudioAt = 0;
    const markFirstAudio = () => { if (!firstAudioAt) firstAudioAt = Date.now(); };
    const speaker = makeSpeaker((ev) => { markFirstAudio(); send(ev); }, lang);
    const turn = await runTurn(text, (ev) => (ev.type === 'delta' ? speaker.feed(ev.text) : send(ev)));
    let spoken = await speaker.finish();
    if (!spoken) spoken = await speakFallback(turn.text, lang, send, markFirstAudio);
    send({ type: 'text', text: spoken, full: turn.text });
    fs.appendFileSync(TRANSCRIPT, JSON.stringify({ at: new Date().toISOString(), user: text, agent: turn.text, spoken, ms: Date.now() - started, cost: turn.cost }) + '\n');
    log(`turn ok ${Date.now() - started}ms first-audio=${firstAudioAt ? firstAudioAt - started : '-'}ms sentences=${speaker.count} cost=$${(turn.cost || 0).toFixed(3)} session=${turn.sessionId}`);
    send({ type: 'done' });
    pruneAudio();
  } catch (e) {
    log(`turn failed: ${e.message}`);
    send({ type: 'error', text: e.message });
  } finally {
    // The phone reopens its mic once this response ends (its own queue already drained by
    // then). If we ended it while the TV was still playing this turn's sentences, the mic
    // would come on mid-playback and hear itself. Waiting for localQueue here — the same
    // chain playLocally() feeds — closes that gap; skipLocal() (via /api/skip) still cuts
    // it short on demand.
    try { await localQueue; } catch {}
    busy = false;
    res.end();
  }
};

// Icons and the manifest are public: iOS asks for them when the app is added to the
// home screen, and the login page needs them too. Fixed allowlist — no path building.
const PUBLIC_FILES = {
  '/manifest.json': 'application/manifest+json',
  '/apple-touch-icon.png': 'image/png',
  '/icon-192.png': 'image/png',
  '/icon-512.png': 'image/png',
  '/favicon-32.png': 'image/png',
  '/favicon.ico': 'image/png',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (url.pathname === '/login' && req.method === 'POST') {
      const body = (await readBody(req)).toString('utf8');
      const key = req.headers['content-type']?.includes('json') ? readJsonBody(body).key : new URLSearchParams(body).get('key');
      if (tryLogin(key, res, req)) { res.writeHead(303, { Location: '/' }); return res.end(); }
      return html(res, 'login.html', 401);
    }
    if (url.pathname === '/logout') { res.setHeader('Set-Cookie', 'voice=; Path=/; Max-Age=0'); res.writeHead(303, { Location: '/' }); return res.end(); }
    if (url.searchParams.get('key') && !isLoggedIn(req)) {
      if (tryLogin(url.searchParams.get('key'), res, req)) { res.writeHead(303, { Location: '/' }); return res.end(); }
    }
    if (PUBLIC_FILES[url.pathname]) {
      const file = path.join(HERE, url.pathname === '/favicon.ico' ? 'favicon-32.png' : url.pathname.slice(1));
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': PUBLIC_FILES[url.pathname], 'Cache-Control': 'public, max-age=86400' });
      return fs.createReadStream(file).pipe(res);
    }
    if (!isLoggedIn(req)) {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/audio/')) return json(res, 401, { error: 'login' });
      return html(res, 'login.html', 401);
    }
    if (url.pathname === '/') return html(res, 'index.html');
    if (url.pathname === '/api/turn' && req.method === 'POST') return handleTurn(req, res);
    if (url.pathname === '/api/skip' && req.method === 'POST') { skipLocal(); return json(res, 200, { ok: true }); }
    if (url.pathname === '/api/client-log' && req.method === 'POST') { const b = await readJsonRequest(req); log('phone: ' + String(b?.msg ?? '').slice(0, 400)); return json(res, 200, { ok: true }); }
    if (url.pathname === '/api/rate' && req.method === 'POST') {
      const body = await readJsonRequest(req);
      const ok = setSpeechRate(body.rate);
      return json(res, ok ? 200 : 400, { ok, rate: speechRate });
    }
    if (url.pathname === '/api/reset' && req.method === 'POST') {
      const old = claudeSession();
      // Clear the session first: stopClaude starts the next process, and it must not resume this one.
      saveClaudeSession({ id: null, turns: 0, previous: old.id });
      stopClaude();
      // New conversation means new conversation: the drawer's file is cleared, and so is the
      // event log — otherwise old content stays reachable via /api/events (a catching-up phone
      // would render it into the fresh conversation) even after the reset button was pressed.
      try { fs.rmSync(TRANSCRIPT, { force: true }); } catch {}
      eventLog = [];
      log(`session reset (was ${old.id}, ${old.turns} turns)`);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/state') { const s = claudeSession(); return json(res, 200, { busy, session: s.id, turns: s.turns, at: s.at, voiceInput: !!WHISPER_URL || fs.existsSync(WHISPER_MODEL), nowPlaying, sentences: turnSentences, rate: speechRate, away: isAway() }); }
    if (url.pathname === '/api/session-stats') return json(res, 200, sessionStats());
    if (url.pathname === '/api/transcript') {
      const lines = fs.existsSync(TRANSCRIPT) ? fs.readFileSync(TRANSCRIPT, 'utf8').trim().split('\n').filter(Boolean).slice(-40) : [];
      return json(res, 200, lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
    }
    // The reliability backbone: a phone polls this while foregrounded and catches up on
    // anything it missed — most importantly a relay reply that landed after its own turn's
    // SSE connection had already closed. `after` is the highest event id already seen; with
    // none given (first load), the recent tail of the log is returned instead of nothing.
    if (url.pathname === '/api/events' && req.method === 'GET') {
      const after = Number(url.searchParams.get('after'));
      const list = Number.isFinite(after) && after > 0 ? eventLog.filter((e) => e.id > after) : eventLog.slice(-50);
      // No cursor in the response: the client tracks the highest id it has actually applied,
      // which is the only value that is safe for it to poll from next.
      return json(res, 200, { events: list, bootId: BOOT_ID });
    }
    if (url.pathname.startsWith('/audio/')) {
      const file = path.join(AUDIO_DIR, path.basename(url.pathname));
      if (!fs.existsSync(file)) return json(res, 404, { error: 'gone' });
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'private, max-age=3600' });
      return fs.createReadStream(file).pipe(res);
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    log(`http error ${req.method} ${url.pathname}: ${e.message}`);
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

// Which session asked for a relay reply. The session file records each message from another session,
// with its sender's name, before the reply to it, and turns run one at a time, so the last such
// message is this reply's. Empty when it can't be found; the page then just says "Relayed".
const relaySender = (sessionId) => {
  try {
    const lines = fs.readFileSync(path.join(CLAUDE_PROJECT_DIR, `${sessionId}.jsonl`), 'utf8').trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"peer"')) continue;
      const e = JSON.parse(lines[i]);
      if (e.type === 'user' && e.origin?.kind === 'peer') return e.origin.name || '';
    }
  } catch {}
  return '';
};

// The conversation panel's three numbers. Turns and tokens come from the session's own file, so
// they include turns another session started, not only the phone's. The CLI writes one line per
// content block of a response, each carrying that response's usage, so usage counts once per
// message id. Cost is the CLI's own figure, added up as replies arrive (see spawnClaude).
// Claude Code names a project's folder after its working directory, every other character a "-".
const CLAUDE_PROJECT_DIR = path.join(os.homedir(), '.claude', 'projects', ROOT.replace(/[^A-Za-z0-9]/g, '-'));
const sessionStats = () => {
  const session = claudeSession();
  const stats = { turns: 0, tokens: 0, costUsd: session.costUsd || 0 };
  if (!session.id) return stats;
  let lines;
  try { lines = fs.readFileSync(path.join(CLAUDE_PROJECT_DIR, `${session.id}.jsonl`), 'utf8').split('\n'); } catch { return stats; }
  const counted = new Set();
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    // A turn is a prompt: the phone's words or another session's message. Tool results and
    // injected meta text (a loaded skill) ride along inside a turn.
    if (ev.type === 'user' && !ev.isCompactSummary && (!ev.isMeta || ev.origin?.kind === 'peer')) {
      const c = ev.message?.content;
      if (typeof c === 'string' || (Array.isArray(c) && c.some((b) => b.type !== 'tool_result'))) stats.turns += 1;
    }
    const u = ev.type === 'assistant' && ev.message?.usage;
    if (!u || counted.has(ev.message.id)) continue;
    counted.add(ev.message.id);
    stats.tokens += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  }
  return stats;
};

server.listen(PORT, HOST, () => {
  passphrase();
  startWhisper();
  startTts();
  ensureClaude();
  log(`voice server on http://${HOST}:${PORT} root=${ROOT}`);
});
