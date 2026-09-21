// The Jev router: one typed decision per turn, taken before Claude is asked anything.
// Jev (TypeSafe AI) answers a Choice question in 70-500 ms and can only return a label from the
// list, so a fixed procedure (away mode, a TV command) can run without paying for a Claude turn.
// Everything here is best effort by design: a slow, broken or unconfigured Jev must never make a
// turn fail, so every failure path ends in "go to Claude, exactly as before".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENDPOINT = process.env.JEV_ENDPOINT || 'https://api.typesafe.ai/v1/systemone';
export const SPEAKERS_DRAIN_CAP_MS = 3000;
const TV_API = process.env.TV_SERVICE_URL || 'http://127.0.0.1:4470';

export const LINES = JSON.parse(fs.readFileSync(path.join(HERE, 'router-lines.json'), 'utf8'));

// ---------- live config ----------
// Everything the router is tuned by can be changed while the server runs: a JSON file next to
// router.jsonl, re-read only when its mtime moves (the same trick isAway() uses on away.json),
// so a threshold or the mode can be tried without ending a conversation with a restart.
// Precedence: file > env > default. A missing file is not an error — it just means env/defaults.
const STATE_DIR = process.env.VOICE_STATE || path.join(process.env.HOME || '', '.local', 'share', 'home-control', 'state', process.env.VOICE_LABEL || 'voice');
export const CONFIG_FILE = path.join(STATE_DIR, 'router.json');
// The log sink. The server owns the log file, so it hands its own logger in at startup; before
// that (and in tests) a bad config file is simply not announced.
let cfgLog = () => {};
export const setRouterLog = (fn) => { cfgLog = fn || (() => {}); };
// `undefined` means never read; `null` means read and absent.
let cfgMtime, cfgFile = {}, cfgWarned;
const readConfigFile = () => {
  let mtime = null;
  try { mtime = fs.statSync(CONFIG_FILE).mtimeMs; } catch {}
  if (mtime === cfgMtime) return cfgFile;
  cfgMtime = mtime;
  if (mtime === null) { cfgFile = {}; return cfgFile; }   // deleted: back to env/defaults
  try {
    const v = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not a JSON object');
    cfgFile = v;
    cfgWarned = undefined;
  } catch (e) {
    // A typo must never quietly reset the router to defaults mid-conversation: keep the last
    // good values and say so once per version of the broken file.
    if (cfgWarned !== mtime) { cfgWarned = mtime; cfgLog(`router: router.json unreadable (${e.message}), keeping last good config`); }
  }
  return cfgFile;
};
const mode1 = (v) => { const s = String(v ?? '').trim().toLowerCase(); return s === 'on' || s === 'shadow' || s === 'off' ? s : null; };
const prob = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 && n <= 1 ? n : null; };
const pos = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const model1 = (v) => (v === 'jev-latest' || v === 'jev-preview' ? v : null);
// The effective settings, one object, file over env over default. Cheap enough to call per turn.
export function routerConfig() {
  const f = readConfigFile();
  const pick = (fv, ev, dflt) => fv ?? ev ?? dflt;
  return {
    // off: no Jev call at all. shadow: ask and log, route nothing. on: route per the rule.
    mode: pick(mode1(f.mode), mode1(process.env.JEV_ROUTER), 'off'),
    route_min: pick(prob(f.route_min), prob(process.env.JEV_ROUTE_MIN), 0.85),
    // How sure Jev has to be that the turn was NOT speech before it is thrown away.
    // 0.90 means: drop only when the probability of "addressed" is below 0.10.
    drop_min: pick(prob(f.drop_min), prob(process.env.JEV_DROP_MIN), 0.90),
    // How sure Jev has to be that the turn was a fragment — a false start, a stray word — before
    // it is thrown away. 0.6 means: drop only when the probability of "complete" is below 0.40.
    fragment_min: pick(prob(f.fragment_min), prob(process.env.JEV_FRAGMENT_MIN), 0.6),
    // Under this many seconds of audio, a turn is short enough to be whisper garbage and gets
    // the garbage check (and verbose transcription to feed it).
    short_max_s: pick(pos(f.short_max_s), pos(process.env.JEV_SHORT_MAX_S), 3.0),
    model: pick(model1(f.model), model1(process.env.JEV_MODEL), 'jev-latest'),
    timeout_ms: pick(pos(f.timeout_ms), pos(process.env.JEV_TIMEOUT_MS), 1500),
    // Away mode timing: how long the TV gets to bring its HDMI audio up after hdmi1 before we speak.
    tv_settle_ms: pick(pos(f.tv_settle_ms), pos(process.env.JEV_TV_SETTLE_MS), 2000),
  };
}
export const routerMode = () => routerConfig().mode;
export const routeMin = () => routerConfig().route_min;
export const dropMin = () => routerConfig().drop_min;
export const fragmentMin = () => routerConfig().fragment_min;
export const shortMaxS = () => routerConfig().short_max_s;

// ---------- wav ----------
// How long the recording is, straight from the RIFF header, before a byte is sent to whisper —
// the duration gate decides which transcription format to ask for, so it cannot wait for the
// answer. Chunks are walked rather than assumed at fixed offsets: whatever the phone records
// today, a header with a LIST or fact chunk in front of `data` must still measure right.
// Returns null for anything that is not a WAV we can measure; the caller then treats the turn
// as long (no gate), which is the safe direction.
export function wavDurationS(buf) {
  try {
    if (!buf || buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
    let off = 12, byteRate = 0, dataBytes = null;
    while (off + 8 <= buf.length) {
      const id = buf.toString('latin1', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === 'fmt ' && off + 20 <= buf.length) byteRate = buf.readUInt32LE(off + 16);
      if (id === 'data') {
        // A streamed writer can leave the size at 0 or a placeholder: trust the bytes we hold.
        const rest = buf.length - (off + 8);
        dataBytes = size > 0 && size <= rest ? size : rest;
        break;
      }
      off += 8 + size + (size % 2);   // RIFF chunks are word aligned
    }
    if (!byteRate || dataBytes == null || dataBytes <= 0) return null;
    return dataBytes / byteRate;
  } catch { return null; }
}

// The fixed spoken lines. The router never generates text — it picks one of these, so a routed
// turn sounds the same every time and costs nothing.
export const line = (key, lang, vars = {}) => {
  const l = LINES[key];
  if (!l) return '';
  return (l[lang === 'he' ? 'he' : 'en'] || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
};

const INTENT = {
  instructions: 'What the user wants done with this turn. Pick `conversation` unless the turn is clearly one of the fixed procedures.',
  criteria: {
    away_on: 'The user says they are leaving, going out, or asks for away mode to be turned on.',
    away_off: 'The user says they are back home, or asks for away mode to be turned off.',
    tv: 'A direct command about the television: mute, unmute, volume, turn it on or off, switch input.',
    relay_on: 'The user asks to start relay mode with another agent session, naming or describing it.',
    relay_off: 'The user asks to end relay mode.',
    conversation: 'Anything else at all: a question, a request for work, chat, or an unclear turn.',
  },
};
// The gate in front of everything else. It is deliberately NOT an "is this meant for me" judgement:
// whisper hands us scrambles, half-words and mis-recordings, and those are the only thing we drop.
// A readable "yes" answering the previous round is speech, and speech always goes through.
const ADDRESSED = {
  instructions: 'Is this transcript readable speech, or is it transcription garbage? Answer true for anything a person could have said out loud to their voice assistant in English or Hebrew, however short — a bare "yes", "no", "done" or "fine" answering the previous exchange is true. Answer false only when the text is not readable speech at all: garbled characters, a non-word fragment, a scramble, or a language that is neither English nor Hebrew. The transcriber\'s own per-word probabilities and detected language are evidence about whether this was readable speech at all: low word probabilities, or a confidently detected language that is neither English nor Hebrew, point to garbage rather than to something said.',
  criteria: {
    true: 'This is readable English or Hebrew speech, however short, that a person could have said to their voice assistant.',
    false: 'Unreadable, garbled, a non-word fragment, or a language other than English or Hebrew.',
  },
};
// The second gate, asked in the same request but read only after ADDRESSED has let the turn
// through: readable speech is not yet a turn worth answering. A false start, a stray word or a
// sentence cut off mid-air is readable and still nothing to reply to.
const COMPLETE = {
  // No word counts here on purpose: the 3 s gate already picks who gets asked. Jev judges meaning —
  // does this stand on its own, or does it lean on the exchange before it, and is that exchange there.
  instructions: 'Does this utterance carry a meaning of its own to the voice assistant — a request, a question, an answer, an instruction — or is it a fragment: a false start, a stray word, an interjection, a sentence cut off before it said anything? Judge by meaning, not by length. Many utterances only mean something in reply to what the assistant just said or asked ("yes", "no", "done", "the second one", "why is that?", "what about it?"): those are complete when the recent exchanges shown above contain what they answer or refer to, and fragments when there is no such exchange. An utterance that carries its meaning by itself ("mute the TV", "what time is it", "I\'m going out") is complete with or without prior exchanges.',
  criteria: {
    true: 'Carries a meaning of its own, or answers / refers to something in the recent exchanges shown.',
    false: 'A fragment: a false start, interjection, stray word or cut-off — or a reply/reference with no recent exchange it belongs to.',
  },
};
const TV_ACTION = {
  instructions: 'Which TV command the user asked for.',
  criteria: {
    mute: 'Mute the TV / silence it.',
    unmute: 'Unmute the TV / sound back on.',
    volume_up: 'Raise the volume, no exact level given.',
    volume_down: 'Lower the volume, no exact level given.',
    volume_set: 'Set the volume to an exact level, e.g. "volume 15".',
    power_off: 'Turn the TV off.',
    power_on: 'Turn the TV on.',
    hdmi1: 'Switch to HDMI 1 / show the computer.',
    other: 'Any other TV request: apps, channels, menus, picture settings, or unclear.',
  },
};
// Score takes an ordered rubric of at most 10 levels, not a range: index i means level i*10. The
// answer is an expected value that may fall between indices, so "volume 15" comes back near 1.5
// and the caller rounds to the nearest 5.
const LEVEL = { type: 'score', instructions: 'The volume level the user asked for, 0-100. Index 0 means none was given or 0.', criteria: Array.from({ length: 10 }, (_, i) => (i === 0 ? 'no level given, or 0' : `volume ${i * 10}`)) };

// One request shape, in one place. `state` is prose because that is what Jev reads; the questions
// are the typed part. Rejects on timeout, a non-200, or a body that is not shaped as expected —
// every caller treats a rejection as "go to Claude".
// One low-level call, shared by both requests: the transport, the timeout and the error shape are
// the same whichever questions are asked.
async function ask(state, questions, { fetchImpl = globalThis.fetch, timeoutMs, apiKey = process.env.JEV_API_KEY, model } = {}) {
  if (!apiKey) throw new Error('no JEV_API_KEY');
  const cfg = routerConfig();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs ?? cfg.timeout_ms);
  const started = Date.now();
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ state, model: model ?? cfg.model, questions }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`jev ${res.status}${res.text ? ' ' + (await res.text().catch(() => '')).slice(0, 300) : ''}`.trimEnd());
    const body = await res.json();
    return {
      answers: body?.answers || {},
      usage: body?.usage ?? null,
      requestId: res.headers?.get?.('x-typesafe-request-id') ?? null,
      ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

// The garbage check: its own request, with the two nouls and nothing else. It is separate from
// the intent request on purpose — it runs first, only for short recordings, and a turn it drops
// never reaches the intent question at all. Both nouls ride in ONE request to save a round trip;
// they are read sequentially in garbageCheck, addressed first.
export async function checkGarbage(state, opts = {}) {
  const r = await ask(state, {
    addressed_to_jarvis: { type: 'noul', ...ADDRESSED },
    complete_utterance: { type: 'noul', ...COMPLETE },
  }, opts);
  // A noul answers with the probability of yes. Anything missing or malformed means "yes":
  // the gate can only ever drop a turn on a real, confident answer.
  const p = (k) => { const n = Number(r.answers[k]?.noul); return Number.isFinite(n) ? n : null; };
  return { ...r, addressed: p('addressed_to_jarvis'), complete: p('complete_utterance') };
}

export async function classify(state, opts = {}) {
  const r = await ask(state, { intent: { type: 'choice', ...INTENT }, tv_action: { type: 'choice', ...TV_ACTION }, level: LEVEL }, opts);
  const a = r.answers;
  const intent = a.intent?.choice;
  if (!intent || !(intent in INTENT.criteria)) throw new Error('jev returned no intent');
  return {
    intent,
    confidence: Number(a.intent?.confidence ?? 0),
    tv_action: a.tv_action?.choice,
    level: Number.isFinite(Number(a.level?.score)) ? Math.round(Number(a.level.score) * 2) * 5 : undefined,
    probabilities: a.intent?.probabilities,
    ms: r.ms,
    // Kept whole for the trace: every label's probability, what the account was charged, and
    // the id to quote to TypeSafe if an answer ever looks wrong.
    answers: a,
    usage: r.usage,
    requestId: r.requestId,
  };
}

// What Jev is shown. Short on purpose: the transcript tail is what disambiguates "turn it off".
// Opens the TLS connection to Jev once at startup so the first real turn is not spent on DNS and
// the handshake (measured: a cold call blows the 800 ms budget, a warm one takes ~350 ms). Node's
// fetch keeps the connection alive afterwards. Any failure is only logged; the router falls
// through to Claude on its own.
export const warm = async ({ fetchImpl = globalThis.fetch, apiKey = process.env.JEV_API_KEY } = {}) => {
  if (!apiKey || routerMode() === 'off') return null;
  const started = Date.now();
  const res = await fetchImpl(ENDPOINT.replace(/\/systemone$/, '/models'), { headers: { authorization: `Bearer ${apiKey}` } });
  return { status: res.status, ms: Date.now() - started };
};

export const buildState = ({ text, lang, away, tvOn, sessions = [], recent = [] }) => [
  `The user said (language: ${lang === 'he' ? 'Hebrew' : 'English'}): ${JSON.stringify(text)}`,
  `Away mode is currently ${away ? 'on' : 'off'}.`,
  tvOn === null || tvOn === undefined ? 'TV power state unknown.' : `The TV is currently ${tvOn ? 'on' : 'off'}.`,
  sessions.length ? `Live agent sessions: ${sessions.join(', ')}.` : 'No other agent sessions are known.',
  // The last exchanges, both sides: a bare "yes" only makes sense next to what was asked.
  recent.length ? `Recent exchanges:\n${recentLines(recent)}` : '',
].filter(Boolean).join('\n');

const recentLines = (recent) => recent.map((r) => (typeof r === 'string' ? `- user: ${r}` : `- user: ${r.user}\n  jarvis: ${r.agent || '(no reply recorded)'}`)).join('\n');

// What the garbage check is shown: the text, how long the recording actually was, and what the
// transcriber itself thought it heard. A confident word list and a detected language the speaker
// actually speaks mean speech; 0.2-probability word soup in Welsh means whisper filled silence.
// no_speech_prob is deliberately left out — it is misleading on short clips (Liran, 2026-09-21).
export const buildGarbageState = ({ text, lang, duration, words = [], avgLogprob, language, languageP, recent = [] }) => [
  `The user's recording was transcribed as (script looks like ${lang === 'he' ? 'Hebrew' : 'English'}): ${JSON.stringify(text)}`,
  duration == null ? '' : `The recording is ${duration.toFixed(2)} seconds long.`,
  words.length ? `Transcriber word probabilities: ${words.map((w) => `${w.word} ${Number(w.p).toFixed(2)}`).join(', ')}` : '',
  avgLogprob == null ? '' : `Average log probability of the transcription: ${Number(avgLogprob).toFixed(3)}.`,
  language ? `The transcriber detected the language as ${language}${languageP == null ? '' : ` with probability ${Number(languageP).toFixed(2)}`}.` : '',
  recent.length ? `Recent exchanges:\n${recentLines(recent)}` : '',
].filter(Boolean).join('\n');

// ---------- tv-remote ----------
// The same JSON API the `tv` CLI and the key bindings use: POST /api/run/<capability> {args}.
// Capability names are tv-remote's own (lib/capabilities.mjs), not ours.
export async function tvRun(name, args = {}, { fetchImpl = globalThis.fetch, timeoutMs = 45000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${TV_API}/api/run/${name}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }), signal: ac.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.error) throw new Error(body?.error || `tv ${res.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// TV power, cached 30 s. Never awaited on the turn's own path: a sleeping TV (or a stopped
// tv-remote service) takes seconds to answer, and this value only colours the question Jev is
// asked. So the caller gets what is known now and the refresh lands for the next turn.
let tvCache = { at: 0, on: null, refreshing: false };
export function tvIsOn({ fetchImpl = globalThis.fetch, now = Date.now(), ttlMs = 30000 } = {}) {
  if (now - tvCache.at >= ttlMs && !tvCache.refreshing) {
    tvCache.refreshing = true;
    tvRun('status', {}, { fetchImpl, timeoutMs: 2000 })
      .then((s) => { tvCache = { at: Date.now(), on: Boolean(s.power ?? true), refreshing: false }; })
      .catch(() => { tvCache = { at: Date.now(), on: null, refreshing: false }; });
  }
  return tvCache.on;
}
export const resetTvCache = () => { tvCache = { at: 0, on: null }; };

// ---------- the six procedures ----------
// Each one returns what the server should do with the turn:
//   { say, after? } speak this fixed line (then run `after`), log the turn, no Claude at all
//   { claudeText }  run Claude, but on a fixed instruction instead of the user's words
//   null            not ours after all: the turn goes to Claude untouched
// `ctx` gives them the few things the server owns: setAway (writes AWAY_FILE), log, fetchImpl.
const TV_CALL = {
  mute: () => ['mute', { muted: true }],
  unmute: () => ['mute', { muted: false }],
  volume_up: () => ['volume_up', { steps: 1 }],
  volume_down: () => ['volume_down', { steps: 1 }],
  volume_set: (d) => ['volume_set', { level: Math.max(0, Math.min(100, Math.round((d.level ?? 0) / 5) * 5)) }],
  power_off: () => ['power_off', {}],
  power_on: () => ['power_on', {}],
  hdmi1: () => ['hdmi1', {}],
};

export const procedures = {
  // Say it, then write the flag: the confirmation has to be heard on this machine's speakers,
  // and away mode is exactly what silences them (jarvis.md).
  // `after` runs once the line has been spoken — that is the whole point of the ordering here.
  // This machine's speakers are the TV over HDMI, so the line must have finished playing here
  // before the TV goes off: `waitForSpeakers` makes the server drain local playback first.
  away_on(decision, ctx) {
    return {
      say: line('away_on', ctx.lang),
      waitForSpeakers: true,
      after: async () => {
        ctx.setAway(true);
        try { await tvRun('power_off', {}, { fetchImpl: ctx.fetchImpl }); } catch (e) { ctx.log?.(`router: tv power_off failed: ${e.message}`); }
      },
    };
  },
  // Coming back is the mirror: TV on and on the computer's input, flag cleared, then speak.
  async away_off(decision, ctx) {
    ctx.setAway(false);
    try {
      await tvRun('hdmi1', {}, { fetchImpl: ctx.fetchImpl });
      // hdmi1 returns once the input is up; the HDMI audio path needs a moment more before the
      // spoken line is audible here, so give it TV_SETTLE_MS before speaking.
      await new Promise((r) => setTimeout(r, ctx.settleMs ?? routerConfig().tv_settle_ms));
    } catch (e) { ctx.log?.(`router: tv hdmi1 failed: ${e.message}`); }
    return { say: line('away_off', ctx.lang) };
  },
  async tv(decision, ctx) {
    const make = TV_CALL[decision.tv_action];
    if (!make) return null;   // `other`, or a label we don't run: Claude takes it
    const [name, args] = make(decision);
    try {
      await tvRun(name, args, { fetchImpl: ctx.fetchImpl });
    } catch (e) {
      ctx.log?.(`router: tv ${name} failed: ${e.message}`);
      return { say: line('tv.failed', ctx.lang) };
    }
    return { say: line(`tv.${decision.tv_action}`, ctx.lang, { level: args.level }) };
  },
  // Relay is still a Claude turn: ListAgents/SendMessage live inside the Claude process, so the
  // server can decide *that* relay should start but not carry out the hand-off. What the router
  // buys here is a deterministic instruction instead of an open-ended one.
  relay_on(decision, ctx) {
    return { claudeText: `The user asked to enter relay mode. Their exact words: ${JSON.stringify(ctx.text)}. Follow .claude/skills/relay-mode/SKILL.md: resolve the session they named with ListAgents, then start relaying. Do nothing else this turn.` };
  },
  relay_off(decision, ctx) {
    return { claudeText: `The user asked to leave relay mode. Their exact words: ${JSON.stringify(ctx.text)}. Follow .claude/skills/relay-mode/SKILL.md and end relay mode now. Do nothing else this turn.` };
  },
  conversation() { return null; },
};

// The garbage gate for one turn: its own Jev request, asked only for a short recording, before
// the intent request exists. Returns { mode, drop, addressed, garbage } — `garbage` is the trace
// block, kept even when the call failed. Failure-proof in the same way as routeTurn: anything at
// all going wrong means "not dropped", and the turn carries on to the intent question.
export async function garbageCheck(input, ctx = {}) {
  const mode = ctx.mode || routerMode();
  if (mode === 'off') return { mode, drop: false, addressed: null, garbage: null };
  const state = buildGarbageState(input);
  const t0 = Date.now();
  // The evidence is repeated in the trace so a reading of router.jsonl does not have to re-parse
  // the prose state to see what whisper actually reported.
  const garbage = {
    state, sent_at: new Date(t0).toISOString(),
    words: input.words ?? null, avg_logprob: input.avgLogprob ?? null,
    language: input.language ?? null, language_p: input.languageP ?? null,
  };
  let r = null;
  try {
    r = await checkGarbage(state, { fetchImpl: ctx.fetchImpl, apiKey: ctx.apiKey });
  } catch (e) {
    garbage.done_at = new Date().toISOString();
    garbage.ms = Date.now() - t0;
    garbage.error = e.name === 'AbortError' ? `timeout after ${garbage.ms}ms` : e.message;
    ctx.log?.(`router: garbage check unavailable (${garbage.error}), keeping the turn`);
    return { mode, drop: false, reason: null, addressed: null, complete: null, garbage };
  }
  garbage.done_at = new Date().toISOString();
  garbage.ms = r.ms;
  garbage.addressed = r.addressed;
  garbage.complete = r.complete;
  garbage.usage = r.usage;
  garbage.request_id = r.requestId;
  const keep = (reason = null) => ({ mode, drop: false, reason, addressed: r.addressed, complete: r.complete, garbage });
  // Sequential, in this order: garbage wins over fragment, so a scramble is reported as garbage
  // even when it is also a fragment.
  const verdict = (reason, what) => {
    if (mode !== 'on') {
      ctx.log?.(`router: would drop (${what}) ${JSON.stringify(input.text)}`);
      return keep();
    }
    ctx.log?.(`router: dropped (${what}) ${JSON.stringify(input.text)}`);
    return { mode, drop: true, reason, addressed: r.addressed, complete: r.complete, garbage };
  };
  const a = r.addressed;
  if (a != null && a < 1 - (ctx.dropMin ?? dropMin())) return verdict('garbage', `not addressed p=${a.toFixed(2)}`);
  const c = r.complete;
  if (c != null && c < 1 - (ctx.fragmentMin ?? fragmentMin())) return verdict('fragment', `fragment p=${c.toFixed(2)}`);
  return keep();
}

// The whole decision for one turn, failure-proof. Returns { mode, decision, action, error, jev }
// — `action` is null in shadow mode, below the threshold, or whenever anything at all went
// wrong; `jev` is the raw record for the trace (the exact state sent, every probability, usage,
// the request id, latency, the error if there was one), kept even when the call failed.
export async function routeTurn(input, ctx = {}) {
  const mode = ctx.mode || routerMode();
  if (mode === 'off') return { mode, decision: null, action: null, jev: null };
  const state = buildState(input);
  const t0 = Date.now();
  const jev = { state, sent_at: new Date(t0).toISOString() };
  let decision = null;
  try {
    decision = await classify(state, { fetchImpl: ctx.fetchImpl, apiKey: ctx.apiKey });
  } catch (e) {
    jev.done_at = new Date().toISOString();
    jev.ms = Date.now() - t0;
    jev.error = e.name === 'AbortError' ? `timeout after ${jev.ms}ms` : e.message;
    ctx.log?.(`router: jev unavailable (${jev.error}), going to Claude`);
    return { mode, decision: null, action: null, error: jev.error, jev };
  }
  jev.done_at = new Date().toISOString();
  jev.ms = decision.ms;
  jev.answers = decision.answers;
  jev.usage = decision.usage;
  jev.request_id = decision.requestId;
  if (mode !== 'on') return { mode, decision, action: null, jev };
  if (decision.intent === 'conversation' || decision.confidence < (ctx.min ?? routeMin())) return { mode, decision, action: null, jev };
  let action = null;
  try {
    action = await procedures[decision.intent](decision, { ...ctx, lang: input.lang, text: input.text });
  } catch (e) {
    ctx.log?.(`router: procedure ${decision.intent} failed: ${e.message}`);
    return { mode, decision, action: null, error: e.message, jev };
  }
  return { mode, decision, action, jev };
}

// The trace log: one line per turn — the full chain from the text being ready to what Claude
// did. bin/router-report reads it back against transcript.jsonl.
export const logRouterTurn = (file, entry) => {
  try { fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); } catch {}
};
