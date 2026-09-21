// The Jev router against a fake Jev: a label/confidence table to the path each one takes, plus
// the two ways Jev can be absent (timeout, no key) — both of which must end at Claude.
// No network, no tv-remote: every fetch in here is ours.
import assert from 'node:assert/strict';
import { routeTurn, classify, line, procedures, resetTvCache } from '../router.mjs';

const input = { text: 'mute the TV', lang: 'en', away: false, tvOn: true };

// A fetch that answers as Jev does, and records the TV calls it is asked to make.
const fakeJev = (answers, { tvCalls = [], jevDelay = 0, tvFails = false } = {}) => async (url, opts) => {
  if (String(url).includes('typesafe')) {
    assert.equal(opts.headers['authorization'], 'Bearer test-key');
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'jev-latest');
    assert.equal(body.questions.intent.type, 'choice');
    assert.ok(body.questions.intent.criteria.away_on, 'criteria map is sent');
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

console.log('Passed: away on/off, tv actions and volume snapping, tv failure line, other/conversation/low confidence fall through, relay instructions, shadow and off, trace fields, timeout and missing key, fixed lines, request shape');
