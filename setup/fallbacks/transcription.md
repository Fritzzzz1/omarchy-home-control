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

Default language is English. Pick an English model (`small.en`, `medium.en`, or
`large-v3-turbo` / a quantized variant on capable hardware) unless the user asked for another
language in setup §3. Do not install a Hebrew model, pin `-l he`, or point at a Hebrew endpoint
just because one exists on this machine.

**If they asked for Hebrew:** do not use stock multilingual whisper.cpp as the Hebrew ear. Use
the ivrit.ai Hebrew fine-tune (`ivrit-ai/whisper-large-v3-turbo-ct2`, faster-whisper / CT2). It
speaks the same `/inference` API as whisper.cpp — set `WHISPER_URL` at that server (locally
this is often `http://127.0.0.1:4459` when `ivrit-whisper.service` / `~/dev/transcription` is
already running). Pin `VOICE_LANG=he`. English speech into that endpoint comes back as Hebrew
gibberish; it is the Hebrew path only.

For any other non-English language, a multilingual GGML model (no `.en` suffix) is required;
pass the language through as `VOICE_LANG` so `whisper-server` is started with `-l <lang>`, not
`auto`.

## Wire-up

Point `WHISPER_MODEL` in `config.env` at the downloaded file; `server.mjs` starts `whisper-server`
on demand from that path. Give it its own port, startup behavior, timeout, and health check,
separate from the voice server and TTS.
