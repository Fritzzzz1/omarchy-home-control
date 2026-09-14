# Home Control

A personal voice assistant, backed by the user's own coding agent: a phone (and/or local mic)
for input, this machine for the agent and transcription/TTS, a desktop dashboard to watch it
work.

## First thing, every session

Check for `~/.config/home-control/config.env`. If it's missing, Home Control isn't set up on
this machine yet — before any other repository work, tell the user and invite them to run setup,
rather than just describing what setup involves.

The complete setup procedure is written at `setup/SETUP.md` — open and follow it directly. It's
plain markdown, step-by-step instructions for whichever agent is running it, not specific to any
one tool. Do not re-derive or duplicate the procedure here.

## Ports

If one of this app's ports is already taken by something else, that's not a blocker — ask the
user which port they'd prefer (or pick a free one) and update the config/code to match. Never
treat a taken port as a reason to stop or fail.
