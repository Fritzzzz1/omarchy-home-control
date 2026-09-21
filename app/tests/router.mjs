// The Jev router against a fake Jev: a label/confidence table to the path each one takes, plus
// the two ways Jev can be absent (timeout, no key) — both of which must end at Claude.
// No network, no tv-remote: every fetch in here is ours.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { routeTurn, garbageCheck, classify, checkGarbage, line, procedures, resetTvCache, buildState, buildGarbageState, wavDurationS, shortMaxS, liveSessions } from '../router.mjs';

const input = { text: 'mute the TV', lang: 'en', away: false, tvOn: true };

// A fetch that answers as Jev does, and records the TV calls it is asked to make.
const fakeJev = (answers, { tvCalls = [], jevDelay = 0, tvFails = false } = {}) => async (url, opts) => {
  if (String(url).includes('typesafe')) {
    assert.equal(opts.headers['authorization'], 'Bearer test-key');
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'jev-latest');
    assert.equal(body.questions.intent.type, 'choice');
    assert.ok(body.questions.intent.criteria.away_on, 'criteria map is sent');
    // The intent request is the original one: the garbage noul rides in its own request now.
    assert.equal(body.questions.addressed_to_jarvis, undefined);
    assert.equal(body.questions.complete_utterance, undefined);
    assert.deepEqual(Object.keys(body.questions), ['intent', 'tv_action', 'level']);
    assert.ok(body.state.includes('mute') || body.state.length > 0);
    if (jevDelay) await new Promise((r, reject) => { const t = setTimeout(r, jevDelay); opts.signal?.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }); });
    return { ok: true, headers: { get: () => 'req-1' }, json: async () => ({ model: 'jev-latest', answers, usage: { input_tokens: 42, output_tokens: 0 } }) };
  }
  // tv-remote
  tvCalls.push([String(url).split('/api/run/')[1], JSON.parse(opts.body).args]);
  if (tvFails) return { ok: false, status: 500, json: async () => ({ error: 'tv unreachable' }) };
  return { ok: true, json: async () => ({ ok: true }) };
};
const choice = (c, confidence, extra = {}) => ({ intent: { type: 'choice', choice: c, confidence, probabilities: { [c]: confidence } }, ...extra });
const run = (answers, opts = {}, ctx = {}) => {
  resetTvCache();
  const tvCalls = [];
  return routeTurn(input, { mode: 'on', apiKey: 'test-key', fetchImpl: fakeJev(answers, { ...opts, tvCalls }), setAway: () => {}, settleMs: 0, ...ctx })
    .then((r) => ({ ...r, tvCalls }));
};

// ---- the table: label + confidence -> what happens
{
  const away = [];
  const r = await run(choice('away_on', 0.97), {}, { setAway: (v) => away.push(v) });
  assert.equal(r.routed ?? r.decision.intent, 'away_on');
  assert.equal(r.action.say, line('away_on', 'en'));
  assert.equal(r.action.waitForSpeakers, true); // the server drains this machine's playback first
  assert.deepEqual(away, []);                 // nothing written before the line is spoken
  await r.action.after();
  assert.deepEqual(away, [true]);
  assert.deepEqual(r.tvCalls, [['power_off', {}]]);
}
{
  const away = [];
  const r = await run(choice('away_off', 0.9), {}, { setAway: (v) => away.push(v) });
  assert.equal(r.action.say, line('away_off', 'en'));
  assert.deepEqual(away, [false]);
  assert.deepEqual(r.tvCalls, [['hdmi1', {}]]);
}
{
  const r = await run(choice('tv', 0.93, { tv_action: { type: 'choice', choice: 'mute', confidence: 0.99 } }));
  assert.deepEqual(r.tvCalls, [['mute', { muted: true }]]);
  assert.equal(r.action.say, 'TV muted.');
}
{
  const r = await run(choice('tv', 0.93, { tv_action: { type: 'choice', choice: 'volume_set', confidence: 0.95 }, level: { type: 'score', score: 1.7 } }));   // rubric index: 1.7 × 10 = 17
  assert.deepEqual(r.tvCalls, [['volume_set', { level: 15 }]]);   // snapped to a step of 5
  assert.equal(r.action.say, 'Volume 15.');
}
{
  // tv-remote down: still routed, but the fixed failure line — never a made-up reply
  const r = await run(choice('tv', 0.93, { tv_action: { type: 'choice', choice: 'mute', confidence: 0.99 } }), { tvFails: true });
  assert.equal(r.action.say, line('tv.failed', 'en'));
}
{
  // `other` is not ours: no TV call, and the turn goes to Claude
  const r = await run(choice('tv', 0.95, { tv_action: { type: 'choice', choice: 'other', confidence: 0.9 } }));
  assert.equal(r.action, null);
  assert.deepEqual(r.tvCalls, []);
}
{
  const r = await run(choice('relay_on', 0.91));
  assert.ok(r.action.claudeText.includes('relay-mode'), 'relay hands Claude the skill, not a spoken line');
  assert.equal(r.action.say, undefined);
}
{
  const r = await run(choice('relay_off', 0.91));
  assert.ok(r.action.claudeText.includes('end relay mode'));
}
{
  const r = await run(choice('conversation', 0.99));
  assert.equal(r.action, null);               // the common case: Claude, untouched
}
{
  // below the threshold: Jev answered, nothing is routed
  const r = await run(choice('tv', 0.6, { tv_action: { type: 'choice', choice: 'mute', confidence: 0.6 } }));
  assert.equal(r.action, null);
  assert.deepEqual(r.tvCalls, []);
  assert.equal(r.decision.intent, 'tv');      // still logged, so shadow mode can be read back
}
{
  // shadow: asked, logged, never routed
  const r = await run(choice('tv', 0.99, { tv_action: { type: 'choice', choice: 'mute', confidence: 0.99 } }), {}, { mode: 'shadow' });
  assert.equal(r.action, null);
  assert.equal(r.decision.confidence, 0.99);
  assert.deepEqual(r.tvCalls, []);
}
{
  // off: no call at all
  const r = await routeTurn(input, { mode: 'off', apiKey: 'test-key', fetchImpl: () => { throw new Error('must not be called'); } });
  assert.equal(r.decision, null);
  assert.equal(r.jev, null);
}

// ---- the WAV duration gate: measured from the header, before a byte reaches whisper
const wav = (seconds, { rate = 16000, bits = 16, channels = 1, extraChunk = false } = {}) => {
  const byteRate = rate * channels * (bits / 8);
  const dataBytes = Math.round(seconds * byteRate);
  const extra = extraChunk ? 8 + 4 : 0;                 // a LIST chunk sitting before `data`
  const buf = Buffer.alloc(44 + extra + dataBytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(buf.length - 8, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(byteRate, 28); buf.writeUInt16LE(channels * bits / 8, 32); buf.writeUInt16LE(bits, 34);
  let off = 36;
  if (extraChunk) { buf.write('LIST', off); buf.writeUInt32LE(4, off + 4); off += 12; }
  buf.write('data', off); buf.writeUInt32LE(dataBytes, off + 4);
  return buf;
};
{
  assert.equal(Math.round(wavDurationS(wav(1.2)) * 100) / 100, 1.2);
  assert.equal(Math.round(wavDurationS(wav(5)) * 100) / 100, 5);
  assert.equal(Math.round(wavDurationS(wav(2, { rate: 48000, channels: 2 })) * 100) / 100, 2);  // header, not assumption
  assert.equal(Math.round(wavDurationS(wav(0.8, { extraChunk: true })) * 100) / 100, 0.8);      // chunks are walked
  assert.equal(wavDurationS(Buffer.from('not a wav at all, really not')), null);
  assert.equal(wavDurationS(null), null);
}
{
  // verbose vs json is chosen by that duration against short_max_s: under it, short.
  const short = (buf) => { const d = wavDurationS(buf); return d != null && d < shortMaxS(); };
  assert.equal(shortMaxS(), 3);
  assert.equal(short(wav(1.2)), true);      // -> verbose_json
  assert.equal(short(wav(5)), false);       // -> json, exactly as before
  assert.equal(short(wav(3.0)), false);     // the bound is exclusive
}

// ---- the garbage check: its own request, only the noul, the evidence in its state
const garbageInput = {
  text: 'mute the TV', lang: 'en', duration: 1.24,
  words: [{ word: 'mute', p: 0.91 }, { word: 'the', p: 0.88 }, { word: 'TV', p: 0.76 }],
  avgLogprob: -0.31, language: 'en', languageP: 0.98,
  recent: [{ user: 'is the TV loud?', agent: 'A little.' }],
};
// The fake answers both nouls. `noul` is the addressed probability; `complete` defaults to 0.99
// so a test that only cares about the first gate is never tripped by the second.
const fakeGarbage = (noul, { seen = {}, fail = null, complete = 0.99 } = {}) => async (url, opts) => {
  if (fail) throw fail;
  seen.body = JSON.parse(opts.body);
  const answers = {};
  if (noul !== null) answers.addressed_to_jarvis = { type: 'noul', noul };
  if (complete !== null) answers.complete_utterance = { type: 'noul', noul: complete };
  return { ok: true, headers: { get: () => 'g-1' }, json: async () => ({ answers, usage: { input_tokens: 11, output_tokens: 0 } }) };
};
const gate = (noul, ctx = {}, opts = {}) => garbageCheck(garbageInput, { mode: 'on', apiKey: 'test-key', fetchImpl: fakeGarbage(noul, opts), ...ctx });
{
  const seen = {};
  const r = await gate(0.95, {}, { seen });
  // only the noul, nothing else
  assert.deepEqual(Object.keys(seen.body.questions), ['addressed_to_jarvis', 'complete_utterance']);
  assert.equal(seen.body.questions.complete_utterance.type, 'noul');
  assert.equal(seen.body.questions.addressed_to_jarvis.type, 'noul');
  assert.ok(seen.body.questions.addressed_to_jarvis.criteria.true.includes('readable English or Hebrew'));
  assert.ok(seen.body.questions.addressed_to_jarvis.criteria.false.includes('Unreadable'));
  assert.ok(seen.body.questions.addressed_to_jarvis.instructions.includes('per-word probabilities'));
  // the second noul judges meaning, never length: a reply needs the exchange it answers
  const ci = seen.body.questions.complete_utterance.instructions;
  assert.ok(ci.includes('Judge by meaning, not by length'), ci);
  assert.ok(ci.includes('recent exchanges'), ci);
  assert.ok(!/\b(one|two|three) words?\b/.test(ci), ci);
  assert.ok(seen.body.questions.complete_utterance.criteria.true.includes('recent exchanges'));
  assert.ok(seen.body.questions.complete_utterance.criteria.false.includes('no recent exchange'));
  // and the evidence is in its state
  const st = seen.body.state;
  assert.ok(st.includes('1.24 seconds'), st);
  assert.ok(st.includes('mute 0.91'), st);
  assert.ok(st.includes('-0.310'), st);
  assert.ok(st.includes('detected the language as en with probability 0.98'), st);
  assert.ok(st.includes('jarvis: A little.'), st);
  assert.ok(!st.includes('no_speech'), 'no_speech_prob is misleading and is never sent');
  // readable speech passes, and the trace keeps the evidence next to the answer
  assert.equal(r.drop, false);
  assert.equal(r.addressed, 0.95);
  assert.equal(r.complete, 0.99);
  assert.equal(r.garbage.complete, 0.99);
  assert.equal(r.reason, null);
  assert.equal(r.garbage.request_id, 'g-1');
  assert.deepEqual(r.garbage.usage, { input_tokens: 11, output_tokens: 0 });
  assert.deepEqual(r.garbage.words, garbageInput.words);
  assert.equal(r.garbage.avg_logprob, -0.31);
  assert.equal(r.garbage.language, 'en');
  assert.equal(r.garbage.language_p, 0.98);
  assert.ok(typeof r.garbage.ms === 'number' && r.garbage.sent_at && r.garbage.done_at);
}
{
  // whisper garbage: dropped, with the reason logged
  const logs = [];
  const r = await gate(0.02, { log: (m) => logs.push(m) });
  assert.equal(r.drop, true);
  assert.equal(r.reason, 'garbage');
  assert.ok(logs.some((m) => m === 'router: dropped (not addressed p=0.02) "mute the TV"'), logs.join(' | '));
}
{
  // both nouls say drop: the addressed gate is read first and wins the reason
  const logs = [];
  const r = await gate(0.02, { log: (m) => logs.push(m) }, { complete: 0.01 });
  assert.equal(r.drop, true);
  assert.equal(r.reason, 'garbage');
  assert.ok(logs.some((m) => m.includes('not addressed')), logs.join(' | '));
  assert.ok(!logs.some((m) => m.includes('fragment')), logs.join(' | '));
}
{
  // readable speech that is only a fragment: dropped, with its own reason
  const logs = [];
  const r = await gate(0.95, { log: (m) => logs.push(m) }, { complete: 0.31 });
  assert.equal(r.drop, true);
  assert.equal(r.reason, 'fragment');
  assert.equal(r.complete, 0.31);
  assert.ok(logs.some((m) => m === 'router: dropped (fragment p=0.31) "mute the TV"'), logs.join(' | '));
}
{
  // the same in shadow: the fragment is only logged
  const logs = [];
  const r = await gate(0.95, { mode: 'shadow', log: (m) => logs.push(m) }, { complete: 0.31 });
  assert.equal(r.drop, false);
  assert.equal(r.complete, 0.31);
  assert.ok(logs.some((m) => m === 'router: would drop (fragment p=0.31) "mute the TV"'), logs.join(' | '));
}
{
  // the fragment gate needs the same certainty as the other one: 0.5 is not enough, and a
  // missing complete_utterance answer can never drop a turn
  assert.equal((await gate(0.95, {}, { complete: 0.5 })).drop, false);
  const none = await gate(0.95, {}, { complete: null });
  assert.equal(none.drop, false);
  assert.equal(none.complete, null);
}
{
  // Liran's rule: a reply or reference is complete only next to the exchange it belongs to; an
  // utterance with its own meaning stands alone. Jev makes the judgement; what is pinned here is
  // that the state carries what it needs and that each verdict reaches the right outcome.
  const withRecent = { ...garbageInput, text: 'yes', recent: [{ user: 'is the TV loud?', agent: 'Shall I mute it?' }] };
  const cold = { ...garbageInput, text: 'yes', recent: [] };
  const run = (input, complete) => garbageCheck(input, { mode: 'on', apiKey: 'test-key', fetchImpl: fakeGarbage(0.95, { complete }) });
  // "yes" answering what was just asked: complete, so it passes
  assert.equal((await run(withRecent, 0.93)).drop, false);
  // "yes" with nothing to answer: a fragment, dropped
  const r1 = await run(cold, 0.08);
  assert.equal(r1.drop, true);
  assert.equal(r1.reason, 'fragment');
  // a cold reference with nothing to refer to ("why is that?") drops too
  const r2 = await run({ ...cold, text: 'Why is that?' }, 0.27);
  assert.equal(r2.drop, true);
  assert.equal(r2.reason, 'fragment');
  // an utterance with its own meaning passes cold, whatever its length
  assert.equal((await run({ ...cold, text: 'mute the TV please' }, 0.96)).drop, false);
  assert.equal((await run({ ...cold, text: 'mute' }, 0.77)).drop, false);
  // the state says either way whether there is anything to relate to
  assert.ok(buildGarbageState(withRecent).includes('Recent exchanges'));
  assert.ok(!buildGarbageState(cold).includes('Recent exchanges'));
}
{
  // the same in shadow: logged as would-drop, never dropped
  const logs = [];
  const r = await gate(0.02, { mode: 'shadow', log: (m) => logs.push(m) });
  assert.equal(r.drop, false);
  assert.equal(r.addressed, 0.02);
  assert.ok(logs.some((m) => m.startsWith('router: would drop')), logs.join(' | '));
}
{
  // unsure is not sure enough, and a missing noul never drops
  assert.equal((await gate(0.5)).drop, false);
  const none = await gate(null);
  assert.equal(none.drop, false);
  assert.equal(none.addressed, null);
}
{
  // mode off: no call at all, no trace
  const r = await garbageCheck(garbageInput, { mode: 'off', fetchImpl: () => { throw new Error('must not be called'); } });
  assert.equal(r.drop, false);
  assert.equal(r.garbage, null);
}
{
  // the check itself failing is never a drop: the turn falls through to the intent request
  const logs = [];
  const r = await gate(0.02, { log: (m) => logs.push(m) }, { fail: Object.assign(new Error('aborted'), { name: 'AbortError' }) });
  assert.equal(r.drop, false);
  assert.equal(r.addressed, null);
  assert.ok(r.garbage.error.startsWith('timeout after'), r.garbage.error);
  assert.ok(logs.some((m) => m.includes('garbage check unavailable')), logs.join(' | '));
  assert.ok(r.garbage.state.length > 0);   // the trace still says what would have been asked
  const noKey = await garbageCheck(garbageInput, { mode: 'on', apiKey: '', fetchImpl: () => { throw new Error('must not be called'); } });
  assert.equal(noKey.drop, false);
  assert.equal(noKey.garbage.error, 'no JEV_API_KEY');
}
{
  // a garbage state with no evidence at all (whisper gave none) still reads
  const st = buildGarbageState({ text: 'yes', lang: 'en', duration: 0.6 });
  assert.ok(st.includes('0.60 seconds'));
  assert.ok(!st.includes('word probabilities'));
}
{
  // checkGarbage on its own: request shape and endpoint
  let seen = null;
  const r = await checkGarbage('a state string', { apiKey: 'test-key', fetchImpl: async (url, opts) => { seen = { url, opts }; return { ok: true, headers: { get: () => null }, json: async () => ({ answers: { addressed_to_jarvis: { noul: 0.7 }, complete_utterance: { noul: 0.4 } } }) }; } });
  assert.equal(seen.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(seen.opts.headers['authorization'], 'Bearer test-key');
  assert.equal(JSON.parse(seen.opts.body).state, 'a state string');
  assert.equal(JSON.parse(seen.opts.body).model, 'jev-latest');
  assert.equal(r.addressed, 0.7);
  assert.equal(r.complete, 0.4);
}

// ---- live config: a JSON file next to router.jsonl, file > env > default, re-read by mtime
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'router-cfg-'));
  const file = path.join(dir, 'router.json');
  process.env.VOICE_STATE = dir;
  process.env.JEV_ROUTER = 'shadow';
  process.env.JEV_ROUTE_MIN = '0.7';
  process.env.JEV_FRAGMENT_MIN = '0.5';
  // a fresh module instance, so STATE_DIR picks up VOICE_STATE
  const cfgMod = await import('../router.mjs?live-config');
  const logs = [];
  cfgMod.setRouterLog((m) => logs.push(m));

  // no file: env, then defaults
  assert.equal(cfgMod.routerConfig().mode, 'shadow');
  assert.equal(cfgMod.routerConfig().route_min, 0.7);
  assert.equal(cfgMod.routerConfig().drop_min, 0.9);
  assert.equal(cfgMod.routerConfig().fragment_min, 0.5);   // env
  assert.equal(cfgMod.routerConfig().short_max_s, 3);
  assert.equal(cfgMod.routerConfig().model, 'jev-latest');

  // the file wins, key by key, and the keys it omits still come from env/defaults
  fs.writeFileSync(file, JSON.stringify({ mode: 'on', drop_min: 0.8, fragment_min: 0.7, short_max_s: 2.5, model: 'jev-preview', timeout_ms: 900, tv_settle_ms: 1000 }));
  const c = cfgMod.routerConfig();
  assert.equal(c.mode, 'on');
  assert.equal(c.route_min, 0.7);        // not in the file: env
  assert.equal(c.drop_min, 0.8);
  assert.equal(c.fragment_min, 0.7);     // file over env
  assert.equal(c.short_max_s, 2.5);
  assert.equal(c.model, 'jev-preview');
  assert.equal(c.timeout_ms, 900);
  assert.equal(c.tv_settle_ms, 1000);
  assert.equal(cfgMod.routerMode(), 'on');
  assert.equal(cfgMod.shortMaxS(), 2.5);

  // a typo keeps the last good values and says so exactly once
  fs.writeFileSync(file, '{ mode: on }');
  assert.equal(cfgMod.routerConfig().mode, 'on');
  assert.equal(cfgMod.routerConfig().drop_min, 0.8);   // NOT back to the default
  assert.equal(logs.filter((m) => m.includes('unreadable')).length, 1, logs.join(' | '));
  assert.ok(logs[0].includes('keeping last good config'), logs[0]);

  // a nonsense value for one key falls back for that key only
  fs.writeFileSync(file, JSON.stringify({ mode: 'sideways', drop_min: 7, fragment_min: 'x', short_max_s: 1.5 }));
  const d = cfgMod.routerConfig();
  assert.equal(d.mode, 'shadow');        // env again
  assert.equal(d.drop_min, 0.9);         // default again
  assert.equal(d.fragment_min, 0.5);     // env again
  assert.equal(d.short_max_s, 1.5);

  // deleting the file goes back to env/defaults
  fs.rmSync(file);
  assert.equal(cfgMod.routerConfig().mode, 'shadow');
  assert.equal(cfgMod.routerConfig().drop_min, 0.9);
  delete process.env.JEV_FRAGMENT_MIN;
  assert.equal((await import('../router.mjs?frag-default')).routerConfig().fragment_min, 0.6);   // default
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.VOICE_STATE; delete process.env.JEV_ROUTER; delete process.env.JEV_ROUTE_MIN;
}

// ---- the state shows both sides of the last exchanges, so a bare "yes" has context
{
  const r = await routeTurn(
    { text: 'yes', lang: 'en', away: false, tvOn: true, recent: [{ user: 'should I turn the TV off?', agent: 'Want me to switch it off?' }] },
    { mode: 'shadow', apiKey: 'k', fetchImpl: async () => ({ ok: true, headers: { get: () => null }, json: async () => ({ answers: choice('conversation', 0.9) }) }) },
  );
  assert.ok(r.jev.state.includes('jarvis: Want me to switch it off?'), r.jev.state);
  assert.ok(r.jev.state.includes('user: should I turn the TV off?'));
}

// ---- the trace carries what the report needs
{
  const r = await run(choice('conversation', 0.99));
  assert.equal(r.jev.request_id, 'req-1');
  assert.deepEqual(r.jev.usage, { input_tokens: 42, output_tokens: 0 });
  assert.ok(r.jev.state.includes('mute the TV'));
  assert.ok(r.jev.answers.intent.probabilities);
  assert.ok(typeof r.jev.ms === 'number');
}

// ---- Jev absent: both paths end at Claude, with the reason kept
{
  // a fetch aborted by the 800 ms budget looks exactly like this to routeTurn
  const slow = await routeTurn(input, { mode: 'on', apiKey: 'test-key', fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } });
  assert.equal(slow.action, null);
  assert.equal(slow.decision, null);
  assert.ok(slow.jev.error.startsWith('timeout after'), slow.jev.error);
  assert.ok(slow.jev.state.length > 0);       // the trace still says what would have been asked
}
{
  const r = await routeTurn(input, { mode: 'on', apiKey: '', fetchImpl: () => { throw new Error('must not be called'); } });
  assert.equal(r.action, null);
  assert.equal(r.error, 'no JEV_API_KEY');
}
{
  // a 500, and a body with no intent: neither may throw out of routeTurn
  const bad = await routeTurn(input, { mode: 'on', apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  assert.equal(bad.error, 'jev 500');
  const empty = await routeTurn(input, { mode: 'on', apiKey: 'k', fetchImpl: async () => ({ ok: true, headers: { get: () => null }, json: async () => ({ answers: {} }) }) });
  assert.equal(empty.error, 'jev returned no intent');
}

// ---- the lines are fixed text, in both languages, and never empty
for (const key of ['away_on', 'away_off', 'tv.mute', 'tv.unmute', 'tv.volume_up', 'tv.volume_down', 'tv.power_off', 'tv.power_on', 'tv.hdmi1', 'tv.failed']) {
  for (const lang of ['he', 'en']) assert.ok(line(key, lang).length > 0, `${key}/${lang}`);
}
assert.equal(line('tv.volume_set', 'en', { level: 30 }), 'Volume 30.');
assert.ok(line('tv.volume_set', 'he', { level: 30 }).includes('30'));
assert.equal(procedures.conversation(), null);   // the common label has no procedure

// ---- classify's request shape, once, explicitly
{
  let seen = null;
  await classify('a state string', { apiKey: 'test-key', fetchImpl: async (url, opts) => { seen = { url, opts }; return { ok: true, headers: { get: () => null }, json: async () => ({ answers: choice('conversation', 1) }) }; } });
  assert.equal(seen.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(seen.opts.method, 'POST');
  assert.equal(seen.opts.headers['authorization'], 'Bearer test-key');
  assert.equal(JSON.parse(seen.opts.body).state, 'a state string');
}

{
  // Typed on the phone page: no duration, so the gate never runs and routeTurn cannot drop.
  const logs = [];
  const r = await routeTurn({ ...input, text: 'ksh tk brrr', typed: true }, { mode: 'on', apiKey: 'test-key', fetchImpl: fakeJev(choice('conversation', 0.99)), setAway: () => {}, log: (l) => logs.push(l) });
  assert.equal(r.action, null);
  assert.ok(!logs.some((l) => l.includes('drop')));
}
{
  // An exchange whose reply is not recorded yet still renders a readable placeholder.
  assert.ok(buildState({ text: 'yes', lang: 'en', away: false, tvOn: true, recent: [{ user: 'hi', agent: '' }] }).includes('(no reply recorded)'));
}
{
  // live sessions come from Claude Code's registry: dead pids and Jarvis's own dev-<n> are skipped
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sessions-'));
  const w = (f, d) => fs.writeFileSync(path.join(dir, f), JSON.stringify(d));
  w('1.json', { pid: 1, name: 'jev-integration-creator', cwd: '/home/x/dev', status: 'busy' });
  w('2.json', { pid: 2, name: 'omarchy-mobile', cwd: '/home/x/dev/projects/omarchy-mobile', status: 'idle' });
  w('3.json', { pid: 3, name: 'dev-69', cwd: '/home/x/dev' });
  w('4.json', { pid: 4, name: 'gone', cwd: '/home/x/dev' });
  fs.writeFileSync(path.join(dir, 'junk.json'), '{not json');
  const got = liveSessions({ dir, isAlive: (pid) => pid !== 4 });
  assert.deepEqual(got.map((x) => x.name), ['jev-integration-creator', 'omarchy-mobile']);
  assert.equal(got[1].folder, 'omarchy-mobile');
  assert.ok(buildState({ text: 'x', lang: 'en', away: false, tvOn: true, sessions: got }).includes('omarchy-mobile (omarchy-mobile)'));
  assert.deepEqual(liveSessions({ dir: path.join(dir, 'missing') }), []);
}
console.log('Passed: away on/off, tv actions and volume snapping, tv failure line, other/conversation/low confidence fall through, relay instructions, shadow and off, WAV duration from the header (rates, extra chunks, junk), short/long selection, the garbage check as its own request (both nouls in one request, whisper evidence in the state, no no_speech_prob, drop in on, would-drop in shadow, 0.5 and a missing noul never drop, a failure falls through), the fragment gate (addressed wins over fragment, fragment drop and shadow would-drop, one/two words only complete next to a matching exchange), the intent request carrying no noul, live config (file > env > default, per-key fallback, a typo keeps the last good values and warns once, deletion), both sides of recent exchanges in the state, trace fields, timeout and missing key, fixed lines, request shape');
