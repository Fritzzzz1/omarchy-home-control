#!/bin/bash
# uninstall.sh — undo install.sh. Reference material for an agent, not a tool
# anyone runs by hand — no dialogue of its own, the agent already confirmed
# with the user what to remove before passing --force.
#
# By default this removes the moving parts and leaves your data alone: the
# transcript, the passphrase and the logs survive unless you ask for --purge.
# It never touches VOICE_ROOT — that is your own folder, not ours — except the two relay
# skills install.sh put in its .claude/skills.

set -euo pipefail

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
UNIT_NAME="home-control.service"
DASHBOARD_UNIT_NAME="home-control-dashboard.service"
UNIT_FILE="$CONFIG_HOME/systemd/user/$UNIT_NAME"
DASHBOARD_UNIT_FILE="$CONFIG_HOME/systemd/user/$DASHBOARD_UNIT_NAME"
CONFIG_FILE="$CONFIG_HOME/home-control/config.env"
BIN_LINK="$HOME/.local/bin/home-control-ctl"

PURGE=0
FORCE=0

for a in "$@"; do
  case "$a" in
  --purge) PURGE=1 ;;
  --force) FORCE=1 ;;
  *) echo "uninstall: unknown option: $a" >&2; exit 1 ;;
  esac
done

note() { printf '  %s\n' "$*"; }
rm_path() {
  [[ -e $1 || -L $1 ]] || { note "already gone: $1"; return; }
  rm -rf -- "$1"; note "removed $1"
}

# Read the config before deleting it: it is the only record of which port and
# which directories this install used. It is data, never shell code.
load_config() {
  [[ -f $CONFIG_FILE ]] || return 0
  local line key value
  while IFS= read -r line || [[ -n $line ]]; do
    [[ -z $line || $line == \#* ]] && continue
    [[ $line =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    case "$key" in
      VOICE_PORT|VOICE_ROOT|VOICE_STATE|HOME_CONTROL_TAILNET_PORT|HOME_CONTROL_APP_DIR|WHISPER_MODEL)
        printf -v "$key" '%s' "$value" ;;
    esac
  done < "$CONFIG_FILE"
}
load_config
VOICE_PORT="${VOICE_PORT:-4455}"
HOME_CONTROL_TAILNET_PORT="${HOME_CONTROL_TAILNET_PORT:-8443}"

if systemctl --user is-active --quiet "$UNIT_NAME" && (( ! FORCE )); then
  echo "uninstall: $UNIT_NAME is running and would end any conversation in progress." >&2
  echo "           confirm with the user, then pass --force." >&2
  exit 1
fi

echo "== Service"
systemctl --user disable --now "$DASHBOARD_UNIT_NAME" || true
rm_path "$DASHBOARD_UNIT_FILE"
systemctl --user disable --now "$UNIT_NAME" || true
rm_path "$UNIT_FILE"
systemctl --user daemon-reload
systemctl --user reset-failed "$UNIT_NAME" "$DASHBOARD_UNIT_NAME" || true

echo "== tailscale serve"
if command -v tailscale >/dev/null; then
  note "removing the https:$HOME_CONTROL_TAILNET_PORT -> 127.0.0.1:$VOICE_PORT mapping"
  tailscale serve --https "$HOME_CONTROL_TAILNET_PORT" off || true
else
  note "tailscale not installed; nothing to undo"
fi

echo "== Command"
rm_path "$BIN_LINK"

echo "== Generated files"
# Home Control runs from its clone; install wrote only these two there (git ignores them).
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/app"
rm_path "$APP_DIR/voice-mode.md"
rm_path "$APP_DIR/manifest.json"

echo "== Relay skills"
if [[ -n ${VOICE_ROOT:-} ]]; then
  rm_path "$VOICE_ROOT/.claude/skills/relay-mode"
  rm_path "$VOICE_ROOT/.claude/skills/voice-relay"
else
  note "VOICE_ROOT unknown; nothing to remove"
fi

echo "== Config"
rm_path "$CONFIG_FILE"
[[ -d $CONFIG_HOME/home-control ]] && rmdir --ignore-fail-on-non-empty "$CONFIG_HOME/home-control" 2>/dev/null || true

if (( PURGE )); then
  echo "== Purging data"
  note "about to delete, irreversibly:"
  note "  ${VOICE_STATE:-$DATA_HOME/home-control/state}  (transcript, passphrase, logs)"
  note "  $DATA_HOME/home-control/venv"
  if [[ -n ${WHISPER_MODEL:-} && -e $WHISPER_MODEL ]]; then
    note "  $WHISPER_MODEL  (your local whisper model — this can be several GB, and is not re-downloaded by uninstall)"
  fi
  if (( ! FORCE )); then
    echo "uninstall: --purge needs --force too — confirm the list above with the user first." >&2
    exit 1
  fi
  rm_path "${VOICE_STATE:-$DATA_HOME/home-control/state}"
  rm_path "$DATA_HOME/home-control/venv"
  # Only if empty: the clone itself may live in here.
  rmdir --ignore-fail-on-non-empty "$DATA_HOME/home-control" 2>/dev/null || true
else
  echo "== Kept (use --purge to remove)"
  note "state  ${VOICE_STATE:-$DATA_HOME/home-control/state/...}  (transcript, passphrase, logs)"
  note "venv   $DATA_HOME/home-control/venv"
fi

cat <<'DONE'

Uninstalled.

Not touched, on purpose:
  - VOICE_ROOT (your own folder), apart from the relay skills above
  - this folder (your clone of Home Control)
  - user linger  (loginctl disable-linger $USER, if nothing else needs it)
  - node, claude, tailscale, mpv
DONE
