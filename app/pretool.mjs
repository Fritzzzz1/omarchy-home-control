// PreToolUse hook for Bash, run as a local command hook (see server.mjs writePermissionSettings).
// Pure and self-contained, so it has no server dependency and can't fail open on a server hiccup:
// a plain, metacharacter-free command on the whitelist prints an "allow" decision; everything else
// prints "ask", which sends the command to the confirm card. Anything unexpected — bad JSON, an
// internal throw — also prints "ask" (still a card, still gated). If node itself can't run the
// script (missing file, broken interpreter), the wrapper `|| exit 2` in the hook command turns
// that into a PreToolUse block. So every failure mode ends at the card or a hard block, never an
// auto-approved shell command.
//
// Keep this whitelist in sync with the intent documented in server.mjs. A command is allowed only
// if it matches a pattern AND carries no shell metacharacter (chaining, redirects, subshells,
// globs), so a whitelisted `ls` can't be turned into `ls; cat secret` or `ls $(cat secret)`.
const BASH_METACHAR = /[;&|<>`$(){}\[\]*?~!\n\\]/;
const BASH_WHITELIST = [
  /^ls(?: +-[A-Za-z]+)*(?: +[\w./@:+=-]+)*$/,
  /^git status(?: +[\w./@:+=-]+)*$/,
  /^systemctl(?: --user)? (?:status|is-active|is-enabled|is-failed)(?: +[\w.@:_-]+)*$/,
  /^ps(?: +-{0,2}[\w,=+-]+)*$/,
  /^top -b ?-?n ?1(?: +.*)?$/,
  /^(?:df|free|uptime|date|whoami|hostname|id)(?: +-[A-Za-z]+)*$/,
  /^ip -br (?:addr|a|link|neigh)$/,
  /^tailscale status$/,
  /^pacman -Q(?:q|qe|i|e)?$/,
];
const bashAllowed = (cmd) => {
  cmd = String(cmd || '').trim();
  if (!cmd || BASH_METACHAR.test(cmd)) return false;
  return BASH_WHITELIST.some((re) => re.test(cmd));
};
const decide = (behavior) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: behavior } }));
  process.exit(0);
};
const ask = () => decide('ask');
process.on('uncaughtException', ask);
process.on('SIGTERM', ask);
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  try {
    const body = JSON.parse(raw || '{}');
    if (body.tool_name === 'Bash' && bashAllowed((body.tool_input || {}).command)) return decide('allow');
  } catch {}
  ask();
});
