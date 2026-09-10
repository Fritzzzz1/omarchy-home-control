#!/bin/bash
# install.sh — reference material for the agent running setup/SETUP.md, not a
# tool anyone runs by hand. It shows the actual shape of every piece (systemd
# units, config.env, the venv, the render steps) so an agent can copy, adapt,
# or run it directly with known values. Nothing here needs root: it is all
# under $HOME, a systemd *user* unit, and a `tailscale serve` mapping owned by
# the logged-in user.

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"

UNIT_NAME="home-control.service"
DASHBOARD_UNIT_NAME="home-control-dashboard.service"
UNIT_DIR="$CONFIG_HOME/systemd/user"
CONFIG_DIR="$CONFIG_HOME/home-control"
CONFIG_FILE="$CONFIG_DIR/config.env"
BIN_DIR="$HOME/.local/bin"

# --- values -------------------------------------------------------------------
# Fill these from what the setup conversation already decided, or pass them as
# flags. Nothing here is asked interactively — this script has no dialogue of
# its own, the agent already had that conversation.
LABEL="$(hostname -s 2>/dev/null || echo voice)"
VOICE_PORT=4455
TTS_PORT=4457
MONITOR_PORT=4458
WHISPER_URL=""
WHISPER_MODEL=""
VOICE_ROOT="$HOME"
APP_DIR="$DATA_HOME/home-control/app"
STATE_DIR=""            # defaults to $DATA_HOME/home-control/state/<label>
VENV_DIR="$DATA_HOME/home-control/venv"
TAILNET_HOST=""         # discovered from tailscale
TAILNET_PORT=8443
LOCAL_PLAYER="mpv"
NODE_BIN=""
OWNER=""                # who the agent is talking to; default: $USER's full name
AGENT_NAME="Home Control"
PWA_NAME="Home"
SPEECH_REWRITE="on"
PEER_DELEGATION=""      # "" = on if claude is on PATH, else off
DO_SERVE=1
DO_ENABLE=1
DO_VENV=1
FORCE=0

die() { echo "install: $*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
write_file() { mkdir -p "$(dirname "$1")"; cat >"$1"; }  # write_file <path> <<<content

while (( $# )); do
  case "$1" in
  --whisper-url) WHISPER_URL="$2"; shift 2 ;;
  --whisper-model) WHISPER_MODEL="$2"; shift 2 ;;
  --label) LABEL="$2"; shift 2 ;;
  --voice-root) VOICE_ROOT="$2"; shift 2 ;;
  --port) VOICE_PORT="$2"; shift 2 ;;
  --tts-port) TTS_PORT="$2"; shift 2 ;;
  --monitor-port) MONITOR_PORT="$2"; shift 2 ;;
  --app-dir) APP_DIR="$2"; shift 2 ;;
  --state-dir) STATE_DIR="$2"; shift 2 ;;
  --venv) VENV_DIR="$2"; shift 2 ;;
  --node) NODE_BIN="$2"; shift 2 ;;
  --player) LOCAL_PLAYER="$2"; shift 2 ;;
  --owner) OWNER="$2"; shift 2 ;;
  --agent) AGENT_NAME="$2"; shift 2 ;;
  --pwa-name) PWA_NAME="$2"; shift 2 ;;
  --speech-rewrite)
    case "$2" in on | off) SPEECH_REWRITE="$2" ;; *) die "--speech-rewrite takes 'on' or 'off'" ;; esac
    shift 2
    ;;
  --peer-delegation)
    case "$2" in on | off) PEER_DELEGATION="$2" ;; *) die "--peer-delegation takes 'on' or 'off'" ;; esac
    shift 2
    ;;
  --tailnet-host) TAILNET_HOST="$2"; shift 2 ;;
  --tailnet-port) TAILNET_PORT="$2"; shift 2 ;;
  --no-serve) DO_SERVE=0; shift ;;
  --no-venv) DO_VENV=0; shift ;;
  --no-enable) DO_ENABLE=0; shift ;;
  --force) FORCE=1; shift ;;
  *) die "unknown option: $1" ;;
  esac
done

: "${STATE_DIR:=$DATA_HOME/home-control/state/$LABEL}"
if [[ -z $OWNER ]]; then
  OWNER="$(getent passwd "$USER" 2>/dev/null | cut -d: -f5 | cut -d, -f1)"
  OWNER="${OWNER:-$USER}"
fi
# ListAgents/SendMessage are Claude Code's own tools, so delegation only makes sense there.
if [[ -z $PEER_DELEGATION ]]; then
  command -v claude >/dev/null && PEER_DELEGATION=on || PEER_DELEGATION=off
fi

# --- preflight ----------------------------------------------------------------
step "Checking what this machine already has"

if [[ -n $WHISPER_URL && -n $WHISPER_MODEL ]]; then
  die "choose either --whisper-url or --whisper-model, not both"
elif [[ -z $WHISPER_URL && -z $WHISPER_MODEL ]]; then
  die "choose --whisper-url for a remote endpoint or --whisper-model for local transcription"
elif [[ -n $WHISPER_MODEL ]]; then
  [[ -f $WHISPER_MODEL ]] || die "local Whisper model not found: $WHISPER_MODEL"
  command -v whisper-server >/dev/null || die "--whisper-model needs whisper-server on PATH"
  note "whisper     local model $WHISPER_MODEL"
else
  note "whisper     remote endpoint $WHISPER_URL"
fi

if [[ -z $NODE_BIN ]]; then
  # Prefer the mise *shim* over a versioned install path, so a node upgrade does
  # not silently break the unit.
  if [[ -x $DATA_HOME/mise/shims/node ]]; then NODE_BIN="$DATA_HOME/mise/shims/node"
  else NODE_BIN="$(command -v node || true)"; fi
fi
[[ -n $NODE_BIN && -x $NODE_BIN ]] || die "no node found; pass --node /path/to/node"
note "node        $NODE_BIN ($("$NODE_BIN" --version 2>/dev/null || echo '?'))"

command -v claude >/dev/null || die "the 'claude' CLI is not on PATH; there is nothing for it to talk to"
note "claude      $(command -v claude)"
command -v python3 >/dev/null || die "python3 is required to build the edge-tts venv"
command -v curl >/dev/null || die "curl is required"
command -v jq >/dev/null || die "jq is required (home-control-ctl uses it)"

if systemctl --user is-active --quiet "$UNIT_NAME" >/dev/null 2>&1 && (( ! FORCE )); then
  die "$UNIT_NAME is already running. Installing over it would restart it and cut off
       any conversation in progress. Pass --force when nobody is on the line."
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
for p in "$VOICE_PORT" "$TTS_PORT" "$MONITOR_PORT"; do
  if port_busy "$p"; then
    if (( FORCE )); then
      note "port $p is already in use - continuing because --force was given"
    else
      die "port $p is already in use on this machine. Pick a free port with
       --port/--tts-port/--monitor-port, or pass --force if you are sure."
    fi
  fi
done

note "cross-session delegation: $PEER_DELEGATION"
note "speech rewrite pass: $SPEECH_REWRITE"
note "home-screen icon: $PWA_NAME"

if (( DO_SERVE )); then
  if command -v tailscale >/dev/null; then
    if [[ -z $TAILNET_HOST ]]; then
      TAILNET_HOST="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // ""' | sed 's/\.$//')"
    fi
    [[ -n $TAILNET_HOST ]] || note "tailscale is installed but did not report a MagicDNS name; \
serve will still be configured, but the printed URL may be wrong"
    note "tailnet     ${TAILNET_HOST:-unknown}:$TAILNET_PORT"
  else
    note "tailscale not installed - skipping the serve step. The server binds 127.0.0.1 only, \
so without Tailscale the phone cannot reach it at all, not even on the same LAN"
    DO_SERVE=0
  fi
fi

# --- 1. the app ---------------------------------------------------------------
step "1. Installing the app to $APP_DIR"
mkdir -p "$APP_DIR"
cp -a "$PLUGIN_DIR/app/." "$APP_DIR/"

# --- 2. the venv --------------------------------------------------------------
step "2. Python venv for edge-tts"
TTS_PYTHON="$VENV_DIR/bin/python"
if (( DO_VENV )); then
  [[ -x $TTS_PYTHON ]] || python3 -m venv "$VENV_DIR"
  "$TTS_PYTHON" -m pip install --quiet --upgrade pip
  "$TTS_PYTHON" -m pip install --quiet edge-tts
else
  note "skipped (--no-venv); expecting an edge-tts python at $TTS_PYTHON"
fi

# tts.py is executed directly, so its shebang decides which python runs it.
# The shipped copy points at wherever it was packaged; repoint it here.
[[ -f $APP_DIR/tts.py ]] || die "tts.py missing from the payload at $APP_DIR"
sed -i "1s|.*|#!$TTS_PYTHON|" "$APP_DIR/tts.py"
chmod +x "$APP_DIR/tts.py"
note "tts.py shebang -> $TTS_PYTHON"

# The agent's voice persona names the person it is talking to and the machine it
# runs on, so it is rendered here rather than shipped with someone else's name in it.
step "2b. Rendering the voice persona (owner: $OWNER, agent: $AGENT_NAME)"
# Splice in whichever delegation guidance matches the answer above, then
# substitute the names. The agent is told the rule in both cases - when the
# capability is off it is told plainly that it is off and why.
_block="$PLUGIN_DIR/app/delegation.$PEER_DELEGATION.md"
sed -e "/__DELEGATION_BLOCK__/r $_block" -e "/__DELEGATION_BLOCK__/d" \
  "$PLUGIN_DIR/app/voice-mode.md.in" \
  | sed -e "s|__OWNER__|$OWNER|g" -e "s|__AGENT__|$AGENT_NAME|g" -e "s|__LABEL__|$LABEL|g" \
  >"$APP_DIR/voice-mode.md"
note "$APP_DIR/voice-mode.md — edit it to change how the agent speaks"
note "delegation guidance: $(basename "$_block")"
# The phone page's reply label reads the same __AGENT__ placeholder, upper-cased
# to match the label style already used for "YOU".
sed -i "s|__AGENT__|${AGENT_NAME^^}|g" "$APP_DIR/index.html"

# The PWA manifest names the home-screen icon; it is rendered per install for
# the same reason voice-mode.md is - "Home" baked in is wrong the moment a
# second machine on the same phone also wants to be called Home.
step "2c. Naming the home-screen icon ($PWA_NAME)"
sed -e "s|__PWA_NAME__|$PWA_NAME|g" -e "s|__LABEL__|$LABEL|g" \
  "$PLUGIN_DIR/app/manifest.json.in" \
  >"$APP_DIR/manifest.json"
# iOS Safari uses apple-mobile-web-app-title for the home-screen label ahead of
# the manifest's name, so it has to carry the same name or the icon still says
# "Home" no matter what the manifest says.
sed -i "s|__PWA_NAME__|$PWA_NAME|g" "$APP_DIR/index.html" "$APP_DIR/login.html"

# --- 3. state -----------------------------------------------------------------
step "3. State directory $STATE_DIR"
mkdir -p "$STATE_DIR"
note "transcript, passphrase token, logs and the audio cache live here"
note "it is never deleted by uninstall unless you pass --purge"

# --- 4. config ----------------------------------------------------------------
step "4. Config $CONFIG_FILE"
write_file "$CONFIG_FILE" <<EOF
# Home Control — every machine-specific value, in one file.
# Read by the systemd unit (EnvironmentFile) and by home-control-ctl. This is
# data, not a shell script: each value is everything after its first '='.
# Edit, then: systemctl --user restart $UNIT_NAME   (not while someone is talking)

# Where the agent runs. This is the folder Home Control can read, search and edit.
VOICE_ROOT=$VOICE_ROOT
VOICE_LABEL=$LABEL
VOICE_STATE=$STATE_DIR
VOICE_TOKEN=$STATE_DIR/voice-token

# Ports. VOICE_PORT is bound on 127.0.0.1 only.
VOICE_PORT=$VOICE_PORT
TTS_PORT=$TTS_PORT
MONITOR_PORT=$MONITOR_PORT

# Transcription. Set exactly one: a remote whisper-server endpoint, or a local
# model. With a local model, server.mjs starts whisper-server on demand.
WHISPER_URL=$WHISPER_URL
WHISPER_MODEL=$WHISPER_MODEL

# Local playback of replies on this machine's own speakers (mpv or ffplay).
VOICE_LOCAL_PLAYER=$LOCAL_PLAYER

# Who the agent thinks it is talking to. Used when a long reply is rewritten for
# the ear, so the pronouns stay right.
VOICE_OWNER=$OWNER

# The edge-tts CLI, used only as a fallback when the warm TTS worker is down.
VOICE_EDGE_TTS=$VENV_DIR/bin/edge-tts

# Reword long/formatted replies for speech via an extra model call before TTS.
# "off" disables it; anything else (including unset) is on.
VOICE_SPEECH_REWRITE=$SPEECH_REWRITE

# May the agent hand work to another live Claude Code session on this machine?
# "on" adds ListAgents and SendMessage to the tools it is allowed to use.
# Change it here and re-render voice-mode.md to keep the two in step. A missing
# tool is a reason to delegate; a denied action is not.
VOICE_PEER_DELEGATION=$PEER_DELEGATION

# Optional: pin the model / thinking effort. Unset = the claude CLI's defaults.
#VOICE_MODEL=
#VOICE_EFFORT=low

# Used by home-control-ctl to build the phone URL.
HOME_CONTROL_TAILNET_HOST=$TAILNET_HOST
HOME_CONTROL_TAILNET_PORT=$TAILNET_PORT
HOME_CONTROL_TTS_PYTHON=$TTS_PYTHON
HOME_CONTROL_APP_DIR=$APP_DIR

# The unit inherits no PATH from a login shell. node, claude and the player must
# all be findable here.
PATH=$(dirname "$NODE_BIN"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
EOF

# --- 5. the units ---------------------------------------------------------------
render_unit() {  # render_unit <unit.service.in> <unit-name>
  local text
  text="$(sed \
    -e "s|__PLUGIN_DIR__|$PLUGIN_DIR|g" -e "s|__APP_DIR__|$APP_DIR|g" \
    -e "s|__CONFIG_FILE__|$CONFIG_FILE|g" -e "s|__NODE__|$NODE_BIN|g" \
    "$PLUGIN_DIR/systemd/$1")"
  # Verify a throwaway copy before it can ever be loaded.
  local vdir; vdir="$(mktemp -d)"
  printf '%s' "$text" >"$vdir/$2"
  if systemd-analyze verify "$vdir/$2" 2>&1 | grep -v '^$'; then
    note "systemd-analyze verify reported the above (warnings are usually harmless)"
  else
    note "systemd-analyze verify: clean"
  fi
  rm -rf "$vdir"
  write_file "$UNIT_DIR/$2" <<<"$text"
}
step "5. systemd user unit $UNIT_DIR/$UNIT_NAME"
render_unit home-control.service.in "$UNIT_NAME"
step "5b. systemd user unit $UNIT_DIR/$DASHBOARD_UNIT_NAME"
render_unit home-control-dashboard.service.in "$DASHBOARD_UNIT_NAME"

# --- 6. the control command ---------------------------------------------------
step "6. home-control-ctl -> $BIN_DIR"
mkdir -p "$BIN_DIR"
ln -sf "$PLUGIN_DIR/bin/home-control-ctl" "$BIN_DIR/home-control-ctl"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) note "note: $BIN_DIR is not on your PATH" ;; esac

# --- 7. start -----------------------------------------------------------------
step "7. Enabling"
systemctl --user daemon-reload
if (( DO_ENABLE )); then
  # Linger keeps the user manager alive after logout, so Home Control survives a reboot
  # with nobody logged in. This is the only step that may ask for a password.
  if [[ "$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null)" != yes ]]; then
    note "enabling linger so the service survives logout/reboot"
    loginctl enable-linger "$USER"
  else
    note "linger already enabled"
  fi
  systemctl --user enable --now "$UNIT_NAME"
  systemctl --user enable --now "$DASHBOARD_UNIT_NAME"
else
  note "skipped (--no-enable). Start with: systemctl --user enable --now $UNIT_NAME $DASHBOARD_UNIT_NAME"
fi

# --- 8. tailscale serve -------------------------------------------------------
step "8. tailscale serve"
if (( DO_SERVE )); then
  note "mapping https://${TAILNET_HOST:-<this machine>}:$TAILNET_PORT -> http://127.0.0.1:$VOICE_PORT"
  note "tailnet only; Funnel is NOT enabled"
  tailscale serve --bg --https "$TAILNET_PORT" "http://127.0.0.1:$VOICE_PORT"
else
  note "skipped"
fi

# --- done ---------------------------------------------------------------------
cat <<DONE

Installed.

  URL         $( [[ -n $TAILNET_HOST ]] && echo "https://$TAILNET_HOST:$TAILNET_PORT" || echo "http://127.0.0.1:$VOICE_PORT" )
  passphrase  $STATE_DIR/voice-token   (generated on first start)
  status      home-control-ctl status
  logs        home-control-ctl logs -f
  check deps  home-control-ctl doctor

On the phone: join the same tailnet, open the URL, type the passphrase, add to
the home screen so iOS keeps the microphone permission.
DONE
