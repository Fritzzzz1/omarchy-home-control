# Plugins

A plugin is an optional feature, switched on by one line in `config.env`, one block of
instructions in the agent's working folder (`VOICE_ROOT`'s `CLAUDE.md` or `AGENTS.md`), or both.

The rule: anything that names one machine's actual device, tool, or person — a TV's remote
command, a state-dir path, the owner's name — goes in `config.env` (a value) or the working
folder (a paragraph of instructions), never in this repo. The repo only ever names the config
key and the shape of the instructions.

Offer these after setup verifies (`setup/SETUP.md` §10), one at a time — ask before adding any of
them, don't install them by default. Each needs `home-control-ctl restart` to take effect,
because both a new `config.env` value and new working-folder instructions are only picked up when
the long-lived agent process (re)starts. Restart only when the user agrees; it ends any
conversation in progress.

## a. Away mode

Skips replies on this machine's own speakers while the owner is out; the phone still gets every
reply as normal.

**Config:** `VOICE_AWAY=on` (default `off`). Off, the away file is never read.

**Working folder** (`VOICE_ROOT/CLAUDE.md` or `AGENTS.md`), adapt the placeholders:

    ## Away mode

    Home Control has an away flag (checked fresh before every local-speaker playback) that keeps
    sending replies to the phone as normal but skips this machine's own speakers. It's a plain
    bool on disk, not a route — write the file directly: `<state dir>/away.json`.

    When <owner> says they're leaving: say "away mode on" out loud first, then write
    `{"away": true}` to that file. Optional, only if <owner> has approved it in advance: also
    turn the display off (see the display plugin), after saying it.

    When <owner> says they're back: if a display plugin is set up, restore it (power on, correct
    input) first; write `{"away": false}`; then say "away mode off" last. That order is what lets
    <owner> hear both confirmations on this machine.

    Any session working in this folder can do the same, the same way — it's a plain file write.

**Verify:** with `VOICE_AWAY=on`, write `{"away": true}` to the state dir's `away.json` by hand,
reload the phone page (it reads `away` only once, at load), trigger a turn, confirm the phone
gets audio and this machine stays silent; write `{"away": false}` back, reload again, and confirm
normal playback resumes without a restart (the flag itself is read fresh, only the config key
needs one).

**Restart:** required for `VOICE_AWAY` itself and for the working-folder block; not required
afterward to flip the flag.

## b. Machine speakers and display

Two separate things. Speakers are this repo's own playback of replies. A display (e.g. a TV the
machine drives) is an external remote-control tool, installed and maintained outside this repo —
the plugin is just the working-folder instructions that name its commands.

**Config:** `VOICE_LOCAL_PLAYER=mpv|ffplay|off` (default `mpv`). `off` means no playback on this
machine at all, phone only. The phone page's Settings "Stop all audio and start clean" button
stops these speakers and keeps them quiet for the rest of the running turn, independent of this
setting — including a reply another session started (the relay loop), not only the phone's own.

**Working folder**, only if a display exists — adapt the placeholders:

    ## Display

    This machine drives a display through `<display remote command>`:
    - Power: `<display remote command> power on|off`
    - Input: `<display remote command> input <name>`
    - Volume: `<display remote command> volume <n>`

    Power on, switch input, and adjust volume freely when <owner> asks. Power off only when
    <owner> has approved it in advance (e.g. as a step of away mode) — don't turn the display off
    on a whim.

**Verify:** trigger a reply and confirm it plays on this machine's speakers (or stays silent, if
`off`); if a display is configured, run one of its commands by hand and confirm it reaches the
device.

**Restart:** required for `VOICE_LOCAL_PLAYER`; the display instructions take effect on the
agent's next start, same as any working-folder change.

## c. Input hook

Runs a command as soon as the owner's turn is transcribed/typed, independent of playback — it
does not wait for the machine (or the phone) to finish speaking the reply. Fed what the owner
said; it never sees the agent's replies.

**Config:** `VOICE_ON_INPUT=<shell command>` (unset = nothing runs). The command gets one JSON
object on stdin: `{ "at": <ISO time>, "text": <what the user said>, "audio_base64": <the
recording, when spoken> }`. 30 s hard timeout — the whole command is killed, not just its shell.
Failure (non-zero exit or timeout) is logged and never affects the turn. `config.env` is read by
systemd, which strips unquoted backslashes — anything that needs them belongs in a script, with
`VOICE_ON_INPUT` pointed at that script.

**Working folder:** none required — this plugin is config only, unless the command itself needs
instructions the agent should know about (e.g. where its output lands, so it can be asked about
later).

**Example**, generic — append each turn as a line of JSON:

    VOICE_ON_INPUT=jq -c '{at, text}' >> <state dir>/input-log.jsonl

**Verify:** set the command, speak one phone turn, confirm the command actually ran (its output
file grew, or its target tool logged an entry) within a few seconds.

**Restart:** required.

## d. Permission mode

Controls how much the voice agent can do without asking, at the `claude` CLI level.

**Config:** `VOICE_PERMISSION_MODE=acceptEdits|auto|...` (default `acceptEdits`: edits apply
without asking, other actions follow the CLI's normal rules). `auto` hands the decision to Claude
Code's own auto mode instead. Any value the `claude` CLI's `--permission-mode` accepts is valid.

**Working folder:** none — config only. If cross-session delegation is on, `CLAUDE.md` already
covers what that combination means; nothing extra to add here.

**Verify:** ask for something that would normally prompt (e.g. an edit outside what's pre-approved)
and confirm it behaves as the chosen mode implies.

**Restart:** required.

## e. Jev router

A typed decision taken before the agent is asked anything: one Choice question to Jev (TypeSafe
AI) per turn, answered in 70–500 ms, deciding whether the turn is a fixed procedure (away mode, a
TV command, relay mode) or an ordinary conversation. A routed turn speaks a fixed line from
`app/router-lines.json` and never costs a Claude turn; everything else goes to the agent
untouched. Jev missing, slow (> 800 ms) or wrong never fails a turn — it just means Claude.

**The garbage gate**, in front of all of that, as a sequence: the recording's duration is read
from its WAV header before transcription; under `JEV_SHORT_MAX_S` the clip is transcribed with
`verbose_json` (per-word probabilities, segment log-probabilities, detected language) and then a
*separate* Jev request asks two Nouls, `addressed_to_jarvis` and `complete_utterance`, with that
evidence in its state — one request, read sequentially, so the second gate costs no round trip.

1. When Jev is at least `JEV_DROP_MIN` sure the transcript is not readable English or Hebrew
   speech (whisper garbage, a scramble, a mis-recording, a misclick) the turn is dropped with
   reason `garbage`.
2. Otherwise, when Jev is at least `JEV_FRAGMENT_MIN` sure this was not a complete utterance — a
   false start, a stray word, an interjection, a cut-off sentence — the turn is dropped with
   reason `fragment`. Judged by meaning, not length: an utterance with a meaning of its own
   ("mute the TV", "I'm going out") passes cold; a reply or reference ("yes", "why is that?") is
   complete only when the recent exchanges in the state hold what it answers.

A dropped turn means no Claude, no reply, a `cost 0` transcript row with agent
`<router:dropped:garbage>` or `<router:dropped:fragment>`, and it never reaches the intent
question. Longer clips and anything typed skip the gate entirely, and a failed garbage check, or
a missing noul answer, is never a drop.

**Config:**

    JEV_API_KEY=<key>            # a TypeSafe AI key; without it the router is inert
    JEV_ROUTER=shadow|on|off     # default off
    #JEV_ROUTE_MIN=0.85          # the confidence a label needs before anything is routed
    #JEV_DROP_MIN=0.90           # how sure Jev must be that a turn is not readable speech
                                 # before it is dropped (no Claude, no reply)
    #JEV_FRAGMENT_MIN=0.6        # how sure Jev must be that a turn is a fragment rather than a
                                 # complete utterance before it is dropped
    #JEV_SHORT_MAX_S=3.0         # under this many seconds of audio, a turn gets the garbage check
    #JEV_MODEL=jev-latest        # jev-latest | jev-preview
    #JEV_TIMEOUT_MS=1500
    #JEV_TV_SETTLE_MS=2000       # how long the TV gets to bring HDMI audio up before we speak

**Live config, no restart:** the same settings can be put in `<state dir>/router.json`, which is
re-read (by mtime) before every turn — so a threshold, the mode or the model can be changed while
a conversation is live:

    { "mode": "on", "route_min": 0.85, "drop_min": 0.90, "fragment_min": 0.6,
      "short_max_s": 3.0, "model": "jev-latest", "timeout_ms": 1500, "tv_settle_ms": 2000 }

All keys optional. Precedence is **file > env > default**, per key. A missing file just means
env/defaults. A malformed file keeps the last good values and logs
`router: router.json unreadable (...), keeping last good config` once — a typo never silently
resets the router. The effective config is written into every `router.jsonl` line and shown in
the `bin/router-dash` header.

`shadow` asks Jev on every turn and writes the answer to `<state dir>/router.jsonl` without
routing anything — the way to see how it would have behaved before trusting it. `on` routes per
the rule above. `off` makes no call at all.

**Working folder:** none required. The TV procedures call the TV code in `~/dev/home-server/devices/tv/lib`
directly (`TV_LIB` overrides the path); when that call fails they fall back to a fixed "couldn't reach the TV" line.

**Verify:** `JEV_ROUTER=shadow`, restart, speak a few turns, then `bin/router-report` for the
per-turn table and `bin/router-report turn last` for one turn's full timeline.

**Restart:** required.
