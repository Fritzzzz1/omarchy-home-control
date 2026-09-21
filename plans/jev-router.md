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
   server already has (`AWAY_FILE`, tv-remote's `POST 127.0.0.1:4470/api/run/<capability>`).
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

## Next, after the POC (Liran, 2026-09-21)

Noul `addressed_to_jarvis`: drop empty transcriptions, scrambles, mis-recordings and misclicks
before Claude wakes. Must see the last one or two exchanges of the conversation in `state`, so a
bare "yes", "no", "done", "fine" that answers the previous round is not dropped.
Rule, made explicit by Liran: drop only unreadable text or an unknown language. Readable English or
Hebrew always goes through, however short.
