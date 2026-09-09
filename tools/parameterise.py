#!/usr/bin/env python3
"""Apply the packaging patch to app/ — the only differences between the vendored
payload and the upstream voice-chat app.

Every edit here exists for one reason: upstream hardcodes a value that belongs to
one particular machine and offers no way to override it. Each replacement keeps
the original value as the fallback, so behaviour on the original machine is
unchanged; it just becomes overridable.

Run from the plugin root:  python3 tools/parameterise.py [--check]
It is idempotent: it looks for the post-state before the pre-state, so edits
that wrap or extend what they match are not applied twice.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
APP = ROOT / "app"
CHECK = "--check" in sys.argv

# (file, old, new, why)
EDITS = [
    # ---- server.mjs ---------------------------------------------------------
    (
        "server.mjs",
        "import { fileURLToPath } from 'node:url';",
        "import { fileURLToPath } from 'node:url';\nimport { readBody } from './request-body.mjs';",
        "bounded request handling lives in a small dedicated module",
    ),
    (
        "server.mjs",
        "const ROOT = process.env.VOICE_ROOT || path.resolve(HERE, '..', '..', '..');",
        "const ROOT = process.env.VOICE_ROOT || os.homedir();",
        "the three-levels-up default resolved to /home, which is a poor cwd to hand an agent",
    ),
    (
        "server.mjs",
        "const LABEL = process.env.VOICE_LABEL || 'home';",
        "const LABEL = process.env.VOICE_LABEL || 'voice';",
        "'home' is this machine's hostname, not a sensible default elsewhere",
    ),
    (
        "server.mjs",
        "const STATE = process.env.VOICE_STATE || path.join(os.homedir(), '.local', 'share', 'context-agent', LABEL);",
        "const STATE = process.env.VOICE_STATE || path.join(os.homedir(), '.local', 'share', 'home-control', 'state', LABEL);",
        "'context-agent' is the original author's directory name",
    ),
    (
        "server.mjs",
        "const EDGE_TTS = path.join(os.homedir(), '.local', 'share', 'context-agent', 'venv', 'bin', 'edge-tts');",
        "const EDGE_TTS = process.env.VOICE_EDGE_TTS || path.join(os.homedir(), '.local', 'share', 'home-control', 'venv', 'bin', 'edge-tts');",
        "absolute venv path with no override; this is the CLI fallback when the TTS worker is down",
    ),
    (
        "server.mjs",
        "const HOST = '127.0.0.1';",
        "const HOST = process.env.VOICE_HOST || '127.0.0.1';",
        "bind address; still localhost by default, which is the safe choice",
    ),
    (
        "server.mjs",
        "const VOICES = { en: 'en-US-AndrewMultilingualNeural', he: 'he-IL-AvriNeural' };",
        "const VOICES = { en: process.env.VOICE_VOICE_EN || 'en-US-AndrewMultilingualNeural', he: process.env.VOICE_VOICE_HE || 'he-IL-AvriNeural' };",
        "the two edge-tts voices were fixed",
    ),
    (
        "server.mjs",
        "const REWRITE_MODEL = 'claude-haiku-4-5-20251001';",
        "const REWRITE_MODEL = process.env.VOICE_REWRITE_MODEL || 'claude-haiku-4-5-20251001';",
        "a pinned dated model id that will need bumping",
    ),
    (
        "server.mjs",
        "const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(os.homedir(), 'dev', 'nanoclaw-v2', 'data', 'models', 'ggml-large-v3-turbo.bin');",
        "const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(os.homedir(), '.local', 'share', 'home-control', 'models', 'ggml-large-v3-turbo.bin');",
        "the default pointed inside an unrelated project of the original author's",
    ),
    (
        "server.mjs",
        "const MODEL = process.env.VOICE_MODEL || '';",
        "const OWNER = process.env.VOICE_OWNER || 'the user';\nconst MODEL = process.env.VOICE_MODEL || '';",
        "introduce a name for whoever is talking, instead of hardcoding one",
    ),
    (
        "server.mjs",
        'The text is an agent speaking to Liran: keep "I" for the agent and "you" for Liran exactly as written',
        'The text is an agent speaking to ${OWNER}: keep "I" for the agent and "you" for ${OWNER} exactly as written',
        "the owner's first name was baked into the speech-rewrite system prompt",
    ),
    (
        "server.mjs",
        "  'Bash(sqlite3:*)', 'Bash(python3:*)', 'Bash(node:*)', 'Bash(ffmpeg:*)', 'Bash(ffprobe:*)', 'Bash(curl:*)', 'Bash(mkdir:*)', 'Bash(cp:*)', 'Bash(mv:*)',\n];",
        "  'Bash(sqlite3:*)', 'Bash(python3:*)', 'Bash(node:*)', 'Bash(ffmpeg:*)', 'Bash(ffprobe:*)', 'Bash(curl:*)', 'Bash(mkdir:*)', 'Bash(cp:*)', 'Bash(mv:*)',\n"
        "];\n"
        "// Handing work to another live Claude Code session on this machine. Opt-in, and\n"
        "// off unless install.sh was explicitly told otherwise, because it widens who can\n"
        "// act on a spoken request. The rule that goes with it is in voice-mode.md:\n"
        "// lacking a tool is a reason to delegate; having been refused is not.\n"
        "if ((process.env.VOICE_PEER_DELEGATION || '').toLowerCase() === 'on') {\n"
        "  ALLOWED_TOOLS.push('ListAgents', 'SendMessage');\n"
        "}",
        "the tool allowlist is closed, so the delegation flag needs a way to widen it",
    ),
    (
        "server.mjs",
        "const readBody = (req, limit = 1e6) => new Promise((resolve) => {\n"
        "  const chunks = [];\n"
        "  let size = 0;\n"
        "  req.on('data', (c) => { chunks.push(c); size += c.length; if (size > limit) req.destroy(); });\n"
        "  req.on('end', () => resolve(Buffer.concat(chunks)));\n"
        "});",
        "// request-body.mjs owns bounded request reads.",
        "an interrupted or oversized upload must settle instead of holding the voice turn busy",
    ),
    (
        "server.mjs",
        "    if (url.pathname === '/api/mic-chunk' && req.method === 'POST') "
        "return micChunk(req, res);",
        "    // Awaited, not just returned: micChunk reads a bounded body that can reject when a\n"
        "    // phone vanishes mid-chunk, and a returned promise settles outside this try — an\n"
        "    // unhandled rejection that would take the whole voice server down with it.\n"
        "    if (url.pathname === '/api/mic-chunk' && req.method === 'POST') "
        "return await micChunk(req, res);",
        "now that a bounded read can reject, the only handler dispatched outside the "
        "request try/catch has to be awaited inside it",
    ),
    # ---- monitor.mjs --------------------------------------------------------
    (
        "monitor.mjs",
        "const state = process.env.VOICE_STATE || path.join(os.homedir(), '.local/share/context-agent/home');",
        "const label = process.env.VOICE_LABEL || 'voice';\n"
        "const state = process.env.VOICE_STATE || path.join(os.homedir(), '.local/share/home-control/state', label);",
        "the monitor ignored VOICE_LABEL, so it read the wrong state dir for any other instance",
    ),
    (
        "monitor.mjs",
        "const port = Number(process.env.MONITOR_PORT || 4456);",
        "const port = Number(process.env.MONITOR_PORT || 4456);\n"
        "// The voice server the dashboard reads from. Upstream hardcoded :4455 here,\n"
        "// so a server on any other port was invisible to the monitor.\n"
        "const voiceOrigin = `http://${process.env.VOICE_HOST || '127.0.0.1'}:${Number(process.env.VOICE_PORT || 4455)}`;",
        "give the monitor a configurable origin",
    ),
    (
        "monitor.mjs",
        "const root = process.env.VOICE_ROOT || path.resolve(here, '..');",
        "const root = process.env.VOICE_ROOT || os.homedir();",
        "monitor and server disagreed on the VOICE_ROOT default, so the ~/.claude/projects slug did not match",
    ),
    (
        "monitor.mjs",
        "await fetch('http://127.0.0.1:4455/login', {",
        "await fetch(`${voiceOrigin}/login`, {",
        "hardcoded port",
    ),
    (
        "monitor.mjs",
        "await fetch('http://127.0.0.1:4455/api/state', {",
        "await fetch(`${voiceOrigin}/api/state`, {",
        "hardcoded port",
    ),
    # ---- tts.py -------------------------------------------------------------
    (
        "tts.py",
        "#!/usr/bin/env -S /home/fritzzzz/.local/share/context-agent/venv/bin/python",
        "#!/usr/bin/env python3",
        "the shipped shebang named one machine's venv; install.sh rewrites this line to the venv it built",
    ),
    (
        "tts.py",
        'PORT = int(os.environ.get("TTS_PORT", "4457"))',
        'PORT = int(os.environ.get("TTS_PORT", "4457"))\nHOST = os.environ.get("TTS_HOST", "127.0.0.1")',
        "bind address was a literal in two places",
    ),
    (
        "tts.py",
        '    print(f"tts worker on 127.0.0.1:{PORT}", file=sys.stderr, flush=True)\n'
        '    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()',
        '    print(f"tts worker on {HOST}:{PORT}", file=sys.stderr, flush=True)\n'
        '    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()',
        "use the configurable bind address",
    ),
    (
        "tts.py",
        '"en-US-AndrewMultilingualNeural"',
        'os.environ.get("TTS_VOICE", "en-US-AndrewMultilingualNeural")',
        "default voice was fixed",
    ),
]

applied = skipped = missing = 0
for name, old, new, why in EDITS:
    p = APP / name
    text = p.read_text()
    # Check the post-state FIRST. Several edits wrap or extend the text they
    # match, so `old` is still present after a successful apply; testing `old`
    # first would re-apply those every run and duplicate declarations.
    if new in text:
        skipped += 1
        print(f"  already  {name}: {why}")
    elif old in text:
        if not CHECK:
            p.write_text(text.replace(old, new, 1))
        applied += 1
        print(f"  patched  {name}: {why}")
    else:
        missing += 1
        print(f"  MISSING  {name}: could not find target for: {why}", file=sys.stderr)
        print(f"           looked for: {old[:90]!r}", file=sys.stderr)

print(f"\n{applied} applied, {skipped} already applied, {missing} missing")
sys.exit(1 if missing else 0)
