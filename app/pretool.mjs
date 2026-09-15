// PreToolUse hook for EVERY tool (matcher "*"), run as a local command hook (see server.mjs
// writePermissionSettings). Pure and self-contained, so it has no server dependency and can't fail
// open on a server hiccup. It decides:
//   - a safe, read-only tool (Read/Grep/Glob/WebFetch/WebSearch/Skill/Todo*, ListAgents/SendMessage,
//     and the read-only MCP tools listed in the allow file) -> defer (no output): the normal flow
//     runs it, and the per-file deny rules still apply;
//   - Bash -> the exact whitelist below, or the broadened read-file commands further down (cat,
//     head, tail, wc, file, stat, strings, non-recursive grep) whose file arguments are checked
//     against the same secret paths server.mjs already denies to Read/Edit/Write -> "allow";
//     everything else -> "ask" (the confirm card). "Read is blanket-allowed, anything that can
//     write or change something still asks" (user, 2026-09-15).
//   - anything else -> "ask": Edit, Write, NotebookEdit, MCP writes/trades, and — the reason the
//     matcher is "*" — any tool a skill's allowed-tools grant just handed us. A grant can't skip
//     the card because this hook runs first and its "ask" overrides it.
// Failure is closed: bad JSON or an internal throw -> "ask" (still the card); if node can't run
// this file at all, the wrapper `|| exit 2` in the hook command turns that into a PreToolUse block.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Hardcoded so the agent's basic tools keep working even if the allow file is unreadable. The allow file
// (argv[2], written by the server) adds the read-only MCP tools and, when delegation is on, the
// peer tools. `SendMessage`/`ListAgents` are safe to list here unconditionally: with delegation
// off the server puts them in --disallowedTools, so deferring them still ends in a hard deny.
const CORE_SAFE = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Skill', 'TodoWrite', 'TodoRead', 'ListAgents', 'SendMessage'];
let extra = [];
try { extra = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); } catch {}
const safe = [...CORE_SAFE, ...(Array.isArray(extra) ? extra : [])];
// exact match, or an MCP whole-server prefix like `mcp__some_server` matching one of its tools
const isSafeTool = (tool) => safe.some((e) => e === tool || tool.startsWith(e + '__'));

// A whitelisted command must match a pattern AND carry no shell metacharacter (chaining, redirects,
// subshells, globs), so a whitelisted `ls` can't become `ls; cat secret` or `ls $(cat secret)`.
// Patterns are argument-tight: no flag may read a file (ps env, date -f/-r, systemctl -H/-M, …).
const BASH_METACHAR = /[;&|<>`$(){}\[\]*?~!\n\\]/;
const BASH_WHITELIST = [
  /^ls(?: +-[A-Za-z]+)*(?: +[\w./@:+=-]+)*$/,
  /^git status(?: +[\w./@:+=-]+)*$/,
  // read-only history inspection: no bare `git diff`/`git show` (would print full patch content,
  // which could leak a secret that was once committed and later removed from the working tree).
  /^git fetch(?: +[\w./-]+)?(?: +main)?$/,
  /^git log(?: +--oneline)?(?: +--all)?(?: +[\w./-]+\.\.[\w./-]+)?(?: +-- +[\w./ -]+)?$/,
  /^git diff --stat(?: +[\w./-]+(?: +[\w./-]+)?)?(?: +-- +[\w./ -]+)?$/,
  /^git show +[\w./-]+ +--stat$/,
  /^git show +[\w./-]+ +-s +--format=%B$/,
  /^git remote -v$/,
  /^git branch -vv$/,
  /^git ls-files(?: +[\w./-]+)?$/,
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
// Broadened read-only file commands (user, 2026-09-15): "read is blanket-allowed, anything that
// can write or leak something still asks". Unlike BASH_WHITELIST above, these take arbitrary file
// arguments, so every non-flag argument is resolved against $HOME (the app's cwd) and checked
// against the same secret paths server.mjs denies to Read/Edit/Write — duplicated here because a
// Bash reader bypasses that deny list entirely; only this hook stands between a whitelisted read
// command and those files. Symlinks are resolved first so a link planted inside $HOME can't point
// at a secret (or outside $HOME) to dodge the pattern check.
const HOME = os.homedir();
const SECRET_REL_PATTERNS = [
  /^\.ssh(\/|$)/, /^\.local\/share\/keyrings(\/|$)/, /^\.aws(\/|$)/, /^\.gnupg(\/|$)/,
  /^\.claude\/\.credentials/, /^\.config\/gh\/hosts\.yml$/, /^\.config\/home-control\/config\.env$/,
  /^\.netrc$/, /^\.git-credentials$/, /^\.npmrc$/, /^\.pypirc$/, /^\.docker\/config\.json$/,
  // the app's own state secrets (server.mjs APP_SECRETS): logins.json, voice-token,
  // claude-settings.json, claude-session.json, under any VOICE_LABEL state dir
  /^\.local\/share\/home-control\/state\/[^/]+\/(logins\.json|voice-token|claude-settings\.json|claude-session\.json)$/,
  // mirrors writePermissionSettings's repo-relative globs
  /(^|\/)secrets(\/|$)/, /(^|\/)credentials[^/]*$/, /(^|\/)\.env[^/]*$/,
];
const isSecretPath = (arg) => {
  const resolved = path.resolve(HOME, arg);
  let real = resolved;
  try { real = fs.realpathSync(resolved); } catch {}   // doesn't exist yet / broken link: keep the resolved path
  return [resolved, real].some((p) => {
    const rel = path.relative(HOME, p);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return true;   // outside $HOME: not our scope, don't allow blind
    return SECRET_REL_PATTERNS.some((re) => re.test(rel));
  });
};
// command -> flag characters that must NOT appear in any flag token (blocks recursion/traversal/
// follow-mode); empty string means no flag is restricted (the path check below is what protects
// these). grep's family blocks r/R (recursive) and d/D (directory/device handling, which can act
// like recursion).
const READ_CMDS = {
  cat: '', head: '', tail: 'f', wc: '', file: '', stat: '', strings: '',
  grep: 'rRdD', egrep: 'rRdD', fgrep: 'rRdD',
};
const readCommandAllowed = (cmd) => {
  const tokens = cmd.split(' ');
  const spec = READ_CMDS[tokens[0]];
  if (spec === undefined) return false;
  const pathArgs = [];
  for (const tok of tokens.slice(1)) {
    if (tok.startsWith('-')) {
      if (spec && [...tok].some((ch) => spec.includes(ch))) return false;
      continue;
    }
    if (!/^[\w./@:+=-]+$/.test(tok)) return false;
    pathArgs.push(tok);
  }
  if (pathArgs.length === 0) return false;   // no file named: reads stdin, nothing to check — don't allow
  return pathArgs.every((p) => !isSecretPath(p));
};
const bashAllowed = (cmd) => {
  cmd = String(cmd || '').trim();
  if (!cmd || BASH_METACHAR.test(cmd)) return false;
  return BASH_WHITELIST.some((re) => re.test(cmd)) || readCommandAllowed(cmd);
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
