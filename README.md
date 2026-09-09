# Omarchy Home Control — voice channel for an Omarchy machine

Talk to the Claude agent running on your computer, from your phone, by voice.
The phone is the microphone and the speaker; the machine does the thinking.

This repository is two things at once:

1. **An Omarchy plugin** (`manifest.json`, `Panel.qml`) — a bar widget that shows
   whether the voice channel is up and opens the phone URL.
2. **The voice channel itself** (`app/`, `install.sh`) — a node server, a
   text-to-speech worker, and a systemd **user** service.

The bar widget is optional garnish. The service is the product.

## What it actually does

    phone (Silero VAD in the browser)
      -> POST 16 kHz WAV to server.mjs on 127.0.0.1:4455
      -> WHISPER_URL transcribes it            (remote; see prerequisites)
      -> `claude -p` runs in VOICE_ROOT, one resumed session across turns
      -> each finished sentence goes to tts.py (edge-tts kept warm on :4457)
      -> audio streams back to the phone, sentence by sentence

The server binds to localhost only. `tailscale serve` puts it on your tailnet
over HTTPS; a passphrase gate sits in front of that. Tailscale Funnel is never
enabled, so nothing is exposed to the open internet.

## Prerequisites — read this before installing

This is not a self-contained app. It needs, on the machine you install it on:

| | why | if missing |
|---|---|---|
| **node** (22+) | runs `server.mjs` | install refuses |
| **the `claude` CLI**, logged in | the agent is Claude Code | install refuses |
| **python3** | builds the venv for `edge-tts` | install refuses |
| **jq**, **curl** | used by `home-control-ctl` and the widget | install refuses |
| **a whisper endpoint or local model** | transcription | **install refuses — see below** |
| **tailscale** | reaching it from a phone | install skips the serve step; you are LAN-only |
| **mpv** or **ffplay** | playing replies on the machine's own speakers | replies still go to the phone |
| **PulseAudio/PipeWire** | only for the optional phone-as-microphone sink | that one feature is dead |

### The whisper endpoint is not included

Choose one transcription setup. The app POSTs audio to a `whisper.cpp`
`whisper-server` and expects `/inference` to answer.

You have two options:

- **Point it at another machine.** This is what the original deployment does: a
  Mac mini on the same tailnet runs `whisper-server`, and the round trip costs
  about 25 ms more than doing it locally. `--whisper-url http://<host>:4458`
- **Run one locally.** Install `whisper.cpp` so `whisper-server` is on `PATH`,
  download a compatible model yourself, then use
  `--whisper-model /path/to/ggml-model.bin`. Home Control starts it on demand and
  keeps the model warm. The installer validates the binary and model path; it
  does not download either one.

If the endpoint is down, voice input stops and the phone page falls back to
typing. That is by design, not a crash.

## Install

    git clone <this repo> && cd omarchy-home-control
    ./install.sh --dry-run --whisper-url http://10.0.0.5:4458   # see every change first
    ./install.sh           --whisper-url http://10.0.0.5:4458
    # or: ./install.sh --whisper-model ~/.local/share/whisper/ggml-model.bin

`--dry-run` prints every file it would write and every command it would run.
Read it once; it is short.

### Exactly what an install touches

Nothing needs root. Nothing is written outside `$HOME` except the tailnet
mapping, which belongs to your tailscale login.

| Path / thing | What |
|---|---|
| `~/.local/share/home-control/app/` | the app, copied from `app/` in this repo |
| `~/.local/share/home-control/venv/` | a python venv with **`edge-tts`** in it |
| `~/.local/share/home-control/state/<label>/` | transcript, passphrase, logins, logs, audio cache |
| `~/.config/home-control/config.env` | **every machine-specific value, in one file** |
| `~/.config/systemd/user/home-control.service` | the unit; `EnvironmentFile=` the above |
| `~/.local/bin/home-control-ctl` | symlink to `bin/home-control-ctl` in this repo |
| `loginctl enable-linger $USER` | so it survives logout and reboot |
| `tailscale serve --https 8443 → 127.0.0.1:4455` | tailnet-only HTTPS. **Not** Funnel |
| the app's `tts.py` shebang | rewritten to the venv's python |
| the app's `voice-mode.md` | rendered with your name, the agent's name, and the delegation rule |

It **refuses** to install if the unit is already running, or if the port is
already in use — installing over a live voice channel would cut off whoever is
talking. Pass `--force` when you are sure nobody is on the line.

### Uninstall

    ./uninstall.sh              # service, unit, serve mapping, command. Keeps your data.
    ./uninstall.sh --purge      # also deletes the app, the venv and the state directory

Never touches `VOICE_ROOT`, never disables linger (something else may want it),
never removes node/claude/tailscale.

## Configuration

Everything lives in `~/.config/home-control/config.env`. It is a plain
`KEY=VALUE` data file, not a shell script; values may contain spaces. Edit it, then
`systemctl --user restart home-control` — **not while somebody is talking**.

| Variable | Default | What |
|---|---|---|
| `VOICE_ROOT` | `$HOME` | the folder the agent gets as its cwd. **It can read and edit anything under this.** |
| `VOICE_LABEL` | hostname | names this instance and its state directory |
| `VOICE_STATE` | `~/.local/share/home-control/state/<label>` | transcript, token, logs, audio |
| `VOICE_TOKEN` | `<state>/voice-token` | the passphrase file |
| `VOICE_PORT` | `4455` | local HTTP port (bound to 127.0.0.1) |
| `VOICE_HOST` | `127.0.0.1` | bind address. Changing this exposes the app; don't |
| `TTS_PORT` | `4457` | the edge-tts worker |
| `WHISPER_URL` | *(empty for local)* | remote transcription endpoint |
| `WHISPER_MODEL` | *(empty for remote)* | local model; starts `whisper-server` on demand |
| `VOICE_LOCAL_PLAYER` | `mpv` | or `ffplay`. Plays replies on this machine too |
| `VOICE_OWNER` | your name | who the agent thinks it is talking to |
| `VOICE_EDGE_TTS` | `<venv>/bin/edge-tts` | fallback when the warm worker is down |
| `VOICE_PEER_DELEGATION` | `off` | may the agent hand work to another live Claude Code session? See below |
| `VOICE_VOICE_EN` / `VOICE_VOICE_HE` | Andrew / Avri | edge-tts voices |
| `VOICE_MODEL`, `VOICE_EFFORT` | CLI defaults | `low` effort reaches the first sentence sooner |
| `VOICE_REWRITE_MODEL` | a Haiku model | rewrites page-shaped replies for the ear |
| `HOME_CONTROL_TAILNET_HOST` / `_PORT` | from tailscale / `8443` | used to print and open the phone URL |

## Cross-session delegation (Claude Code only)

`install.sh` asks one question, and the default answer is no:

> May the voice agent use `ListAgents` to find another live Claude Code session
> on this machine, and hand it work?

It is useful when something spoken into the phone needs a tool this conversation
does not have and another session does. It is never enabled silently — you are
asked, or you pass `--peer-delegation on|off`, and a non-interactive install
leaves it off.

`ListAgents` and `SendMessage` are **Claude Code's own tools**. If the agent
here is not Claude Code, or the CLI does not offer them, the flag does nothing
at all; the installer skips the question entirely when there is no `claude` on
PATH.

### The rule that comes with it

This is the part that matters, and the agent is told it either way:

> **A missing tool is a reason to delegate. A denied action is not.**

Delegating because this conversation *lacks a tool* is legitimate — the work
needs something this session cannot do, and a peer can.

Delegating because you *denied* something, or because the agent expects its own
permissions would block it, is not. Permission boundaries are **per session**. A
peer session acting on the agent's behalf does not inherit your consent; it
steps around a decision you already made. Work that was refused goes back to
you — never sideways to another agent.

That distinction is the whole difference between a useful capability and a hole,
so it is written into the setup prompt, into this README, and into the agent's
own instructions rather than being left implied.

### Changing or revoking it

    ~/.config/home-control/config.env      ->  VOICE_PEER_DELEGATION=off
    systemctl --user restart home-control  # not while somebody is talking

Setting it to `off` removes `ListAgents` and `SendMessage` from the tools the
agent is allowed to use, so the capability is gone, not merely discouraged.

One caveat worth knowing: the flag controls the *tools*, but the matching
wording in `voice-mode.md` is rendered once at install time. Flip the flag by
hand and the agent loses (or gains) the tools immediately, while its written
instructions still describe the old state. Re-run `install.sh` to bring the two
back into step.

## Day to day

    home-control-ctl status      # unit state, reachability, the phone URL
    home-control-ctl doctor      # checks node, claude, edge-tts, whisper, tailscale
    home-control-ctl logs -f
    home-control-ctl url

`home-control-ctl restart` asks for confirmation, on purpose. The `claude`
process talking to whoever is on the phone is a child of this service; a restart
ends their sentence mid-word.

## The bar widget

    omarchy plugin add <git url of this repo> --enable
    # or, from a clone:
    cp -r . ~/.config/omarchy/plugins/omarchy.home-control && omarchy-shell shell rescanPlugins

- **Click** — open the phone URL
- **Right-click** — start the service, but only if it is down
- **Middle-click** — refresh now

It will not stop or restart the service. That is not an oversight: a misclick on
the bar should not be able to hang up on someone. Use `home-control-ctl` for that.

The widget shells out to `home-control-ctl status --json` and knows nothing about
ports or hostnames itself, so it keeps working when you change the config.
If it shows "not installed", the service side has not been installed yet — the
Omarchy plugin and the service install separately, and the plugin alone does
nothing.

## Honest limits

- **Linux + systemd user services only.** The original also runs on macOS under
  launchd; that unit is not in this repo.
- **The phone page loads two libraries from jsdelivr** (`onnxruntime-web`,
  `@ricky0123/vad-web`) and a font from Google Fonts. With no internet, or a
  strict CSP, voice input does not work. They are not vendored.
- **The phone UI still says "Home".** The branding in `app/index.html`,
  `app/login.html`, `app/monitor.html` and `app/manifest.json` is not templated —
  only the agent's persona (`voice-mode.md`) is. Rename them by hand if you care.
- **English and Hebrew only.** Language is detected by counting Hebrew
  characters against a fixed 0.4 threshold, and there are exactly two voices.
- **Cross-session delegation is off unless you ask for it**, and even when on,
  the agent is told that a refusal must come back to you rather than go
  sideways to a peer session. That is an instruction, not an enforcement
  mechanism — the tools are gated by the flag, but the *rule* about when to
  use them rests on the agent following it.
- **The agent is not sandboxed.** It runs with `--permission-mode acceptEdits`
  and can read, search, edit and write anywhere under `VOICE_ROOT`. There is a
  deny list for `secrets/`, `credentials*` and `.env*`, and that is the whole of
  the protection. Choose `VOICE_ROOT` accordingly.
- **The passphrase is the only authentication**, on top of the tailnet. Five bad
  tries lock the gate for fifteen minutes. There are no user accounts.
- **Text goes to Anthropic** (through `claude`) and **reply text goes to
  Microsoft** (through `edge-tts`). Audio goes to whatever `WHISPER_URL` names.

## Relationship to the original

`app/` is a vendored copy of the `voice-chat` app, plus one patch:
`tools/parameterise.py`, which replaces hardcoded machine-specific values with
environment overrides that fall back to the original behaviour. Re-vendor with
`tools/sync-from-source.sh <path-to-voice-chat>`, which re-copies and re-applies
the patch. The patch is the whole diff, and each entry says why it exists.
