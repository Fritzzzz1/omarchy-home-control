# Transcription fallback: local whisper.cpp

Used when the user has no existing transcription solution on their private network.

## Install

**Arch/Omarchy**: `whisper-cpp` is in the official `extra` repo — `sudo pacman -S whisper-cpp`,
no AUR helper needed. It installs `/usr/bin/whisper-server` — the exact binary name `server.mjs`
already spawns, no symlink or rename required.

**Any other distro**: no equivalent guarantee. Research the actual install path on what you find
rather than assuming this package name exists there too.

## Model

The packaged binary does not include a model-download script. Fetch a GGML model directly from
Hugging Face:

    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-<name>.bin

Pick `<name>` by chosen language and this machine's hardware — there's no fixed rule, but as a
starting point: `small`/`small.en` for constrained hardware, `medium`/`medium.en` where accuracy
matters more and the machine can sustain it, `large-v3` (or a quantized variant) only on capable
hardware. Multilingual models (no `.en` suffix) are required for anything other than English.

## Wire-up

Point `WHISPER_MODEL` in `config.env` at the downloaded file; `server.mjs` starts `whisper-server`
on demand from that path. Give it its own port, startup behavior, timeout, and health check,
separate from the voice server and TTS.
