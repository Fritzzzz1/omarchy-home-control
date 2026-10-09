#!/usr/bin/env node
// Voice chat with the agent in this folder: text in (dictated on the phone), `claude -p` in CONTEXT
// with a persistent session and the voice-mode prompt, edge-tts out. Binds to localhost only;
// the Home Server's gateway puts it at /home-control/ (see README.md next to this file).
// HTTP runs on the Home Server's shared layer (shared/js/home-app.mjs): routing, body reads, JSON
// errors, files, redirects, GET /health, SIGTERM.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createApp, json, sendFile, redirect } from '../../../shared/js/home-app.mjs';
import { runInputHook } from './input-hook.mjs';
import { createDashboard } from './monitor.mjs';
import { routeTurn, garbageCheck, routerMode, routerConfig, setRouterLog, wavDurationS, tvIsOn, liveSessions, logRouterTurn, warm as warmRouter, SPEAKERS_DRAIN_CAP_MS } from './router.mjs';

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
const MODEL = process.env.VOICE_MODEL || '';
const EFFORT = process.env.VOICE_EFFORT || '';
const REWRITE_MODEL = process.env.VOICE_REWRITE_MODEL || 'claude-haiku-4-5-20251001';
// Unset (a config.env written before this setting existed) keeps whisper's language detection.
const VOICE_LANG = (process.env.VOICE_LANG || '').trim().toLowerCase() || 'auto';
// Off means: a page-shaped reply is still de-markdowned (stripMarkdown), just not sent to
// Haiku to be reworded for the ear first. That second call is real extra cost, not free
// polish - asked about at install time. config.env must set VOICE_SPEECH_REWRITE=on|off
// (true/false also accepted). Unset defaults to on; anything else is ignored and stays on.
const parseOnOff = (raw, unset = true) => {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return unset;
  if (v === 'on' || v === 'true' || v === '1') return true;
  if (v === 'off' || v === 'false' || v === '0') return false;
  return unset;
};
const SPEECH_REWRITE_ON = parseOnOff(process.env.VOICE_SPEECH_REWRITE, true);
// The claude CLI's permission mode for the voice agent. acceptEdits (upstream default) applies
// edits without asking; auto lets Claude Code's own auto mode decide instead.
const PERMISSION_MODE = process.env.VOICE_PERMISSION_MODE || 'acceptEdits';
// The machine's own persona file (VOICE_PERSONA in config.env), appended to the voice prompt.
// Who the agent is and what it may do belong to the folder it runs in, not to this project, and
// a file it is told to go and read is a file it can skip - so it is spliced into the system
// prompt instead. Unset: the shipped voice prompt is the whole of it, exactly as before.
const PERSONA_FILE = (process.env.VOICE_PERSONA || '').trim();
// Whether an input-hook command is configured, so its log lines only appear when it's in use.
const INPUT_HOOK_CONFIGURED = Boolean((process.env.VOICE_ON_INPUT || '').trim());
// By design: the voice agent is not limited on the machine — the same tools a session has, minus the secrets (denied below).
const ALLOWED_TOOLS = [
  'Read', 'Grep', 'Glob', 'Edit', 'Write', 'WebFetch', 'WebSearch',
  'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(date:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(find:*)', 'Bash(grep:*)',
  'Bash(sqlite3:*)', 'Bash(python3:*)', 'Bash(node:*)', 'Bash(ffmpeg:*)', 'Bash(ffprobe:*)', 'Bash(curl:*)', 'Bash(mkdir:*)', 'Bash(cp:*)', 'Bash(mv:*)',
];
// Handing work to another live Claude Code session on this machine. Opt-in, and
// off unless install.sh was explicitly told otherwise, because it widens who can
// act on a spoken request.
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
const parseCookies = (req) => Object.fromEntries(
  (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]),
);
const readJsonBody = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
// Any Content-Type, and a body that is not JSON is {}: the phone and the scripts send what they send.
const readJsonRequest = async (req) => readJsonBody((await req.body()).toString('utf8'));
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
  // The home gateway (the one door, Liran's devices only) vouches with X-Home-User: owner, as for Video Desk.
  if (req.headers['x-home-user'] === 'owner') return true;
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
const VOICE_PROMPT = path.join(HERE, 'voice-mode.md');
const SYSTEM_PROMPT_FILE = path.join(STATE, 'system-prompt.md');
// Built per spawn, not per install: editing the persona file and restarting is enough to change
// the agent. An unreadable persona file is logged and skipped - a typo in a path must not leave
// the voice channel with no agent at all.
const systemPromptFile = () => {
  if (!PERSONA_FILE) return VOICE_PROMPT;
  let persona;
  try { persona = fs.readFileSync(PERSONA_FILE, 'utf8'); }
  catch (e) { log(`persona: ${PERSONA_FILE} unreadable (${e.code}) - voice prompt only`); return VOICE_PROMPT; }
  fs.writeFileSync(SYSTEM_PROMPT_FILE, `${fs.readFileSync(VOICE_PROMPT, 'utf8').trimEnd()}\n\n${persona.trim()}\n`);
  return SYSTEM_PROMPT_FILE;
};
const claudeArgs = (session, newId) => {
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--append-system-prompt-file', systemPromptFile(),
    '--permission-mode', PERMISSION_MODE,
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
        // Read the sender now: while this reply renders, the next session's message can reach the file.
        const from = relaySender(ev.session_id || claudeSession().id);
        const gen = speechGen;   // reset (hush) after this point skips playLocally below, same reply still logged
        (async () => {
          const spoken = stripMarkdown(ev.result);
          const groups = sentenceGroups(spoken);
          const renders = groups.map((g) => speak(g).catch(() => null));
          for (let i = 0; i < renders.length; i++) {
            const a = await renders[i];
            if (a) { if (gen === speechGen) playLocally(a.file, i, groups[i]); logEvent(relayTurnId, { type: 'audio', url: a.url, index: i, text: groups[i] }); }
          }
          logEvent(relayTurnId, { type: 'text', text: spoken, full: ev.result, from });
        })();
      }
    }
  });
  let gone = false;
  const onGone = (code, error) => {
    if (gone) return;   // a child can report both 'error' and 'exit'
    gone = true;
    if (turnProc === child) turnHandler?.({ type: 'process_exit', code, stderr, error });
    if (claudeProc !== child) return;   // stopped on purpose: stopClaude starts the next one
    claudeProc = null;
    if (Date.now() - startedAt > RESPAWN.stableMs) respawnDelay = RESPAWN.minMs;
    log(`agent process restarting in ${Math.round(respawnDelay / 1000)}s`);
    clearTimeout(respawnTimer);
    respawnTimer = setTimeout(ensureClaude, respawnDelay);
    respawnDelay = Math.min(respawnDelay * 2, RESPAWN.maxMs);
  };
  // Unhandled, a failed start (no `claude` on PATH) would take the whole server down with it.
  // An error from a process that did start (a failed kill) leaves it running; its exit is handled below.
  child.on('error', (e) => {
    log(`agent process error: ${e.message}`);
    if (child.pid === undefined) onGone(null, `the agent could not start (${e.message})`);
  });
  child.on('exit', (code) => {
    log(`claude process exited ${code}${stderr ? ': ' + stderr.trim().split('\n').pop().slice(0, 160) : ''}`);
    onGone(code);
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
    if (ev.type === 'process_exit') return finish(() => reject(new Error(ev.error || ev.stderr?.trim().split('\n').pop()?.slice(0, 160) || `claude exited ${ev.code}`)));
    if (ev.session_id) sessionId = ev.session_id;
    if (ev.type === 'stream_event' && !ev.parent_tool_use_id && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta' && ev.event.delta.text) {
      onEvent({ type: 'delta', text: ev.event.delta.text });
    }
    if (ev.type === 'assistant') {
      for (const block of ev.message?.content || []) {
        // `tool` rides along for the router's trace; the phone only ever reads `text`.
        if (block.type === 'tool_use') onEvent({ type: 'status', text: describeTool(block), tool: block.name });
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
const WHISPER_PATH = process.env.WHISPER_PATH || '/inference';   // the server's inference path (whisper.cpp --inference-path)
const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(os.homedir(), '.local', 'share', 'home-control', 'models', 'ggml-large-v3-turbo.bin');
let whisper = null;
const STT_TIMEOUT_MS = 60000;   // a transcription that has not answered by then has failed
const WHISPER_BASE = () => WHISPER_URL || `http://${HOST}:${WHISPER_PORT}`;
const startWhisper = () => {
  if (WHISPER_URL) return;            // transcription lives on another machine
  if (whisper) return;
  if (!fs.existsSync(WHISPER_MODEL)) { log(`whisper: model missing at ${WHISPER_MODEL} — voice input off, text only`); return; }
  whisper = spawn('whisper-server', ['-m', WHISPER_MODEL, '--host', HOST, '--port', String(WHISPER_PORT), '-l', VOICE_LANG, '-nt', '-t', '8'], { stdio: ['ignore', 'ignore', 'pipe'] });
  whisper.stderr.on('data', (d) => { const line = String(d).trim(); if (/error|failed/i.test(line)) log(`whisper: ${line.slice(0, 200)}`); });
  whisper.on('exit', (code) => { log(`whisper exited ${code}`); whisper = null; });
  log(`whisper starting on ${HOST}:${WHISPER_PORT} lang=${VOICE_LANG}`);
  const silence = Buffer.alloc(44 + 32000);
  silence.write('RIFF', 0); silence.writeUInt32LE(36 + 32000, 4); silence.write('WAVE', 8); silence.write('fmt ', 12); silence.writeUInt32LE(16, 16); silence.writeUInt16LE(1, 20); silence.writeUInt16LE(1, 22);
  silence.writeUInt32LE(16000, 24); silence.writeUInt32LE(32000, 28); silence.writeUInt16LE(2, 32); silence.writeUInt16LE(16, 34); silence.write('data', 36); silence.writeUInt32LE(32000, 40);
  const warm = async (tries) => { try { await transcribe(silence); log('whisper warm'); } catch { if (tries > 0) setTimeout(() => warm(tries - 1), 2000); } };
  setTimeout(() => warm(10), 3000);
};
process.on('exit', () => whisper?.kill());   // SIGTERM/SIGINT: the shared layer drains, then exits

// Phrases whisper produces for silence and breath; an utterance that is only one of these is dropped.
// Whisper's known silence artifacts; a real short answer ("yes", "okay", "תודה") is never dropped.
// Whisper's silence hallucinations: what its training data says when nothing is said. A bare
// "thank you" or "bye" is on the list by choice (Liran, 2026-09-21): his thanks to an agent come
// with words, never bare, so a bare one is noise, and none of these should ever wake the agent.
const HALLUCINATIONS = /^(you|oops|thank you|thanks|thank you very much|thanks for watching|bye|goodbye|תודה|תודה רבה|subtitles by .*|תרגום .*|כתוביות .*|\[.*\]|\(.*\)|\.+)[.!]*$/i;
const whisperReady = async (onStage) => {
  if (!WHISPER_URL && !whisper) { startWhisper(); onStage?.('loading the ear (Whisper)'); }
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${WHISPER_BASE()}/`, { method: 'GET', signal: AbortSignal.timeout(3000) }); if (r.ok || r.status === 404 || r.status === 405) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('whisper did not come up');
};
// A short recording gets `verbose_json` instead of `json`: same transcription, but whisper also
// reports per-word probabilities, the segment log-probabilities and the language it detected —
// the evidence the garbage check is given. It costs nothing but a bigger response, so it is asked
// for only where it is used. Returns { text, evidence }; the hallucination filter runs first in
// both cases, and a filtered turn has no text and therefore nothing to check.
const evidenceFrom = (body) => {
  const segs = Array.isArray(body?.segments) ? body.segments : [];
  const words = [];
  for (const s of segs) for (const w of (Array.isArray(s.words) ? s.words : [])) {
    if (words.length >= 40) break;   // a cap: the state is prose, not a dump
    const p = Number(w.probability);
    if (Number.isFinite(p)) words.push({ word: String(w.word ?? '').trim(), p: Math.round(p * 1000) / 1000 });
  }
  const lps = segs.map((s) => Number(s.avg_logprob)).filter(Number.isFinite);
  return {
    words,
    avgLogprob: lps.length ? Math.round((lps.reduce((a, b) => a + b, 0) / lps.length) * 1000) / 1000 : null,
    language: body?.detected_language ?? null,
    languageP: Number.isFinite(Number(body?.detected_language_probability)) ? Number(body.detected_language_probability) : null,
  };
};
const transcribe = async (wav, onStage, { verbose = false } = {}) => {
  await whisperReady(onStage);
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav');
  form.append('response_format', verbose ? 'verbose_json' : 'json');
  form.append('temperature', '0');
  const res = await fetch(`${WHISPER_BASE()}${WHISPER_PATH}`, { method: 'POST', body: form, signal: AbortSignal.timeout(STT_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`whisper ${res.status}`);
  const body = await res.json();
  const text = String(body.text || '').replace(/\s+/g, ' ').trim();
  if (HALLUCINATIONS.test(text)) return { text: '', evidence: null };
  return { text, evidence: verbose ? evidenceFrom(body) : null };
};

// ---------- tts ----------
const hebrewShare = (t) => {
  const letters = t.replace(/[^\p{L}]/gu, '');
  if (!letters) return 0;
  return (letters.match(/[\u0590-\u05FF]/g) || []).length / letters.length;
};
const detectLang = (t) => (hebrewShare(t) > 0.4 ? 'he' : 'en');
// The Home Server's one TTS (tts.service, ~/dev/home-server/services/tts), called like any other caller.
const TTS_PORT = Number(process.env.TTS_PORT || 4457);
const TTS_BASE = `http://127.0.0.1:${TTS_PORT}`;
// A render that has not finished by then is given up and the edge-tts CLI takes over.
const TTS_TIMEOUT_MS = 20000;
const warmTts = (lang) => { fetch(`${TTS_BASE}/speak`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: lang === 'he' ? 'כן' : 'Yes', voice: VOICES[lang] }), signal: AbortSignal.timeout(TTS_TIMEOUT_MS) }).then((r) => r.arrayBuffer()).catch(() => {}); };
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
// mpv or ffplay play this turn's audio on this machine's own output; 'off' means no playback
// here at all (checked first in playLocally, before any turn state is touched).
const LOCAL_PLAYER = process.env.VOICE_LOCAL_PLAYER || 'mpv';
// Speaking speed. The phone can only speed up its own <audio>; this is the same setting applied
// to the machine's own output — this machine's speakers — so a tap on the phone changes what the
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
// Speech volume on this machine's own output, set from the dashboard. Like the rate it only
// touches the player this server spawns (never the system mixer or the phone), and it is on
// disk so a restart keeps it. A missing file means full volume, which is how playback sounded
// before this setting existed.
const VOLUME_FILE = path.join(STATE, 'volume.json');
// Levels run to 140: 100 is the normal top, and the range above it adds loudness under a limiter.
const VOLUME_MAX = 140;
const clampLevel = (n) => Math.min(VOLUME_MAX, Math.max(0, Math.round(n)));
let volume = (() => { const v = readJson(VOLUME_FILE, {}); return { level: Number.isFinite(v.level) ? clampLevel(v.level) : 100, muted: v.muted === true }; })();
// The player's own volume only turns speech down (0-100, 0 when muted). It is applied after the
// filters below, so it can never push the limited signal past full scale.
const playerVolume = () => (volume.muted ? 0 : Math.min(volume.level, 100));
// Loudness is added in a filter, ahead of a limiter. Every level gets 1.5 dB over the file as
// generated: edge-tts peaks reach about -2 dBFS at their loudest, so up to 100 the limiter has
// nothing to do. Above 100 the gain follows the same cubic curve as mpv's volume
// (gain = (v/100)^3, so 60*log10(v/100) dB; 140 is about +8.8 dB), and the limiter holds peaks
// just under full scale, so loud speech gets denser instead of clipping.
const SPEECH_BOOST_DB = 1.5;
const LIMITER = 'alimiter=limit=0.966:level=disabled';   // -0.3 dBFS, no automatic make-up gain
const speechGainDb = () => Math.round((SPEECH_BOOST_DB + (volume.level > 100 ? 60 * Math.log10(volume.level / 100) : 0)) * 100) / 100;
// Accepts level (0-140, clamped) and/or muted (a real boolean); anything else leaves it unchanged.
const setVolume = (body) => {
  const next = { ...volume };
  const hasLevel = body.level !== undefined && body.level !== null && body.level !== '';
  if (hasLevel) { const n = Number(body.level); if (!Number.isFinite(n)) return false; next.level = clampLevel(n); }
  if (body.muted !== undefined) { if (typeof body.muted !== 'boolean') return false; next.muted = body.muted; }
  if (!hasLevel && body.muted === undefined) return false;
  const changed = next.level !== volume.level || next.muted !== volume.muted;
  volume = next;
  if (!changed) return true;
  try { writeJson(VOLUME_FILE, volume); } catch (e) { log(`volume not saved: ${e.message}`); }
  applyLiveVolume();
  return true;
};
// A change should be heard mid-sentence, not only from the next one. mpv listens on a JSON IPC
// socket for that; ffplay has no equivalent, so with ffplay a change applies from the next
// sentence. The socket lives in STATE unless that path is too long for a Unix socket (about
// 104 bytes), in which case it goes to the temp dir under a name derived from STATE.
const MPV_SOCKET = (() => {
  const inState = path.join(STATE, 'mpv.sock');
  if (Buffer.byteLength(inState) <= 100) return inState;
  return path.join(os.tmpdir(), `home-control-mpv-${crypto.createHash('sha1').update(STATE).digest('hex').slice(0, 10)}.sock`);
})();
let localIpc = null;   // the socket of the mpv playing right now, if any
const removeMpvSocket = () => { try { fs.rmSync(MPV_SOCKET, { force: true }); } catch {} };
const applyLiveVolume = () => {
  if (!localIpc) return;
  const sock = net.createConnection(localIpc);
  sock.setTimeout(1000, () => sock.destroy());
  // Best effort: a player that is just starting or just exited simply misses this one change.
  sock.on('error', () => {});
  // mpv answers the af-command with an error even though the gain filter applies it (the command
  // also reaches filters that don't take it), so like the rest it isn't checked.
  sock.on('connect', () => sock.end([
    { command: ['set_property', 'volume', playerVolume()] },
    { command: ['af-command', 'gain', 'volume', `${speechGainDb()}dB`] },
  ].map((c) => JSON.stringify(c) + '\n').join('')));
};
// Away mode: optional feature switched on by VOICE_AWAY. When on: replies are still sent to the
// phone as normal, but this machine's own speakers stay silent — no TTS on this machine's
// speakers. Set directly by the agent (it has filesystem access) when the user says they're
// leaving or back — no route needed for a single bool nothing else ever sets. Checked at play
// time (once per sentence), so a plain file write takes effect immediately without a server
// restart or an HTTP round trip to itself — but the value is cached against the file's mtime, so
// the common case is one stat() rather than a read plus a JSON.parse on every sentence. A missing
// file means not away. When off, isAway() always returns false and never touches the file.
const AWAY_ON = parseOnOff(process.env.VOICE_AWAY, false);
const AWAY_FILE = path.join(STATE, 'away.json');
let awayCache = false, awayMtime = null;
const isAway = () => {
  if (!AWAY_ON) return false;
  let mtime = null;
  try { mtime = fs.statSync(AWAY_FILE).mtimeMs; } catch {}
  if (mtime === awayMtime) return awayCache;
  awayMtime = mtime;
  awayCache = mtime === null ? false : !!readJson(AWAY_FILE, {}).away;
  return awayCache;
};
// The only writer of the away flag besides the agent's own file edits: the router's away
// procedures. Clearing the cached mtime makes the next isAway() re-read rather than trust a
// write that landed inside the same millisecond.
const setAway = (on) => { writeJson(AWAY_FILE, { away: on }); awayMtime = null; };
// Where the router's shadow log goes; bin/router-report reads it back against transcript.jsonl.
const ROUTER_FILE = path.join(STATE, 'router.jsonl');
// The last few exchanges, for the state Jev is shown — "turn it off", and a bare "yes", only
// mean anything next to what was said before, on both sides. Each entry is { user, agent }.
// Kept in memory: a restart starting cold here costs nothing.
const recentTurns = [];
const rememberTurn = (user, agent) => { recentTurns.push({ user, agent: String(agent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) }); if (recentTurns.length > 3) recentTurns.shift(); };

let localQueue = Promise.resolve();
let localTurn = 0;
let localChild = null;
// What the machine is saying out loud right now, and the whole turn's sentences.
// The dashboard has no live channel of its own — it polls this through /api/state,
// which is what lets it highlight the sentence being spoken and scroll to it.
let nowPlaying = null;          // { index, text } while a sentence is playing
let turnSentences = [];         // every sentence of the current turn, in order
const resetSpokenState = () => { nowPlaying = null; turnSentences = []; };
// Hush (the phone's reset button): the turn running when it was pressed says nothing more on this
// machine. It lifts when that turn ends (handleTurn's finally), so the next turn speaks normally.
let hushed = false;
// Bumped by the same button, but this one also reaches a relay reply: busy is false for those, so
// `hushed` alone never covers them. The relay loop below captures the value at its start and stops
// calling playLocally once it no longer matches — it keeps logging text/audio events either way, so
// the phone still gets the full reply, just silent on this machine.
let speechGen = 0;
const playLocally = (file, index = null, text = '') => {
  // Recorded before the early returns below: the monitor dashboard's sentence list should fill
  // even with no machine speakers (LOCAL_PLAYER=off) or mid-hush — away mode already worked this
  // way since isAway() is checked further down, inside the queued playback itself.
  if (text && index !== null) turnSentences[index] = text;
  if (LOCAL_PLAYER === 'off') return;
  if (hushed) return;
  const myTurn = localTurn;
  localQueue = localQueue.then(() => new Promise((resolve) => {
    if (myTurn !== localTurn) return resolve(); // skipped before its turn came up
    if (isAway()) return resolve(); // away mode: phone still gets it, this machine stays silent
    if (index !== null) nowPlaying = { index, text };
    const clear = () => { if (nowPlaying && nowPlaying.index === index) nowPlaying = null; };
    const tryFfplay = (origErr) => {
      const fp = spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', String(playerVolume()), '-af', [`volume=${speechGainDb()}dB`, LIMITER, ...(speechRate === 1 ? [] : [`atempo=${speechRate}`])].join(','), file], { stdio: 'ignore' });
      localChild = fp;
      localIpc = null;
      fp.on('error', (e) => { log(`local playback failed: no mpv or ffplay (${origErr?.message || e.message})`); localChild = null; clear(); resolve(); });
      fp.on('exit', () => { localChild = null; clear(); resolve(); });
    };
    if (LOCAL_PLAYER === 'ffplay') { tryFfplay(); return; }
    removeMpvSocket();   // one left by a player that was killed would refuse connections
    const child = spawn(LOCAL_PLAYER, ['--no-terminal', '--really-quiet', `--speed=${speechRate}`, `--volume=${playerVolume()}`, `--af=@gain:lavfi=[volume=${speechGainDb()}dB],lavfi=[${LIMITER}]`, `--input-ipc-server=${MPV_SOCKET}`, file], { stdio: 'ignore' });
    localChild = child;
    localIpc = MPV_SOCKET;
    child.on('error', (e) => { localIpc = null; tryFfplay(e); });
    child.on('exit', () => { localChild = null; localIpc = null; removeMpvSocket(); clear(); resolve(); });
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
  // /speak/stream: the bytes go to the file as Microsoft sends them. The phone still gets the URL only
  // once the file is whole (its <audio> is given a finished, ranged file, never a growing one).
  try {
    const res = await fetch(`${TTS_BASE}/speak/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice }), signal: AbortSignal.timeout(TTS_TIMEOUT_MS) });
    if (res.ok && res.body) { await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(out)); done = true; }
    else log(`tts ${res.status}: ${(await res.text()).slice(0, 120)} — falling back to the cli`);
  } catch (e) { log(`tts unreachable or cut off (${e.message}) — falling back to the cli`); }
  if (!done) await speakViaCli(text, voice, out);
  // Relative: the phone page resolves it against its own address (…/home-control/mobile/).
  return { url: `audio/${id}.mp3`, file: out, lang };
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
  // the client's poller knows a live-streamed event was already shown and doesn't render the turn
  // a second time.
  const send = (ev) => { const entry = logEvent(turnId, ev); sendRaw({ ...ev, id: entry.id }); };
  const started = Date.now();
  let trace = null;   // the router's per-turn trace, filled as the turn runs and written in finally
  try {
    let text, lang, inputAudio, duration = null, evidence = null;
    if ((req.headers['content-type'] || '').startsWith('audio/')) {
      const wav = await req.body({ maxBytes: 20e6 });
      inputAudio = wav;
      send({ type: 'status', text: 'transcribing' });
      // The duration gate, decided from the header before a byte is sent: a short recording is
      // the only kind that can be whisper garbage, and it is the only kind transcribed verbosely.
      duration = wavDurationS(wav);
      const short = duration != null && duration < routerConfig().short_max_s;
      ({ text, evidence } = await transcribe(wav, (stage) => send({ type: 'status', text: stage, startup: true }), { verbose: short }));
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
    // Fired here, not awaited: the input is known as soon as text exists, independent of
    // playback (finally used to wait for localQueue first, so a hung/dead process lost it, and
    // it ran after the machine finished speaking instead of right away). No local var to hold it
    // in past this call, so its audio reference is dropped as soon as the hook is handed off.
    if (INPUT_HOOK_CONFIGURED) runInputHook({ at: new Date(started).toISOString(), text, audio: inputAudio }).then(() => log('input hook: ran'), (e) => log(`input hook: failed: ${e.message}`));
    // The Jev router, between the input hook and Claude: a typed decision on what this turn is.
    // In shadow it only writes a line to router.jsonl. In `on` a confident fixed-procedure label
    // either answers the turn here (say) or narrows what Claude is asked (claudeText). Any
    // failure at all leaves `agentInput` as the user's own words and the turn runs as before.
    let agentInput = text, routedLabel = null;
    if (routerMode() !== 'off') {
      // One line per turn, written in the finally below so it holds the whole chain: what Jev
      // was asked and answered, what was routed, and what Claude then did.
      const cfg = routerConfig();
      // Only a transcribed turn can be whisper garbage; something typed on the phone is
      // deliberate, has no duration, and skips the gate entirely.
      const short = duration != null && duration < cfg.short_max_s;
      trace = { turn_id: turnId, at: new Date(started).toISOString(), text, lang, away: isAway(), tv_on: tvIsOn(), sessions: liveSessions(), config: cfg, audio: inputAudio ? { duration_s: duration == null ? null : Math.round(duration * 100) / 100, short } : null, t: { text_ready: new Date().toISOString() } };
      // Step one of the gate: the garbage check, its own Jev request, short recordings only. A
      // dropped turn ends here — no intent question, no Claude, nothing spoken.
      if (short) {
        const g = await garbageCheck({ text, lang, duration, ...(evidence || {}), recent: recentTurns }, { log });
        trace.mode = g.mode;
        trace.garbage = g.garbage;
        trace.addressed = g.addressed ?? null;
        trace.complete = g.complete ?? null;
        trace.t.garbage_sent = g.garbage?.sent_at ?? null;
        trace.t.garbage_done = g.garbage?.done_at ?? null;
        if (g.drop) {
          // Jev is sure this was not readable speech (`garbage`: a scramble, a misclick) or not
          // an utterance at all (`fragment`: a false start, a stray word). The turn ends exactly
          // as an empty transcription does, but it is still logged, at cost 0, so it can be read
          // back afterwards.
          const reason = g.reason || 'garbage';
          trace.routed = 'dropped';
          trace.drop_reason = reason;
          fs.appendFileSync(TRANSCRIPT, JSON.stringify({ at: new Date().toISOString(), user: text, agent: `<router:dropped:${reason}>`, spoken: '', ms: Date.now() - started, cost: 0, routed: 'dropped', drop_reason: reason }) + '\n');
          trace.result = { by: 'router', spoken: '', cost: 0, ms: Date.now() - started };
          send({ type: 'ignored' });
          return;
        }
      }
      const { mode, decision, action, error, jev } = await routeTurn(
        { text, lang, typed: !inputAudio, away: trace.away, tvOn: trace.tv_on, sessions: trace.sessions, recent: recentTurns },
        { setAway, log },
      );
      trace.mode = mode;
      trace.jev = jev;
      trace.t.jev_sent = jev?.sent_at ?? null;
      trace.t.jev_done = jev?.done_at ?? null;
      trace.intent = decision?.intent ?? null;
      trace.confidence = decision?.confidence ?? null;
      trace.tv_action = decision?.tv_action ?? null;
      trace.level = decision?.level ?? null;
      trace.probabilities = decision?.probabilities ?? null;
      trace.error = error || null;
      trace.routed = action ? decision.intent : null;
      if (action) {
        routedLabel = decision.intent;
        send({ type: 'routed', label: routedLabel });
        log(`routed: ${routedLabel}${decision.tv_action ? `/${decision.tv_action}` : ''} conf=${decision.confidence.toFixed(2)} jev=${decision.ms}ms`);
      }
      if (action?.say) {
        const audio = await speak(action.say, lang);
        if (audio) emitAudio(send, audio, 0, action.say);
        send({ type: 'text', text: action.say, full: action.say });
        // After the line is out: away mode silences these speakers, so the order matters. For
        // away_on "out" means finished playing on this machine (its speakers are the TV that
        // `after` switches off), so drain localQueue first, capped so a stuck player can't hold
        // the TV on.
        if (action.waitForSpeakers) await Promise.race([localQueue.catch(() => {}), new Promise((r) => setTimeout(r, SPEAKERS_DRAIN_CAP_MS))]);
        if (action.after) await action.after();
        // cost 0 and an agent field that names the router, so the dashboard's analytics still
        // count the turn and a routed turn is visible as one.
        fs.appendFileSync(TRANSCRIPT, JSON.stringify({ at: new Date().toISOString(), user: text, agent: `<router:${routedLabel}>`, spoken: action.say, ms: Date.now() - started, cost: 0, routed: routedLabel }) + '\n');
        log(`turn routed ${Date.now() - started}ms label=${routedLabel} cost=$0.000`);
        trace.result = { by: 'router', spoken: action.say, cost: 0, ms: Date.now() - started };
        rememberTurn(text, action.say);
        send({ type: 'done' });
        pruneAudio();
        return;
      }
      if (action?.claudeText) agentInput = action.claudeText;   // still a Claude turn, a deterministic one
    }
    // Recorded now so the router sees it next turn even if Claude fails; the reply is filled in
    // below once it exists.
    rememberTurn(text, '');
    const thisTurn = recentTurns[recentTurns.length - 1];
    const first = !claudeSession().id;
    send({ type: 'status', text: first ? 'waking up' : 'thinking' });
    warmTts(lang);
    let firstAudioAt = 0;
    const markFirstAudio = () => { if (!firstAudioAt) firstAudioAt = Date.now(); };
    const speaker = makeSpeaker((ev) => { markFirstAudio(); send(ev); }, lang);
    const tools = [];
    const turn = await runTurn(agentInput, (ev) => {
      if (trace) {
        trace.t.claude_first_event ||= new Date().toISOString();
        if (ev.tool) tools.push(ev.tool);
      }
      return ev.type === 'delta' ? speaker.feed(ev.text) : send(ev);
    });
    if (trace) trace.result = { by: 'claude', input: agentInput, text: turn.text, tools, cost: turn.cost ?? 0, ms: Date.now() - started };
    let spoken = await speaker.finish();
    if (!spoken) spoken = await speakFallback(turn.text, lang, send, markFirstAudio);
    send({ type: 'text', text: spoken, full: turn.text });
    thisTurn.agent = String(spoken || turn.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    fs.appendFileSync(TRANSCRIPT, JSON.stringify({ at: new Date().toISOString(), user: text, agent: turn.text, spoken, ms: Date.now() - started, cost: turn.cost, ...(routedLabel ? { routed: routedLabel } : {}) }) + '\n');
    log(`turn ok ${Date.now() - started}ms first-audio=${firstAudioAt ? firstAudioAt - started : '-'}ms sentences=${speaker.count} cost=$${(turn.cost || 0).toFixed(3)} session=${turn.sessionId}`);
    send({ type: 'done' });
    pruneAudio();
  } catch (e) {
    log(`turn failed: ${e.message}`);
    if (trace) trace.error = trace.error || e.message;
    send({ type: 'error', text: e.message });
  } finally {
    // One trace line per turn, whatever happened to it — including a turn that failed.
    if (trace) {
      if (trace.result?.by === 'claude') trace.t.claude_done = trace.t.claude_done || new Date().toISOString();
      trace.t.turn_done = new Date().toISOString();
      trace.total_ms = Date.now() - started;
      logRouterTurn(ROUTER_FILE, trace);
    }
    // The phone reopens its mic once this response ends (its own queue already drained by
    // then). If we ended it while this machine's speakers were still playing this turn's
    // sentences, the mic would come on mid-playback and hear itself. Waiting for localQueue
    // here — the same chain playLocally() feeds — closes that gap; skipLocal() (via /api/skip)
    // still cuts it short on demand.
    try { await localQueue; } catch {}
    hushed = false;
    busy = false;
    res.end();
  }
};

// Icons and the manifest are public: iOS asks for them when the app is added to the
// home screen, and the login page needs them too. Fixed allowlist — no path building.
const PUBLIC_FILES = {
  '/manifest.json': ['manifest.json', 'application/manifest+json'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/favicon-32.png': ['favicon-32.png', 'image/png'],
  '/favicon.ico': ['favicon-32.png', 'image/png'],
};

// Home Control (the dashboard, monitor.mjs) at the root; it reads this process's live state.
const dashboard = createDashboard({
  port: PORT,
  live: () => ({ nowPlaying, sentences: turnSentences, rate: speechRate, volume }),
  postVolume: (raw) => { const ok = setVolume(readJsonBody(raw)); return { status: ok ? 200 : 400, body: { ok, ...volume } }; },
});

const app = createApp({ id: 'home-control', port: PORT, bind: HOST });

// Home Control Mobile (index.html, the phone page) lives under /mobile/. Its relative URLs (api/, audio/,
// login, icons, manifest) reach the same routes as at the root: every route below is registered at
// both. The root's own three are the dashboard's (/, /api/activity, POST /api/volume).
const page = (req) => (req.pathname.startsWith('/mobile/') ? req.pathname.slice('/mobile'.length) : req.pathname);
const both = (method, p, handler) => { app.route(method, p, handler); app.route(method, '/mobile' + p, handler); };
const keyLogin = (req, res) => {
  const key = req.query.get('key');
  if (!key || isLoggedIn(req) || !tryLogin(key, res, req)) return false;
  redirect(res, 303, './');
  return true;
};
// open: no login needed, but ?key= still logs in. gated: the login page (or 401 for api/ and audio/) until logged in.
const open = (fn) => async (req, res) => (keyLogin(req, res) ? undefined : fn(req, res));
const gated = (fn) => open(async (req, res) => {
  if (isLoggedIn(req)) return fn(req, res);
  const p = page(req);
  if (p.startsWith('/api/') || p.startsWith('/audio/')) return json(res, 401, { error: 'login' });
  return html(res, 'login.html', 401);
});
const ok = () => ({ ok: true });

app.route('GET', '/mobile', async (req, res) => redirect(res, 308, 'mobile/' + (req.query.size ? '?' + req.query : '')));
for (const p of ['/', '/api/activity']) app.get(p, (req, res) => dashboard(req, res, p));
app.post('/api/volume', (req, res) => dashboard(req, res, '/api/volume'));

both('POST', '/login', async (req, res) => {
  const body = (await req.body()).toString('utf8');
  const key = req.headers['content-type']?.includes('json') ? readJsonBody(body).key : new URLSearchParams(body).get('key');
  if (tryLogin(key, res, req)) return redirect(res, 303, './');
  return html(res, 'login.html', 401);
});
const logout = async (req, res) => { res.setHeader('Set-Cookie', 'voice=; Path=/; Max-Age=0'); redirect(res, 303, './'); };
both('GET', '/logout', logout);
both('POST', '/logout', logout);
for (const [p, [file, type]] of Object.entries(PUBLIC_FILES)) both('GET', p, open((req, res) => sendFile(req, res, path.join(HERE, file), { type })));

app.get('/mobile/', gated(async (req, res) => html(res, 'index.html')));
both('POST', '/api/turn', gated(handleTurn));
both('POST', '/api/skip', gated(async (req) => { if (req.query.get('hush') === '1') { if (busy) hushed = true; speechGen++; } skipLocal(); return ok(); }));
both('POST', '/api/client-log', gated(async (req) => { const b = await readJsonRequest(req); log('phone: ' + String(b?.msg ?? '').slice(0, 400)); return ok(); }));
both('POST', '/api/rate', gated(async (req, res) => {
  const body = await readJsonRequest(req);
  const ok = setSpeechRate(body.rate);
  return json(res, ok ? 200 : 400, { ok, rate: speechRate });
}));
both('GET', '/api/volume', gated(async () => volume));
app.post('/mobile/api/volume', gated(async (req, res) => {
  const ok = setVolume(await readJsonRequest(req));
  return json(res, ok ? 200 : 400, { ok, ...volume });
}));
both('POST', '/api/reset', gated(async () => {
  const old = claudeSession();
  // Clear the session first: stopClaude starts the next process, and it must not resume this one.
  saveClaudeSession({ id: null, turns: 0, previous: old.id });
  stopClaude();
  // New conversation means new conversation: the drawer's file is cleared, and so is the
  // event log — otherwise old content stays reachable via /api/events (a catching-up phone
  // would render it into the fresh conversation) even after the reset button was pressed.
  try { fs.rmSync(TRANSCRIPT, { force: true }); } catch {}
  eventLog = [];
  // The router's memory of the last exchanges goes with it: a new conversation is cold for Jev
  // exactly as it is for Claude, or a bare "yes" would be judged against a conversation that no
  // longer exists.
  recentTurns.length = 0;
  log(`session reset (was ${old.id}, ${old.turns} turns)`);
  return ok();
}));
// away here also covers LOCAL_PLAYER === 'off': with no machine speakers, the phone is the
// only player, so it must start unmuted exactly like real away mode does.
both('GET', '/api/state', gated(async () => { const s = claudeSession(); return { busy, session: s.id, turns: s.turns, at: s.at, voiceInput: !!WHISPER_URL || fs.existsSync(WHISPER_MODEL), nowPlaying, sentences: turnSentences, rate: speechRate, volume, away: LOCAL_PLAYER === 'off' || isAway() }; }));
both('GET', '/api/session-stats', gated(async () => sessionStats()));
both('GET', '/api/transcript', gated(async () => {
  const lines = fs.existsSync(TRANSCRIPT) ? fs.readFileSync(TRANSCRIPT, 'utf8').trim().split('\n').filter(Boolean).slice(-40) : [];
  return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}));
// The reliability backbone: a phone polls this while foregrounded and catches up on
// anything it missed — most importantly a relay reply that landed after its own turn's
// SSE connection had already closed. `after` is the highest event id already seen; with
// none given (first load), the recent tail of the log is returned instead of nothing.
both('GET', '/api/events', gated(async (req) => {
  const after = Number(req.query.get('after'));
  const list = Number.isFinite(after) && after > 0 ? eventLog.filter((e) => e.id > after) : eventLog.slice(-50);
  // No cursor in the response: the client tracks the highest id it has actually applied,
  // which is the only value that is safe for it to poll from next.
  return { events: list, bootId: BOOT_ID };
}));
// A clip's name is its content's hash, so it may be kept for an hour.
both('GET', '/audio/*', gated(async (req, res) => {
  const file = path.join(AUDIO_DIR, path.basename(req.rest));
  if (!fs.existsSync(file)) return json(res, 404, { error: 'gone' });
  return sendFile(req, res, file, { type: 'audio/mpeg', cache: 'private, max-age=3600' });
}));
// Anything else: still behind the gate (the login page, not a 404, until logged in).
for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) app.route(m, '/*', gated(async (req, res) => json(res, 404, { error: 'not found' })));

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

app.listen().then(() => {
  passphrase();
  startWhisper();
  ensureClaude();
  const rewriteRaw = String(process.env.VOICE_SPEECH_REWRITE || '').trim();
  if (rewriteRaw && !/^(on|off|true|false|0|1)$/i.test(rewriteRaw)) {
    log(`VOICE_SPEECH_REWRITE=${rewriteRaw} is not on|off; treating as on`);
  }
  log(`voice server on http://${HOST}:${PORT} root=${ROOT} lang=${VOICE_LANG} speech-rewrite=${SPEECH_REWRITE_ON ? 'on' : 'off'}`);
  setRouterLog(log);   // so a broken router.json is announced in the server's own log
  warmRouter().then((r) => { if (r) log(`router: jev warm (${r.status}, ${r.ms}ms, mode=${routerMode()})`); }, (e) => log(`router: warm-up failed: ${e.message}`));
  // Node drops an idle keep-alive after 4 s and a cold call to Jev costs ~400 ms more than a warm
  // one (measured: 290 ms pinged vs 800 ms cold), so while a conversation is live the connection
  // is pinged every 3 s, the same idea as the TTS warm-up above. Quiet once the turns stop.
  setInterval(() => { if (lastTurnAt && Date.now() - lastTurnAt < IDLE.ttsWarmMs) warmRouter().catch(() => {}); }, 3000);
}, (e) => { log(`cannot listen on ${HOST}:${PORT}: ${e.message}`); process.exit(1); });
