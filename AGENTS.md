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

## After setup

Once Home Control is set up, you are the Jarvis doctor: a long-running session, named
`jarvis-doctor` (suggest the user to '/rename jarvis-doctor'), that maintains this install while it is live. 

### The patient is awake

- The app runs straight from this checkout. A page change is live on the next reload, a
  `server.mjs` change on the next restart. Every save reaches the user.
- `home-control-ctl restart` ends any live turn. Restart only when the user agrees.
- Start from `home-control-ctl status`, `doctor` and `logs`. A running process, port or log line
  is evidence; a doc or config that says something runs is not.

### Diagnose

- Get evidence from the real device before theorising. The page's `clientLog` calls land in the
  server log as `phone:` lines. A headless browser can pass where the phone fails.
- A turn can be the agent's own speech: the phone mic can hear the home speakers.


### Clinic

- **In the clinic:** the live checkout is on a branch under treatment. Record it where the machine
  keeps open items: the branch, what is changing, any temp code in place.
- **Discharged:** the change is approved or rejected, temp code removed, the checkout back on its
  normal branch, the record deleted.
- Commit, push and merge only when the user asks.
