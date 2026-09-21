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
const MODEL = process.env.JEV_MODEL || 'jev-latest';
const TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS || 1500);
// Away mode timing: how long the TV gets to bring its HDMI audio up after hdmi1 before we speak,
// and the cap on waiting for this machine's playback to finish before the TV is switched off.
export const TV_SETTLE_MS = Number(process.env.JEV_TV_SETTLE_MS || 2000);
export const SPEAKERS_DRAIN_CAP_MS = 3000;
const TV_API = process.env.TV_SERVICE_URL || 'http://127.0.0.1:4470';

export const LINES = JSON.parse(fs.readFileSync(path.join(HERE, 'router-lines.json'), 'utf8'));

// off: no Jev call at all. shadow: ask and log, route nothing. on: route per the rule.
export const routerMode = () => {
  const v = String(process.env.JEV_ROUTER || '').trim().toLowerCase();
  return v === 'on' || v === 'shadow' ? v : 'off';
};
export const routeMin = () => {
  const n = Number(process.env.JEV_ROUTE_MIN);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : 0.85;
};

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
export async function classify(state, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, apiKey = process.env.JEV_API_KEY } = {}) {
  if (!apiKey) throw new Error('no JEV_API_KEY');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ state, model: MODEL, questions: { intent: { type: 'choice', ...INTENT }, tv_action: { type: 'choice', ...TV_ACTION }, level: LEVEL } }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`jev ${res.status}${res.text ? ' ' + (await res.text().catch(() => '')).slice(0, 300) : ''}`.trimEnd());
    const body = await res.json();
    const a = body?.answers || {};
    const intent = a.intent?.choice;
    if (!intent || !(intent in INTENT.criteria)) throw new Error('jev returned no intent');
    return {
      intent,
      confidence: Number(a.intent?.confidence ?? 0),
      tv_action: a.tv_action?.choice,
      level: Number.isFinite(Number(a.level?.score)) ? Math.round(Number(a.level.score) * 2) * 5 : undefined,
      probabilities: a.intent?.probabilities,
      ms: Date.now() - started,
      // Kept whole for the trace: every label's probability, what the account was charged, and
      // the id to quote to TypeSafe if an answer ever looks wrong.
      answers: a,
      usage: body?.usage ?? null,
      requestId: res.headers?.get?.('x-typesafe-request-id') ?? null,
    };
  } finally {
    clearTimeout(timer);
  }
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
  recent.length ? `Recent turns:\n${recent.map((r) => `- ${r}`).join('\n')}` : '',
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
      await new Promise((r) => setTimeout(r, ctx.settleMs ?? TV_SETTLE_MS));
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
