#!/usr/bin/env python3
"""Text-to-speech worker for the voice server: edge-tts kept warm in one process.
POST /speak  {"text": "...", "voice": "he-IL-AvriNeural"}  ->  audio/mpeg
Started by server.mjs; listens on 127.0.0.1 only."""
import asyncio
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import edge_tts

PORT = int(os.environ.get("TTS_PORT", "4457"))
HOST = os.environ.get("TTS_HOST", "127.0.0.1")


async def render(text, voice):
    chunks = []
    async for chunk in edge_tts.Communicate(text, voice).stream():
        if chunk["type"] == "audio":
            chunks.append(chunk["data"])
    return b"".join(chunks)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        if self.path != "/speak":
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0")) or 0) or b"{}")
        text, voice = body.get("text", "").strip(), body.get("voice", os.environ.get("TTS_VOICE", "en-US-AndrewMultilingualNeural"))
        if not text:
            self.send_error(400)
            return
        try:
            audio = asyncio.run(render(text, voice))
        except Exception as e:  # noqa: BLE001 — any failure is reported to the caller, which falls back
            self.send_response(502)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(str(e).encode())
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")


if __name__ == "__main__":
    print(f"tts worker on {HOST}:{PORT}", file=sys.stderr, flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
