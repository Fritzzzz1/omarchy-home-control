# Omarchy Home Control

Talk to your computer from your mobile phone. Watch it work on your screen and hear it reply from
your speakers. Reachable from anywhere over Tailscale.

**Tested chain:** Omarchy · Claude Code · local whisper.cpp · local edge-tts · iPhone · Safari.
For Other providers/runtimes your implementing agent should know the trick.

## Stack

- `server.mjs` (Node) — the one server, binds `127.0.0.1`: home-control at `/`, home-control-mobile at `/mobile/`.
  On the Home Server its HTTP plumbing (routing, body reads, JSON errors, files, redirects, `GET /health`, SIGTERM)
  is the shared layer `~/dev/home-server/shared/js/home-app.mjs`; elsewhere, keep that file at the same relative path
- whisper.cpp `whisper-server` (local) or a remote endpoint — transcription
- your coding agent (Claude Code, Codex, OpenAI API, local model)
- a TTS service (here: the Home Server's `tts.service`, edge-tts, 127.0.0.1:4457), or your own
- Tailscale — HTTPS access from the phone
- systemd user unit — `home-control`

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

Optional home-control page (on by default): live conversation + agent activity, installed as an
Omarchy web-app launcher.

## Configuration

`~/.config/home-control/config.env` — `KEY=VALUE`, commented, written by setup.
`systemctl --user restart home-control` to apply (not mid-conversation).

Optional features (plugins) — away mode, local speakers/display, an input hook, permission mode —
are in `setup/PLUGINS.md`.

## Commands

```
home-control-ctl status
home-control-ctl doctor
home-control-ctl logs -f
home-control-ctl url
home-control-ctl restart     # asks for confirmation; ends any live turn
```

home-control is part of the server: it restarts with it.

## Limits

- Verified only on the tested chain above
- Linux + systemd user services only
- home-control-mobile loads jsdelivr + Google Fonts, not vendored — needs internet
- Agent unsandboxed under `VOICE_ROOT`, minus a deny list (`secrets/`, `credentials*`, `.env*`)
- Passphrase-only auth, on top of the tailnet
- Traffic goes to whatever providers are configured — local by default, remote if pointed there

## Credits

[Fritzzzz](https://github.com/fritzzzz1) + Claude Code.
