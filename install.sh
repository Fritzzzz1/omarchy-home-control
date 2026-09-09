#!/bin/bash
# install.sh — put Jarvis on this machine.
#
# Everything this touches is listed by `./install.sh --dry-run`, and undone by
# ./uninstall.sh. Nothing here needs root: it is all under $HOME, a systemd
# *user* unit, and a `tailscale serve` mapping owned by the logged-in user.

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

UNIT_NAME="jarvis-voice.service"
UNIT_DIR="$CONFIG_HOME/systemd/user"
CONFIG_DIR="$CONFIG_HOME/jarvis-voice"
CONFIG_FILE="$CONFIG_DIR/config.env"
BIN_DIR="$HOME/.local/bin"

# --- defaults -----------------------------------------------------------------
# Deliberately derived from *this* machine at install time, never baked in.
LABEL="$(hostname -s 2>/dev/null || echo voice)"
VOICE_PORT=4455
TTS_PORT=4457
WHISPER_URL=""
VOICE_ROOT="$HOME/dev"
APP_DIR="$DATA_HOME/jarvis-voice/app"
STATE_DIR=""            # defaults to $DATA_HOME/jarvis-voice/state/<label>
VENV_DIR="$DATA_HOME/jarvis-voice/venv"
TAILNET_HOST=""         # discovered from tailscale
TAILNET_PORT=8443
LOCAL_PLAYER="mpv"
NODE_BIN=""
OWNER=""                # who the agent is talking to; default: your full name, else $USER
AGENT_NAME="Jarvis"     # what the agent answers to
DO_SERVE=1
DO_ENABLE=1
DO_VENV=1
DRY_RUN=0
FORCE=0

die() { echo "install: $*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
run() {
  if (( DRY_RUN )); then printf '  would run: %s\n' "$*"; else "$@"; fi
}
write_file() {  # write_file <path> <<<content
  local path="$1" content; content="$(cat)"
  if (( DRY_RUN )); then
    printf '  would write %s (%d bytes)\n' "$path" "${#content}"
  else
    mkdir -p "$(dirname "$path")"
    printf '%s' "$content" >"$path"
  fi
}

usage() {
  sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
  cat <<USAGE

Usage: ./install.sh [options]

  --whisper-url URL     transcription endpoint (required; e.g. http://10.0.0.5:4458)
  --label NAME          instance label, also the state subdirectory  [$LABEL]
  --voice-root DIR      the folder the agent gets as its cwd         [$VOICE_ROOT]
  --port N              local HTTP port                              [$VOICE_PORT]
  --tts-port N          edge-tts worker port                         [$TTS_PORT]
  --app-dir DIR         where the app is installed                   [$APP_DIR]
  --state-dir DIR       transcript, token, logs, audio cache         [\$DATA/jarvis-voice/state/<label>]
  --venv DIR            python venv for edge-tts                     [$VENV_DIR]
  --node PATH           node binary (default: mise shim, else PATH)
  --player CMD          local playback command, mpv or ffplay        [$LOCAL_PLAYER]
  --owner NAME          the name the agent calls you by              [your login name]
  --agent NAME          the name the agent answers to                [$AGENT_NAME]
  --tailnet-host HOST   MagicDNS name (default: asked of tailscale)
  --tailnet-port N      port for tailscale serve                     [$TAILNET_PORT]
  --no-serve            do not touch the tailscale serve config
  --no-venv             do not create the venv / install edge-tts
  --no-enable           install but do not start or enable the unit
  --force               proceed even if the unit is already running
  --dry-run             print every change instead of making it
USAGE
}

while (( $# )); do
  case "$1" in
  --whisper-url) WHISPER_URL="$2"; shift 2 ;;
  --label) LABEL="$2"; shift 2 ;;
  --voice-root) VOICE_ROOT="$2"; shift 2 ;;
  --port) VOICE_PORT="$2"; shift 2 ;;
  --tts-port) TTS_PORT="$2"; shift 2 ;;
  --app-dir) APP_DIR="$2"; shift 2 ;;
  --state-dir) STATE_DIR="$2"; shift 2 ;;
  --venv) VENV_DIR="$2"; shift 2 ;;
  --node) NODE_BIN="$2"; shift 2 ;;
  --player) LOCAL_PLAYER="$2"; shift 2 ;;
  --owner) OWNER="$2"; shift 2 ;;
  --agent) AGENT_NAME="$2"; shift 2 ;;
  --tailnet-host) TAILNET_HOST="$2"; shift 2 ;;
  --tailnet-port) TAILNET_PORT="$2"; shift 2 ;;
  --no-serve) DO_SERVE=0; shift ;;
  --no-venv) DO_VENV=0; shift ;;
  --no-enable) DO_ENABLE=0; shift ;;
  --force) FORCE=1; shift ;;
  --dry-run) DRY_RUN=1; shift ;;
  -h | --help) usage; exit 0 ;;
  *) die "unknown option: $1 (try --help)" ;;
  esac
done

: "${STATE_DIR:=$DATA_HOME/jarvis-voice/state/$LABEL}"
if [[ -z $OWNER ]]; then
  OWNER="$(getent passwd "$USER" 2>/dev/null | cut -d: -f5 | cut -d, -f1)"
  OWNER="${OWNER:-$USER}"
fi

# --- preflight ----------------------------------------------------------------
step "Checking what this machine already has"

[[ -n $WHISPER_URL ]] || die "--whisper-url is required. Jarvis does not transcribe locally;
       it posts audio to a whisper-server endpoint you already run somewhere
       reachable (another machine on your tailnet, or localhost)."

if [[ -z $NODE_BIN ]]; then
  # Prefer the mise *shim* over a versioned install path, so a node upgrade does
  # not silently break the unit.
  if [[ -x $DATA_HOME/mise/shims/node ]]; then NODE_BIN="$DATA_HOME/mise/shims/node"
  else NODE_BIN="$(command -v node || true)"; fi
fi
[[ -n $NODE_BIN && -x $NODE_BIN ]] || die "no node found; pass --node /path/to/node"
note "node        $NODE_BIN ($("$NODE_BIN" --version 2>/dev/null || echo '?'))"

command -v claude >/dev/null || die "the 'claude' CLI is not on PATH; Jarvis has nothing to talk to"
note "claude      $(command -v claude)"
command -v python3 >/dev/null || die "python3 is required to build the edge-tts venv"
command -v curl >/dev/null || die "curl is required"
command -v jq >/dev/null || die "jq is required (the bar widget and jarvis-voice-ctl use it)"

if systemctl --user is-active --quiet "$UNIT_NAME" && (( ! FORCE )) && (( ! DRY_RUN )); then
  die "$UNIT_NAME is already running. Installing over it would restart it and cut off
       any conversation in progress. Re-run with --force when nobody is on the line."
fi

# A port already in use is almost always another instance of this app — including
# an older, differently-named unit. Installing over it would produce a service
# that restart-loops on EADDRINUSE and, worse, might look like it worked.
port_busy() {
  if command -v ss >/dev/null; then
    ss -ltnH "sport = :$1" 2>/dev/null | grep -q .
  else
    curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$1/" 2>/dev/null
  fi
}
for p in "$VOICE_PORT" "$TTS_PORT"; do
  if port_busy "$p"; then
    if (( FORCE )); then
      note "port $p is already in use - continuing because --force was given"
    else
      die "port $p is already in use on this machine. Something is listening there
       (another voice instance, perhaps under a different unit name). Pick a free
       port with --port/--tts-port, or pass --force if you are sure."
    fi
  fi
done

if (( DO_SERVE )); then
  if command -v tailscale >/dev/null; then
    if [[ -z $TAILNET_HOST ]]; then
      TAILNET_HOST="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // ""' | sed 's/\.$//')"
    fi
    [[ -n $TAILNET_HOST ]] || note "tailscale is installed but did not report a MagicDNS name; \
serve will still be configured, but the printed URL may be wrong"
    note "tailnet     ${TAILNET_HOST:-unknown}:$TAILNET_PORT"
  else
    note "tailscale not installed - skipping the serve step (phone access will be LAN-only)"
    DO_SERVE=0
  fi
fi

# --- 1. the app ---------------------------------------------------------------
step "1. Installing the app to $APP_DIR"
run mkdir -p "$APP_DIR"
if (( DRY_RUN )); then
  note "would copy $(find "$PLUGIN_DIR/app" -type f | wc -l) files from $PLUGIN_DIR/app/"
else
  cp -a "$PLUGIN_DIR/app/." "$APP_DIR/"
fi

# --- 2. the venv --------------------------------------------------------------
step "2. Python venv for edge-tts"
TTS_PYTHON="$VENV_DIR/bin/python"
if (( DO_VENV )); then
  if [[ -x $TTS_PYTHON ]]; then
    note "reusing existing venv at $VENV_DIR"
  else
    run python3 -m venv "$VENV_DIR"
  fi
  run "$TTS_PYTHON" -m pip install --quiet --upgrade pip
  run "$TTS_PYTHON" -m pip install --quiet edge-tts
else
  note "skipped (--no-venv); expecting an edge-tts python at $TTS_PYTHON"
fi

# tts.py is executed directly, so its shebang decides which python runs it.
# The shipped copy points at wherever it was packaged; repoint it here.
if (( ! DRY_RUN )); then
  [[ -f $APP_DIR/tts.py ]] || die "tts.py missing from the payload at $APP_DIR"
  sed -i "1s|.*|#!$TTS_PYTHON|" "$APP_DIR/tts.py"
  chmod +x "$APP_DIR/tts.py"
  note "tts.py shebang -> $TTS_PYTHON"
else
  note "would rewrite $APP_DIR/tts.py shebang to #!$TTS_PYTHON"
fi

# The agent's voice persona names the person it is talking to and the machine it
# runs on, so it is rendered here rather than shipped with someone else's name in it.
step "2b. Rendering the voice persona (owner: $OWNER, agent: $AGENT_NAME)"
if (( DRY_RUN )); then
  note "would render $APP_DIR/voice-mode.md from voice-mode.md.in"
else
  sed -e "s|__OWNER__|$OWNER|g" -e "s|__AGENT__|$AGENT_NAME|g" -e "s|__LABEL__|$LABEL|g" \
    "$PLUGIN_DIR/app/voice-mode.md.in" >"$APP_DIR/voice-mode.md"
  note "$APP_DIR/voice-mode.md — edit it to change how the agent speaks"
fi

# --- 3. state -----------------------------------------------------------------
step "3. State directory $STATE_DIR"
run mkdir -p "$STATE_DIR"
note "transcript, passphrase token, logs and the audio cache live here"
note "it is never deleted by uninstall unless you pass --purge"

# --- 4. config ----------------------------------------------------------------
step "4. Config $CONFIG_FILE"
write_file "$CONFIG_FILE" <<EOF
# Jarvis — every machine-specific value, in one file.
# Read by the systemd unit (EnvironmentFile) and by jarvis-voice-ctl.
# Edit, then: systemctl --user restart $UNIT_NAME   (not while someone is talking)

# Where the agent runs. This is the folder Jarvis can read, search and edit.
VOICE_ROOT=$VOICE_ROOT
VOICE_LABEL=$LABEL
VOICE_STATE=$STATE_DIR
VOICE_TOKEN=$STATE_DIR/voice-token

# Ports. VOICE_PORT is bound on 127.0.0.1 only.
VOICE_PORT=$VOICE_PORT
TTS_PORT=$TTS_PORT

# Transcription. Jarvis runs no local model; this endpoint does the work.
WHISPER_URL=$WHISPER_URL

# Local playback of replies on this machine's own speakers (mpv or ffplay).
VOICE_LOCAL_PLAYER=$LOCAL_PLAYER

# Who the agent thinks it is talking to. Used when a long reply is rewritten for
# the ear, so the pronouns stay right.
VOICE_OWNER=$OWNER

# The edge-tts CLI, used only as a fallback when the warm TTS worker is down.
VOICE_EDGE_TTS=$VENV_DIR/bin/edge-tts

# Optional: pin the model / thinking effort. Unset = the claude CLI's defaults.
#VOICE_MODEL=
#VOICE_EFFORT=low

# Used by jarvis-voice-ctl and the bar widget to build the phone URL.
JARVIS_TAILNET_HOST=$TAILNET_HOST
JARVIS_TAILNET_PORT=$TAILNET_PORT
JARVIS_TTS_PYTHON=$TTS_PYTHON
JARVIS_APP_DIR=$APP_DIR

# The unit inherits no PATH from a login shell. node, claude and the player must
# all be findable here.
PATH=$(dirname "$NODE_BIN"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
EOF

# --- 5. the unit --------------------------------------------------------------
step "5. systemd user unit $UNIT_DIR/$UNIT_NAME"
UNIT_TEXT="$(sed \
  -e "s|__PLUGIN_DIR__|$PLUGIN_DIR|g" \
  -e "s|__APP_DIR__|$APP_DIR|g" \
  -e "s|__CONFIG_FILE__|$CONFIG_FILE|g" \
  -e "s|__NODE__|$NODE_BIN|g" \
  "$PLUGIN_DIR/systemd/jarvis-voice.service.in")"

# Verify a throwaway copy before it can ever be loaded.
VERIFY_DIR="$(mktemp -d)"
printf '%s' "$UNIT_TEXT" >"$VERIFY_DIR/$UNIT_NAME"
if systemd-analyze verify "$VERIFY_DIR/$UNIT_NAME" 2>&1 | grep -v '^$'; then
  note "systemd-analyze verify reported the above (warnings are usually harmless)"
else
  note "systemd-analyze verify: clean"
fi
rm -rf "$VERIFY_DIR"

write_file "$UNIT_DIR/$UNIT_NAME" <<<"$UNIT_TEXT"

# --- 6. the control command ---------------------------------------------------
step "6. jarvis-voice-ctl -> $BIN_DIR"
run mkdir -p "$BIN_DIR"
run ln -sf "$PLUGIN_DIR/bin/jarvis-voice-ctl" "$BIN_DIR/jarvis-voice-ctl"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) note "note: $BIN_DIR is not on your PATH" ;; esac

# --- 7. start -----------------------------------------------------------------
step "7. Enabling"
run systemctl --user daemon-reload
if (( DO_ENABLE )); then
  # Linger keeps the user manager alive after logout, so Jarvis survives a reboot
  # with nobody logged in. This is the only step that may ask for a password.
  if [[ "$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null)" != yes ]]; then
    note "enabling linger so the service survives logout/reboot"
    run loginctl enable-linger "$USER"
  else
    note "linger already enabled"
  fi
  run systemctl --user enable --now "$UNIT_NAME"
else
  note "skipped (--no-enable). Start it with: systemctl --user enable --now $UNIT_NAME"
fi

# --- 8. tailscale serve -------------------------------------------------------
step "8. tailscale serve"
if (( DO_SERVE )); then
  note "mapping https://${TAILNET_HOST:-<this machine>}:$TAILNET_PORT -> http://127.0.0.1:$VOICE_PORT"
  note "tailnet only; Funnel is NOT enabled"
  run tailscale serve --bg --https "$TAILNET_PORT" "http://127.0.0.1:$VOICE_PORT"
else
  note "skipped"
fi

# --- done ---------------------------------------------------------------------
cat <<DONE

Installed.

  URL         $( [[ -n $TAILNET_HOST ]] && echo "https://$TAILNET_HOST:$TAILNET_PORT" || echo "http://127.0.0.1:$VOICE_PORT" )
  passphrase  $STATE_DIR/voice-token   (generated on first start)
  status      jarvis-voice-ctl status
  logs        jarvis-voice-ctl logs -f
  check deps  jarvis-voice-ctl doctor

On the phone: join the same tailnet, open the URL, type the passphrase, add to
the home screen so iOS keeps the microphone permission.

Optional bar widget:  omarchy plugin enable jarvis.voice
DONE
