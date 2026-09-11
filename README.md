# Omarchy Home Control

Talk to your computer from your mobile phone. Watch it work on your screen and hear it reply from
your speakers. Reachable from anywhere over Tailscale.

**Tested chain:** Omarchy · Claude Code · local whisper.cpp · local edge-tts · iPhone · Safari.
For Other providers/runtimes your implementing agent should know the trick.

## Stack

- `server.mjs` (Node) — voice server, binds `127.0.0.1`
- whisper.cpp `whisper-server` (local) or a remote endpoint — transcription
- your coding agent (Claude Code, Codex, OpenAI API, local model)
- `tts.py` (edge-tts) or your own TTS
- Tailscale — HTTPS access from the phone
- systemd user units — voice server + dashboard

## Install

```
git clone <this repo> && cd omarchy-home-control
claude (etc.)
> load and follow setup/SETUP.md
```

Agent: confirms runtime, language, input source, transcription, TTS, remote access,
delegation; installs; verifies one real voice turn. `setup/fallbacks/` covers pieces you don't
already have a solution for.

## Flow

```
phone (Silero VAD) -> server.mjs -> transcription -> agent -> cleanup for voice -> TTS -> phone
```

Localhost-bound; `tailscale serve` exposes it over tailnet HTTPS behind a passphrase gate. No
Funnel, no public exposure.

Optional desktop dashboard (on by default): live conversation + agent activity, installed as an
Omarchy web-app launcher.

## Configuration

`~/.config/home-control/config.env` — `KEY=VALUE`, commented, written by setup.
`systemctl --user restart home-control` to apply (not mid-conversation).

## Commands

```
home-control-ctl status
home-control-ctl doctor
home-control-ctl logs -f
home-control-ctl url
home-control-ctl restart     # asks for confirmation; ends any live turn
```

Dashboard restarts separately: `systemctl --user restart home-control-dashboard`.

## Cross-session delegation (Claude Code only, as of 2026-09-09)

`ListAgents`/`SendMessage`, gated by `VOICE_PEER_DELEGATION` in `config.env`. Setup asks,
defaults to yes for Claude Code. Rule: missing tool → delegate; denied action → don't, goes back
to the user.

## Limits

- Verified only on the tested chain above
- Linux + systemd user services only
- Phone page loads jsdelivr + Google Fonts, not vendored — needs internet
- Agent unsandboxed under `VOICE_ROOT`, minus a deny list (`secrets/`, `credentials*`, `.env*`)
- Passphrase-only auth, on top of the tailnet
- Traffic goes to whatever providers are configured — local by default, remote if pointed there

## Credits

[Fritzzzz](https://github.com/fritzzzz1) + Claude Code.
