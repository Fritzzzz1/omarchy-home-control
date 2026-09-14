// PreToolUse hook for EVERY tool (matcher "*"), run as a local command hook (see server.mjs
// writePermissionSettings). Pure and self-contained, so it has no server dependency and can't fail
// open on a server hiccup. It decides:
//   - a safe, read-only tool (Read/Grep/Glob/WebFetch/WebSearch/Skill/Todo*, ListAgents/SendMessage,
//     and the read-only MCP tools listed in the allow file) -> defer (no output): the normal flow
//     runs it, and the per-file deny rules still apply;
//   - Bash -> the whitelist below: a plain, metacharacter-free command on the list -> "allow",
//     everything else -> "ask" (the confirm card);
//   - anything else -> "ask": Edit, Write, NotebookEdit, MCP writes/trades, and — the reason the
//     matcher is "*" — any tool a skill's allowed-tools grant just handed us. A grant can't skip
//     the card because this hook runs first and its "ask" overrides it.
// Failure is closed: bad JSON or an internal throw -> "ask" (still the card); if node can't run
// this file at all, the wrapper `|| exit 2` in the hook command turns that into a PreToolUse block.
import fs from 'node:fs';

// Hardcoded so the agent's basic tools keep working even if the allow file is unreadable. The allow file
// (argv[2], written by the server) adds the read-only MCP tools and, when delegation is on, the
// peer tools. `SendMessage`/`ListAgents` are safe to list here unconditionally: with delegation
// off the server puts them in --disallowedTools, so deferring them still ends in a hard deny.
const CORE_SAFE = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Skill', 'TodoWrite', 'TodoRead', 'ListAgents', 'SendMessage'];
let extra = [];
try { extra = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); } catch {}
const safe = [...CORE_SAFE, ...(Array.isArray(extra) ? extra : [])];
// exact match, or an MCP whole-server prefix like `mcp__claude_ai_Strava` matching one of its tools
const isSafeTool = (tool) => safe.some((e) => e === tool || tool.startsWith(e + '__'));

// A whitelisted command must match a pattern AND carry no shell metacharacter (chaining, redirects,
// subshells, globs), so a whitelisted `ls` can't become `ls; cat secret` or `ls $(cat secret)`.
// Patterns are argument-tight: no flag may read a file (ps env, date -f/-r, systemctl -H/-M, …).
const BASH_METACHAR = /[;&|<>`$(){}\[\]*?~!\n\\]/;
const BASH_WHITELIST = [
  /^ls(?: +-[A-Za-z]+)*(?: +[\w./@:+=-]+)*$/,
  /^git status(?: +[\w./@:+=-]+)*$/,
  // unit args must not start with "-", which rejects -H/--host/-M/--machine/--output=…
  /^systemctl(?: --user)? (?:status|is-active|is-enabled|is-failed)(?: +[\w.@:][\w.@:+-]*)*$/,
  /^ps(?: aux| -ef)?$/,
  /^top -b -n 1$/, /^top -bn1$/,
  /^(?:df|free|uptime|whoami|hostname|id)(?: +-[A-Za-z]+)*$/,
  /^date$/, /^date \+[%\w:/.,+-]+$/,   // no -f/--file/-r/--reference/-d
  /^ip -br (?:addr|a|link|neigh)$/,
  /^tailscale status$/,
  /^pacman -Q(?:q|qe|i|e)?$/,   // exact query forms only: no -Qo/-Qp <file>, no package arg
];
const bashAllowed = (cmd) => {
  cmd = String(cmd || '').trim();
  if (!cmd || BASH_METACHAR.test(cmd)) return false;
  return BASH_WHITELIST.some((re) => re.test(cmd));
};

const decide = (behavior) => { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: behavior } })); process.exit(0); };
const ask = () => decide('ask');
const defer = () => process.exit(0);   // no output: the normal permission flow runs
process.on('uncaughtException', ask);
process.on('SIGTERM', ask);
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  try {
    const body = JSON.parse(raw || '{}');
    const tool = String(body.tool_name || '');
    if (tool === 'Bash') return bashAllowed((body.tool_input || {}).command) ? decide('allow') : ask();
    if (isSafeTool(tool)) return defer();
  } catch {}
  ask();
});
