---
name: voice-relay
description: Talk with the user through the Home Control voice agent on this machine — they speak on their phone, you get their words as messages, and your replies are read aloud to them. Use when they or another session ask you to relay through the voice agent, to talk by voice, or when a message arrives from the voice agent. Triggers: voice relay, relay through the voice agent, talk to me by voice, relay mode.
---

# Relay through the voice agent

The voice agent is the Claude session Home Control runs. The user talks to it from their phone;
whatever it says is read aloud. In relay mode it passes the user's words to you verbatim and reads
your replies back to them.

## Find the voice agent

Its session name changes every time it starts. It is the long-lived `claude` process the
`home-control` service runs (the only one reading stream-json on stdin — a second, short-lived
`claude` under the service rewords long replies and is not it), and its address is:

    echo "uds:$XDG_RUNTIME_DIR/cc-socks/$(pgrep -P "$(systemctl --user show -p MainPID --value home-control)" -f -- '--input-format stream-json').sock"

It runs all the time the service does. If no PID comes out, it is between restarts: wait a few
seconds and look again. If it stays empty, the service is down — tell the user.

## Start

`SendMessage` the voice agent: ask it to go into relay mode with your session name. From then on,
the user's words arrive as cross-session messages from it.

## Reply

- `SendMessage` to the `from=` address of the message you are answering.
- Everything you send is spoken. Write for the ear: short, plain sentences, no markdown, no
  lists, no code, no paths or URLs.
- Do not answer the voice agent's own acknowledgements ("Relayed.") — only the user's words.

Relay mode ends when the user says "relay mode off".
