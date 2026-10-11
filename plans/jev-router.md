# Jev router — plan (branch `jev-router`, 2026-09-21)

A fast typed decision between transcription and the agent, so fixed procedures stop costing a
full Claude turn. Jev (TypeSafe AI, `POST https://api.typesafe.ai/v1/systemone`) answers one
Choice question per voice turn in 70–500 ms and never returns a value outside the list.

Read first: `CLAUDE.local.md` (how a turn flows), `~/dev/jarvis.md` (the away procedure),
`~/dev/.claude/skills/relay-mode/SKILL.md`.

## Scope of this branch

In: voice and typed turns arriving at `handleTurn` in `app/server.mjs`.
Out, parked: a session asking Jarvis for relay mode (arrives by SendMessage, not through the
server); relay mode as server state; anything Jev says below the threshold.

## The question

State: the transcript, the language, whether away is on, whether the TV is on (from tv-remote
`status`, cached 30 s), the list of live sessions (for relay).

Choice `intent`, one label, plus its confidence:

| label | example | what runs instead of Claude |
|---|---|---|
| `away_on` | "I'm leaving", "away mode on" | say the fixed line, write `{"away":true}`, `tv power_off` |
| `away_off` | "I'm back" | `tv power_on` + HDMI 1, write `{"away":false}`, say the fixed line |
| `tv` | "mute the TV", "volume 15", "switch to HDMI 1" | second Choice `tv_action` (see below) |
| `relay_on` | "relay mode with the mobile session" | resolve the session from ListAgents by name; hand Claude a fixed instruction "enter relay mode with <exact name>" (still a Claude turn in this branch, but a deterministic one) |
| `relay_off` | "relay mode off" | fixed instruction to Claude, same as above |
| `conversation` | everything else | Claude, exactly as today |

`tv_action`, asked only when `intent = tv`: `mute`, `unmute`, `volume_up`, `volume_down`,
`volume_set` (+ Score `level` 0–100 in steps of 5), `power_off`, `power_on`, `hdmi1`, `other`.
`other` falls through to Claude.

Fixed spoken lines live in `app/router-lines.json`, per language (he/en), so the router never
generates text.

## The rule

- Route only when `confidence >= JEV_ROUTE_MIN` (start 0.85) and the label is not
  `conversation`. Otherwise the turn goes to Claude untouched.
- Jev down, slow (> 800 ms), or key missing: log it, go to Claude. The router can never make a
  turn fail.
- Everything routed is still logged to `transcript.jsonl` with `agent: "<router:label>"` and
  `cost: 0`, so the dashboard's analytics keep working.
- The input hook (tailgather) runs for routed turns too; it fires before the router.

## Two switches in `config.env`

    JEV_API_KEY=...            # present
    JEV_ROUTER=shadow|on|off   # default off; this branch ships shadow

`shadow`: Jev is asked on every turn, its label and confidence are written to
`state/home/router.jsonl` next to the turn text, and nothing is routed. `on`: routing per the
rule above. `off`: no Jev call at all.

## Steps

1. `app/router.mjs`: `classify(state) → {intent, confidence, tv_action?, level?}` over the
   Jev endpoint, 1500 ms timeout, one place for the request shape. Wire format, taken from the
   official `@typesafe-ai/sdk` 0.6.0 (we call `fetch` directly, no dependency):

       POST https://api.typesafe.ai/v1/systemone      header Authorization: Bearer $JEV_API_KEY
       { "state": "<transcript + context>", "model": "jev-latest",
         "questions": { "intent": { "type": "choice", "instructions": "...",
                                    "criteria": { "away_on": "...", "tv": "...", ... } } } }
       → { "model": "...", "answers": { "intent": { "type": "choice", "choice": "tv",
             "confidence": 0.93, "probabilities": { "tv": 0.93, ... } } },
           "usage": { "input_tokens": n, "output_tokens": 0 } }

   Noul answers carry `noul` (probability of yes); Score answers carry `score` + `confidence`.
2. `handleTurn`: after `text` and `lang` exist and the input hook fired, call the router. In
   shadow, append to `router.jsonl` and continue. In `on`, dispatch on the label.
3. `app/router-lines.json` and the six procedures, each a small function that reuses what the
   server already has (`AWAY_FILE`, a direct call into `devices/tv/lib` (was tv-remote's `POST 127.0.0.1:4470/api/run/<capability>`)).
4. Phone page: a routed turn shows a small "routed: tv" tag on its row. Nothing else changes.
5. Tests in `app/tests`: the router with a fake Jev (label/confidence table → expected path),
   and a fallback test for timeout and missing key.

## Test plan

1. Shadow, for as long as Liran wants. `bin/router-report` shows each turn with Jev's label,
   confidence and latency next to what Claude actually did (from `transcript.jsonl`). The agent
   working on this branch reports the results in chat and they are discussed there; Liran
   decides when to flip the switch, and nothing flips on its own.
2. On a yes: `JEV_ROUTER=on`, restart, use it.
3. Measure against the current baseline in the dashboard analytics: median turn time and cost
   per turn, before and after.

## Why relay stays a Claude turn here

Jev returns labels, never actions: it cannot list sessions or send a message. `ListAgents` and
`SendMessage` are Claude Code tools that exist only inside the Claude process the server spawns,
and they are the only way to reach another session. The server can decide *that* relay should
start and *with whom*, but the hand-off itself still has to go through Claude. Making the server
own relay mode end to end is the parked next step.

## After this works (parked, Liran's call)

Once approved: a skill `add-jev-task` in `~/dev/.claude/skills/`, so any future agent can add a
Jev decision point to a new use case (question design, threshold, shadow log, report).

## Going live

The branch is tested by checking it out in this checkout and `home-control-ctl restart`
(the persona commit `22d77d3` on `dev` is its base). Back to `dev` or `main` when Liran decides.

## The drop gate (implemented 2026-09-21, sequential since 2026-09-21)

Not one request with an extra question: a **sequence**, so that each step only costs what it is
worth and a dropped turn stops dead.

1. **Duration gate.** The recording's length is read from the WAV header (data bytes / byte rate,
   chunks walked rather than assumed) *before* transcription. Typed turns have no duration and
   skip everything below.
2. **Verbose whisper for short clips.** Under `JEV_SHORT_MAX_S` (default 3.0 s) whisper is asked
   for `response_format=verbose_json` — `duration`, `segments[].words[].{word,probability}`,
   `segments[].avg_logprob`, `detected_language(_probability)`. Longer clips get plain `json`,
   exactly as before. The `HALLUCINATIONS` filter runs on the text first in both cases.
3. **The garbage check** — a separate Jev request (`checkGarbage`) containing two Nouls,
   `addressed_to_jarvis` and `complete_utterance`, in ONE request (Liran's call: one round trip
   for both), read sequentially in code. Its state: the text, the duration, each word with its probability, the
   average log-probability, the detected language and its probability, and the last exchanges.
   `no_speech_prob` is deliberately left out: it is misleading on short clips. The criteria are
   unchanged — readable English or Hebrew passes however short; only unreadable, garbled,
   non-word or other-language text can fail — plus one sentence saying that the word
   probabilities and the detected language are evidence about whether this was speech at all.
4. **The intent request** runs only for a turn that survived, and is byte-for-byte the original
   one: `intent`, `tv_action`, `level`, no noul.

The first Noul answers one thing only:

- **true** — carries a meaning of its own, or answers / refers to something in the recent exchanges shown.
- **false** — a fragment: a false start, interjection, stray word or cut-off, or a reply / reference with no recent exchange it belongs to.
- Rule (Liran, 2026-09-21): judged by meaning, never by word count; the 3 s gate already decides who is asked. A cold "mute" or "I'm going out" stands alone and passes; a cold "yes" or "why is that?" has nothing to answer and drops. Measured: "yes" cold 0.20 / with a question 0.94; "why is that?" cold 0.27 / after an answer 0.94; "mute" cold 0.77.

**The rule, Liran's, exactly:** drop a turn ONLY when the transcript is unreadable text or an
unknown language — whisper garbage, scrambles, mis-recordings, misclicks. Readable English or
Hebrew ALWAYS goes through, however short; a bare "yes", "no", "done", "fine" answering the
previous round must pass. So the state carries the last exchanges as `{user, agent}` pairs, not
just the user's words, and a short answer is judged next to what it answers.

The second Noul, `complete_utterance`, is read only for a turn the first one let through:
readable speech is not yet a turn worth answering.

- **false** — a fragment: a false start, stray word, interjection or cut-off with no request,

**Liran's rule for short utterances (2026-09-21):** a one- or two-word utterance is complete ONLY
next to a recent exchange it relates to ("yes", "no", "done", "mute" after the assistant said or
asked something they answer). With no recent exchange in the state, or one they do not relate to,
words and up are judged on their own as before.

`JEV_FRAGMENT_MIN` (default 0.6, env `JEV_FRAGMENT_MIN`, live key `fragment_min`, file > env >
default): in mode `on`, when the first gate passed and the probability of *complete* is below
`1 - JEV_FRAGMENT_MIN`, the turn is dropped with reason `fragment`; in `shadow` it is only logged
as `router: would drop (fragment p=0.31) "<text>"`. A missing or malformed `complete_utterance`
answer never drops.

**Drop order:** `addressed_to_jarvis` first (reason `garbage`), then `complete_utterance` (reason
`fragment`). The trace carries `garbage.complete` next to `garbage.addressed`, `routed:
'dropped'` is unchanged, and `drop_reason` (`garbage`|`fragment`) is on both the trace line and
the transcript row, whose agent reads `<router:dropped:garbage>` / `<router:dropped:fragment>`.
`router-report` prints both probabilities in the garbage block and an `addr` and a `cmpl` column;
`router-dash` shows "short 1.2 s · addressed 0.94 · complete 0.31", the reason in the DROPPED
badge, and `frag≥0.6` in the header config line.

`JEV_DROP_MIN` (default 0.90): in mode `on`, when the probability of *addressed* is below
`1 - JEV_DROP_MIN` (i.e. Jev is ≥ 0.90 sure it is not speech), the turn ends right there — no
intent request, no Claude, no TTS, `{type:'ignored'}` to the phone exactly as an empty
transcription does, a transcript row with `agent: "<router:dropped>"` and `cost: 0`, and
`routed: "dropped"`, `result.by: "router"` in the trace. In `shadow` it is only logged. A missing
or malformed noul answer, or any failure of the garbage check at all, counts as addressed and
falls through to the intent request: the gate can only ever drop on a real, confident answer.

    router: dropped (not addressed p=0.03) "<text>"

The trace carries `audio: {duration_s, short}` and, when the check ran, a `garbage` block
(`state, sent_at, done_at, ms, addressed, request_id, usage, error, words, avg_logprob, language,
language_p`). `router-report turn` prints it as its own step between "text ready" and the intent
step, the table's `addr` column comes only from it, and each dashboard card shows
"short 1.2 s · addressed 0.03" with the word probabilities as chips and a red DROPPED badge.

## Live config

`<VOICE_STATE>/router.json`, next to `router.jsonl`, re-read by mtime before each turn (the same
trick `isAway()` uses on `away.json`), so nothing below needs a restart:

    { "mode": "off|shadow|on", "route_min": 0.85, "drop_min": 0.90, "fragment_min": 0.6,
      "short_max_s": 3.0, "model": "jev-latest", "timeout_ms": 1500, "tv_settle_ms": 2000 }

All keys optional; precedence **file > env > default**, per key. A missing file means
env/defaults. A malformed file keeps the last good values and logs, once per mtime,
`router: router.json unreadable (<err>), keeping last good config` — a typo must never reset the
router to defaults mid-conversation. `routerConfig()` returns the effective values; they go into
every trace line as `config` and into the dashboard header.

## TODO: turns while relay mode is on (Liran, 2026-09-21)

Classic Jev: while relay is on, each turn is a Choice {addressed to Jarvis, relay it, relay off}.
Depends on relay mode becoming server state (parked above) and on the open question of whether
the hand-off to another session can run from a headless process rather than the live Claude.
