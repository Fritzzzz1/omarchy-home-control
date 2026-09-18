import { spawn } from 'node:child_process';

// Optional hook: for each phone turn, as soon as its input is known, VOICE_ON_INPUT (if set)
// runs as a shell command and gets one JSON object on stdin: { at, text, audio_base64 }. The payload is deliberately
// restricted to the user's input, never a turn's reply. Unset/empty resolves immediately and
// runs nothing, so a config without this feature pays no cost.
export function runInputHook({ at, text, audio }, timeoutMs = 30000) {
  const cmd = (process.env.VOICE_ON_INPUT || '').trim();
  if (!cmd) return Promise.resolve();
  return new Promise((resolve, reject) => {
    // `timeout`/child_process's own `timeout` option only SIGTERMs the shell (`/bin/sh -c`), not
    // whatever it spawned — a backgrounded grandchild holding stderr open keeps the pipe (and
    // 'close') waiting well past the deadline. detached so the command gets its own process
    // group, killed as a group on our own timer; settle on 'exit', which fires once the shell
    // itself is done, not on 'close', which waits for every fd to be released.
    const child = spawn('/bin/sh', ['-c', cmd], { stdio: ['pipe', 'ignore', 'pipe'], detached: true });
    let error = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      settle(() => reject(new Error(`input hook timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    const settle = (fn) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    child.stderr.on('data', (chunk) => { error = (error + chunk).slice(-2000); });
    // A hook that doesn't read all of stdin (e.g. `true`) still exits 0; without this, the
    // resulting EPIPE on write/end would reject a run that actually succeeded. The exit code
    // alone decides success or failure.
    child.stdin.on('error', () => {});
    child.on('error', (e) => settle(() => reject(e)));
    child.on('exit', (code) => settle(() => (code === 0 ? resolve() : reject(new Error(`input hook failed (${code}): ${error}`)))));
    const payload = { at, text };
    if (audio) payload.audio_base64 = audio.toString('base64');
    child.stdin.end(JSON.stringify(payload));
  });
}
