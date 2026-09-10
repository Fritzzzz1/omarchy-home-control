#!/bin/bash
# Re-vendor app/ from a working voice-chat checkout, then re-apply the
# portability patch. Read-only with respect to the source: it only copies out.
#
#   tools/sync-from-source.sh ~/dev/voice-chat

set -euo pipefail
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${1:?usage: sync-from-source.sh <path-to-voice-chat>}"
SRC="$(cd "$SRC" && pwd)"

[[ -f $SRC/server.mjs ]] || { echo "no server.mjs in $SRC" >&2; exit 1; }

FILES=(index.html login.html monitor.html monitor.mjs server.mjs tts.py
  voice-mode.md favicon-32.png icon-192.png icon-512.png
  apple-touch-icon.png icon-source.svg)
# manifest.json is deliberately absent: like voice-mode.md.in, the PWA manifest
# is now a hand-maintained template (app/manifest.json.in) rendered by install.sh
# per machine, not vendored from source. mic.html: dropped, not vendored either.

echo "Vendoring from $SRC"
for f in "${FILES[@]}"; do
  [[ -e $SRC/$f ]] && cp -a "$SRC/$f" "$PLUGIN_DIR/app/$f" && echo "  $f" || echo "  (skipped, absent: $f)"
done
[[ -d $SRC/tests ]] && rm -rf "$PLUGIN_DIR/app/tests" && cp -a "$SRC/tests" "$PLUGIN_DIR/app/tests" && echo "  tests/"

# install.sh copies app/ with `cp -a`, which preserves symlinks as symlinks — one
# pointing at a path that only exists on this dev machine would silently break
# on whatever machine actually installs Home Control.
if find "$PLUGIN_DIR/app" -type l -print -quit | grep -q .; then
  echo "error: symlinks landed in app/; they won't survive being copied to another machine" >&2
  exit 1
fi

echo
echo "Re-applying the portability patch:"
python3 "$PLUGIN_DIR/tools/parameterise.py"

echo
echo "voice-mode.md.in is NOT regenerated - it is hand-maintained. Diff it against"
echo "the new app/voice-mode.md if the persona changed upstream."
