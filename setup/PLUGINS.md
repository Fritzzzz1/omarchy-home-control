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

**Config:**

    JEV_API_KEY=<key>            # a TypeSafe AI key; without it the router is inert
    JEV_ROUTER=shadow|on|off     # default off
    #JEV_ROUTE_MIN=0.85          # the confidence a label needs before anything is routed

`shadow` asks Jev on every turn and writes the answer to `<state dir>/router.jsonl` without
routing anything — the way to see how it would have behaved before trusting it. `on` routes per
the rule above. `off` makes no call at all.

**Working folder:** none required. The TV procedures talk to tv-remote's local JSON API
(`127.0.0.1:4470`); without that service they fall back to a fixed "couldn't reach the TV" line.

**Verify:** `JEV_ROUTER=shadow`, restart, speak a few turns, then `bin/router-report` for the
per-turn table and `bin/router-report turn last` for one turn's full timeline.

**Restart:** required.
