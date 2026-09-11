# Setup Home Control

Set up Home Control — a personal voice assistant backed by this coding agent — on the current
machine: confirm a runtime provider, choose an input source (phone and/or a local mic), wire
transcription and text-to-speech, optionally add remote access, install the services and both
dashboards, and verify a real end-to-end voice turn before declaring success.

Explain each decision briefly, ask it, do the work yourself (install packages, write config,
start services, run real validation commands), and report the outcome before moving on. Don't
turn this into a manual checklist for the user.

Already set up (`~/.config/home-control/config.env` exists)? Say so, and ask what they want to
change instead of re-running everything below.

Also check whether this app's own ports (voice server, transcription, TTS, dashboard) are
already bound by something else. If one is, it's not a blocker — just pick a free port instead,
or ask the user which port they'd prefer, and move on.

If you're running on Omarchy, ask first whether they'd like a browser page open showing the
setup steps as you go (`app/setup.html`, e.g. via `xdg-open`). Only open it if they say yes. It
has no server behind it — as you finish each numbered step below, edit that step's
`<div class="step ...">` from `active` to `done` (status text `Done`) and mark the next one
`active`, then tell the user to refresh the page. No polling/live-update mechanism — a plain file
edit per step is enough.

Whenever a step needs `sudo` (installing a package, `tailscale up`, enabling a system service),
don't run it yourself and don't ask the user for their password. On Omarchy, open it in a real
terminal instead: `omarchy-launch-terminal sudo <command>` — the password prompt happens there,
interactively, never through you.

## 1. Runtime agent

Read Omarchy's configured default (`omarchy default agent` / `~/.config/omarchy/defaults/agent`).
Present it as the recommendation and ask the user to confirm it for Home Control — don't select
it silently. Only offer an alternative if they ask or the default isn't available.

You (whichever agent is running this setup) own the adapter: detection, auth, how you're
invoked, conversation persistence, streaming, tool/permission behavior, and the optional
speech-rewrite call, for whichever provider gets confirmed. If it's Claude Code, `claude` on
PATH plus its auth-status command is enough to validate. If it's Codex, ChatGPT-subscription
login vs. a direct OpenAI API key are different adapters — ask which, and for the API case
collect the credential into protected per-user storage, never into logs, config committed to
git, or anything spoken aloud. A local/open-source provider needs its endpoint or CLI, ask and
validate it directly. Don't scan the network or guess credentials — probe only what's selected.

## 2. Agent folder

Ask which folder the voice agent runs from — before anything else is installed. Explain in one
line each: it is the folder the agent can read and edit without a sandbox (only `secrets/`,
`credentials*`, `.env*` are denied); the agent loads that folder's `CLAUDE.md` and
`.claude/skills/`; its conversation history is tied to that path, so changing it later starts a
fresh conversation and the dashboard loses the old one. Recommend a dedicated folder (for example
`~/dev`) over `$HOME`. Create it if it doesn't exist. Write the answer as `VOICE_ROOT`
(`install.sh --voice-root`).

## 3. Language

Ask once: "what's your default spoken language?" (default: English). Carry it into transcription
and TTS defaults below.

## 4. Input source

Ask: does this machine have a microphone available? Only if yes, also ask whether they'd like
to skip the phone/remote-access setup entirely and use this machine's mic as the only input —
turning it into a self-contained appliance rather than requiring a phone. If no mic, skip that
second question; the phone is the input.

If a phone is in play (default path, or alongside a local mic), explain briefly: the phone is
personal and portable — no hardware needed here, and it goes wherever the user goes. Tailscale
(§7) is what lets that phone keep working off the home network, so mention it's coming.

## 5. Transcription

If local mic input was chosen or the phone is in play, ask whether they already have a
transcription solution reachable on their private network. If yes: collect connection details,
authenticate if needed, adapt to its protocol, and validate with a real transcription request.

If none: see `setup/fallbacks/transcription.md`.

## 6. Text-to-speech

This is required, working infrastructure — not optional research. Ask whether they already have
a TTS solution reachable on their private network; if yes, wire it through an adapter and
validate synthesis + playback. If none: see `setup/fallbacks/tts.md`.

Ask whether to enable the optional speech-rewrite pass (an extra model call that rewords
long/formatted replies for the ear before TTS). Default it to the cheapest model available for
the confirmed provider (or a local model, if one's already running) — cost stays low, not zero.
On by default; say so plainly. Write their answer into `config.env` as an explicit boolean —
asking it and not persisting it is worse than not asking; validate it if enabled.

## 7. Remote access (optional)

Only relevant if a phone is in play. Check locally first — `tailscale status` — whether this
machine is already connected to a tailnet; don't reach out to or touch any external device before
confirming with the user, if that's even needed. Ask whether they already have a private
network/tailnet path to this machine. If yes, connect it and validate the real HTTPS phone URL.
If none: see `setup/fallbacks/remote-access.md`. Never expose anything to the public internet by
default. Don't describe a localhost-only setup as phone-reachable.

To validate reachability, check `tailscale serve status`, not raw port binding — a service
bound to `127.0.0.1` can still be phone-reachable, because `tailscale serve` proxies it to its
own public tailnet HTTPS port. The voice server and the dashboard (§9) each get their own serve
mapping and port; check the one you're actually validating, not either one generically.

## 8. Cross-session delegation (if the runtime supports it)

Explain why this matters before asking: without it, the voice channel can only act with whatever
tools this one conversation has. Ask whether the voice channel may hand off tasks to other
coding-agent sessions already running on this machine, when the confirmed runtime provider
actually offers a way to do that. For Claude Code, recommend it with exactly this framing:
"default for Claude Code — gives the voice agent the ability to use any tool, as long as there's
an active, remote-controlled/auto-permission Claude session on this machine." That's the default
unless they say otherwise. The concrete mechanism is runtime-specific — for Claude Code, see
`CLAUDE.md`, including the note in it about what to tell the user at the end of setup; don't
invent an equivalent for a provider that doesn't have one.

`install.sh`'s rendered `voice-mode.md` splices in one of two content blocks depending on this
answer (`app/delegation.on.md` / `app/delegation.off.md`) — update those if the mechanism for the
confirmed runtime differs from what they describe.

## 9. Install and launch

Install the server, chosen client(s), both dashboards, rendered config, and systemd user
services, using distinct configurable ports for the voice server, transcription, TTS, and
dashboard. Use the agent folder chosen in §2 as `VOICE_ROOT`.

Home Control runs from this clone — nothing is copied. Install writes only `config.env`, the
systemd units, and two files git ignores (`app/voice-mode.md`, `app/manifest.json`). Updating
later is `git pull` then `home-control-ctl restart`; switching branches here changes the running
app too.

`install.sh`/`uninstall.sh` can do this mechanical part for you — once you know the real values,
`./install.sh --whisper-model ... --pwa-name ...` is there to help, not required. Use it if it
fits what you've learned about this machine; adapt or skip pieces of it if it doesn't.

- Desktop dashboard (`app/monitor.html`/`app/monitor.mjs`): a nice-to-have, on by default, but
  skippable — "that's cool!" if they'd rather not, not a blocker to finishing setup. If they want
  it, walk it step by step: suggest an app name/icon, confirm it, then the launcher binding
  pattern used by other Omarchy web apps — don't just declare it installed. Only if they install
  it: this machine can also play replies out loud through its own speakers, near the dashboard
  (already wired via `VOICE_LOCAL_PLAYER`, mpv/ffplay) — ask whether they want that in addition
  to phone playback, or instead of it; recommend both by default. `monitor.mjs` reads
  Claude Code's own session-file format directly — if the confirmed runtime isn't Claude Code,
  go adapt that data source to whatever equivalent that runtime actually offers (its own
  transcript format, or just what `server.mjs` is already tracking) rather than shipping a
  dashboard that silently shows nothing.
- Phone client (`app/index.html`), if in play: walk the user through adding it to their phone's
  home screen as a PWA.
- Relay skills, only if delegation (§8) is on: copy `skills/relay-mode/` (for the voice agent)
  and `skills/voice-relay/` (for other sessions that want to talk to the user through it) into
  `VOICE_ROOT/.claude/skills/`. Skip both when delegation is off.
- Give them a control command for status/logs/health/start/stop/restart and the phone URL.
- If the confirmed runtime isn't Claude Code: `server.mjs` currently hardcodes `spawn('claude',
  ...)` to run the agent. Go edit that invocation for the actual chosen provider as part of this
  step — this is real, required code work, not something to defer or fake.

## 10. Verify, then finish

Before calling this done, verify: service startup, provider auth, transcription, TTS, and (if
configured) HTTPS phone reachability via `tailscale serve status` (§7) — all by actually
exercising them, not just checking that processes are running.

Then do **one real round trip with the human**: have them speak into whichever input was
configured and confirm out loud (or in text) that they heard/saw the reply on the configured
output(s) — phone, local speakers, and/or the dashboard. Only after they confirm it worked do
you write `~/.config/home-control/config.env` and consider setup complete. Don't self-certify
from automated checks alone — this last step is a human witness, not a script.

If the confirmed runtime is Claude Code and delegation (§8) is on, close by telling the user what
`CLAUDE.md` says: delegation only reaches a session that's actually running at the moment the
voice channel tries to use it — remind them to leave this session or another one up, in
remote-control/auto mode, if they want the voice channel to have real tool access through it.
