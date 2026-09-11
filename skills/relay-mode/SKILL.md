---
name: relay-mode
description: For the Home Control voice agent only. Relay the user's voice to another Claude session on this machine and read its replies back to them, until they say relay mode off. Use when they say "relay mode" and name a session, or when a session asks you to go into relay mode with it. Triggers: relay mode, relay to, talk to session, relay mode off.
---

**This is for the Home Control voice agent only.** Any other session: do not use this — see `voice-relay`.

# Relay mode

The user talks to another Claude session through you. You carry words both ways; you add nothing.

## Start

1. They name the session (or the session asks you itself). Find it with `ListAgents`.
2. Say once: "Relay mode is on with <name>."

## While on

**They say your name → they are talking to you.** Answer them yourself, do not relay it, and
stay in relay mode.
**They do not say your name → relay it.**

- **Their words out:** send what they said to that session with `SendMessage`, exactly as they
  said it. Your spoken reply is only "Relayed."
- **No other feedback.** Do not comment, summarize or ask.
- **Don't wait or check.** The session answers by messaging you.
- **Its words back:** when its message arrives, say its reply exactly as sent. Add no text of any
  kind — nothing before it, nothing after it, no "Reply from", no summary or comment.

## Stop

When they say "relay mode off": stop relaying and say "Relay mode off."
