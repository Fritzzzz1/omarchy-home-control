#!/bin/bash
# uninstall.sh — undo install.sh.
#
# By default this removes the moving parts and leaves your data alone: the
# transcript, the passphrase and the logs survive unless you ask for --purge.
# It never touches VOICE_ROOT — that is your own folder, not ours.

set -euo pipefail

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
UNIT_NAME="jarvis-voice.service"
UNIT_FILE="$CONFIG_HOME/systemd/user/$UNIT_NAME"
CONFIG_FILE="$CONFIG_HOME/jarvis-voice/config.env"
BIN_LINK="$HOME/.local/bin/jarvis-voice-ctl"

PURGE=0
DRY_RUN=0
FORCE=0

for a in "$@"; do
  case "$a" in
  --purge) PURGE=1 ;;
  --dry-run) DRY_RUN=1 ;;
  --force) FORCE=1 ;;
  -h | --help)
    cat <<'USAGE'
Usage: ./uninstall.sh [--purge] [--force] [--dry-run]

  (default)   stop and remove the service, the unit, the tailscale serve mapping
              and the jarvis-voice-ctl link. Keeps state, the venv and the app.
  --purge     also delete the installed app, the venv and the state directory
              (transcript, passphrase, logins, logs, audio cache). Irreversible.
  --force     do not ask before stopping a running service.
  --dry-run   print what would happen.

Never touches VOICE_ROOT, and never touches the Omarchy plugin folder itself
(remove that with: omarchy plugin remove jarvis.voice).
USAGE
    exit 0
    ;;
  *) echo "uninstall: unknown option: $a" >&2; exit 1 ;;
  esac
done

note() { printf '  %s\n' "$*"; }
run() { if (( DRY_RUN )); then printf '  would run: %s\n' "$*"; else "$@" || true; fi; }
rm_path() {
  [[ -e $1 || -L $1 ]] || { note "already gone: $1"; return; }
  if (( DRY_RUN )); then printf '  would remove: %s\n' "$1"; else rm -rf -- "$1"; note "removed $1"; fi
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
      VOICE_PORT|VOICE_STATE|JARVIS_TAILNET_PORT|JARVIS_APP_DIR)
        printf -v "$key" '%s' "$value" ;;
    esac
  done < "$CONFIG_FILE"
}
load_config
VOICE_PORT="${VOICE_PORT:-4455}"
JARVIS_TAILNET_PORT="${JARVIS_TAILNET_PORT:-8443}"

if systemctl --user is-active --quiet "$UNIT_NAME" && (( ! FORCE )) && (( ! DRY_RUN )); then
  read -r -p "$UNIT_NAME is running. Stopping it ends any conversation in progress. Continue? [y/N] " a
  [[ $a == [yY]* ]] || { echo "aborted"; exit 1; }
fi

echo "== Service"
run systemctl --user disable --now "$UNIT_NAME"
rm_path "$UNIT_FILE"
run systemctl --user daemon-reload
run systemctl --user reset-failed "$UNIT_NAME"

echo "== tailscale serve"
if command -v tailscale >/dev/null; then
  note "removing the https:$JARVIS_TAILNET_PORT -> 127.0.0.1:$VOICE_PORT mapping"
  run tailscale serve --https "$JARVIS_TAILNET_PORT" off
else
  note "tailscale not installed; nothing to undo"
fi

echo "== Command"
rm_path "$BIN_LINK"

echo "== Config"
rm_path "$CONFIG_FILE"
[[ -d $CONFIG_HOME/jarvis-voice ]] && rmdir --ignore-fail-on-non-empty "$CONFIG_HOME/jarvis-voice" 2>/dev/null || true

if (( PURGE )); then
  echo "== Purging data"
  rm_path "${JARVIS_APP_DIR:-$DATA_HOME/jarvis-voice/app}"
  rm_path "${VOICE_STATE:-$DATA_HOME/jarvis-voice/state}"
  rm_path "$DATA_HOME/jarvis-voice/venv"
  rm_path "$DATA_HOME/jarvis-voice"
else
  echo "== Kept (use --purge to remove)"
  note "app    ${JARVIS_APP_DIR:-$DATA_HOME/jarvis-voice/app}"
  note "state  ${VOICE_STATE:-$DATA_HOME/jarvis-voice/state/...}  (transcript, passphrase, logs)"
  note "venv   $DATA_HOME/jarvis-voice/venv"
fi

cat <<'DONE'

Uninstalled.

Not touched, on purpose:
  - VOICE_ROOT (your own folder)
  - user linger  (loginctl disable-linger $USER, if nothing else needs it)
  - the Omarchy plugin folder  (omarchy plugin remove jarvis.voice)
  - node, claude, tailscale, mpv
DONE
