@AGENTS.md

## Claude Code

### Cross-session delegation

The setup skill's step 8 asks, generically, whether the voice channel may hand tasks to other
agent sessions already running on this machine, and recommends turning it on for Claude Code.
The concrete mechanism is `ListAgents` (list other live Claude Code sessions) and `SendMessage`
(hand one of them a job) — add both to the voice channel's allowed tools once the user has
confirmed the question, whichever way they answer it; don't add them before asking.

With delegation on, setup also installs the two relay skills into `VOICE_ROOT/.claude/skills/`
(`relay-mode` for the voice agent, `voice-relay` for other sessions). With it off, neither is
installed — relaying is `SendMessage`.

`ListAgents`/`SendMessage` only reach a session that actually exists at the moment the voice
channel tries to dispatch to it — they can't launch one. So if delegation is on, remind the user
at the end of setup: for the voice channel to reach real tool access through another session
(not just its own conversation), they need to actually leave a Claude Code session — this one or
another — running on this machine with remote-control/auto mode on, not just installed.
