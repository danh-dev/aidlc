/**
 * Environment hygiene for spawning a fresh `claude` process.
 *
 * The #1 cause of "Invalid API key" when AIDLC shells out to `claude` is an
 * `ANTHROPIC_API_KEY` inherited from the shell that the spawned CLI can't use:
 * an ephemeral key injected by a host Claude Code session, or a stale/scoped key
 * left in a `.zshrc`. `claude` prefers an env key over its own OAuth login, so a
 * bad inherited key shadows a perfectly good `claude login`.
 *
 * So, like aidlc-testagent, we strip the inherited Anthropic auth vars and let
 * `claude` fall back to its own login — but only when we have reason to believe
 * the login is the intended auth:
 *   - we're running inside a Claude Code session (the key is ephemeral), or
 *   - the user has a `claude login` to fall back to.
 * A user whose *only* auth is a deliberately-set `ANTHROPIC_API_KEY` (no login)
 * keeps it. And an explicitly-configured key passed via `overrides` (e.g. from
 * workspace.yaml `environment`) always wins — it is layered last.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Auth vars Claude Code / a shell may inject; stripped so OAuth login is used. */
const INHERITED_ANTHROPIC_AUTH = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
] as const;

/** Session markers Claude Code sets on child processes. */
const CLAUDE_CODE_SESSION_MARKERS = [
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_EXECPATH',
] as const;

function truthy(v: string | undefined): boolean {
  return !!v && v !== '0' && v.toLowerCase() !== 'false';
}

/**
 * True when the current process is running inside a Claude Code session, i.e.
 * any inherited Anthropic auth vars are ephemeral and should not be trusted.
 */
export function isInsideClaudeCodeSession(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    truthy(env.CLAUDECODE) ||
    !!env.CLAUDE_CODE_ENTRYPOINT ||
    !!env.CLAUDE_CODE_SESSION_ID
  );
}

/**
 * Cheap, offline check for a `claude login`: Claude Code records an
 * `oauthAccount` object in ~/.claude.json once the user is signed in. Reading a
 * flag from JSON beats spawning claude just to probe auth.
 */
export function hasClaudeLogin(home: string = os.homedir()): boolean {
  try {
    const raw = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
    const j = JSON.parse(raw) as { oauthAccount?: unknown };
    return !!j.oauthAccount && typeof j.oauthAccount === 'object';
  } catch {
    return false;
  }
}

/**
 * Build the environment for spawning a fresh `claude`. `overrides` (e.g. a
 * runner's resolved `ctx.env`) are layered last, so an explicitly-configured
 * key always wins over the inherited-but-stripped one.
 */
export function buildClaudeSpawnEnv(
  overrides: Record<string, string> = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  // Strip the inherited key when login is the intended auth — either we're in a
  // Claude Code session (ephemeral key) or a `claude login` exists to fall back
  // on. Otherwise leave a deliberately-set, login-less API key in place.
  const preferLogin = isInsideClaudeCodeSession(base) || hasClaudeLogin();
  if (preferLogin) {
    for (const k of [...INHERITED_ANTHROPIC_AUTH, ...CLAUDE_CODE_SESSION_MARKERS]) {
      delete env[k];
    }
  } else {
    // Even outside those cases, the Claude Code session markers are never useful
    // to a fresh spawn — drop them while keeping the (login-less) API key.
    for (const k of CLAUDE_CODE_SESSION_MARKERS) { delete env[k]; }
  }
  return { ...env, ...overrides };
}
