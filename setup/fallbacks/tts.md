# TTS fallback: edge-tts

Used when the user has no existing TTS solution on their private network. This is the shipped
default and already works — nothing here is speculative.

## Install

    python3 -m venv <venv-dir>
    <venv-dir>/bin/python -m pip install --upgrade pip
    <venv-dir>/bin/python -m pip install edge-tts

`app/tts.py` is executed directly, so its shebang decides which Python runs it — repoint the
first line at `<venv-dir>/bin/python` and `chmod +x` it.

## Voice

Pick an edge-tts voice matched to the chosen language (e.g. `he-IL-AvriNeural` for Hebrew,
`en-US-...` for English) — `edge-tts --list-voices` lists what's available.

## Wire-up

`server.mjs` spawns `tts.py` itself on `TTS_PORT` (127.0.0.1 only); it needs `VOICE_EDGE_TTS`
pointed at `<venv-dir>/bin/edge-tts` as a fallback path for when the warm worker is down.
