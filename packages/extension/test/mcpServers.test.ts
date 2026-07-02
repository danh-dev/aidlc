import { describe, expect, it } from 'vitest';

import { describeSpawnError } from '../src/v2/mcpServers';

/**
 * Regression coverage for issue #61: the MCP Servers panel always showed
 * "Command failed: claude mcp list" even though the CLI was installed and the
 * command worked when run manually.
 *
 * Root cause: `claude mcp list` health-checks every configured server and can
 * take longer than the 20s budget. When Node kills the child on timeout it sets
 * `err.killed = true` / `err.signal = 'SIGTERM'` — NOT `err.code = 'ETIMEDOUT'`.
 * The old code only checked for `ETIMEDOUT`, so a real timeout fell through to
 * the generic `err.message`. `describeSpawnError` now classifies a SIGTERM-kill
 * as a timeout.
 */
describe('describeSpawnError', () => {
  const bin = 'claude';
  const timeoutMs = 90_000;

  it('reports a SIGTERM-kill timeout as a timeout, not a generic failure', () => {
    // Shape of the error Node passes when it kills a child that exceeds `timeout`.
    const err = Object.assign(new Error('Command failed: claude mcp list'), {
      killed: true,
      signal: 'SIGTERM' as NodeJS.Signals,
      code: undefined,
    });

    const result = describeSpawnError(err, '', '', bin, timeoutMs);

    expect(result.error).toContain('timed out after 90s');
    expect(result.error).not.toBe('Command failed: claude mcp list');
  });

  it('still recognizes an explicit ETIMEDOUT code as a timeout', () => {
    const err = Object.assign(new Error('boom'), { code: 'ETIMEDOUT' });
    const result = describeSpawnError(err, '', '', bin, timeoutMs);
    expect(result.error).toContain('timed out after 90s');
  });

  it('returns servers parsed from partial stdout captured before a timeout', () => {
    const partial =
      'Checking MCP server health...\n\n' +
      'claude.ai Audible: https://mcp.audible.com/mcp - ✓ Connected';
    const err = Object.assign(new Error('Command failed'), {
      killed: true,
      signal: 'SIGTERM' as NodeJS.Signals,
    });

    const result = describeSpawnError(err, partial, '', bin, timeoutMs);

    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]).toMatchObject({ name: 'claude.ai Audible', status: 'connected' });
    expect(result.error).toContain('timed out');
  });

  it('reports ENOENT as a not-on-PATH error', () => {
    const err = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const result = describeSpawnError(err, '', '', bin, timeoutMs);
    expect(result.servers).toEqual([]);
    expect(result.error).toBe('`claude` not found on PATH');
  });

  it('prefers stderr for a genuine non-timeout failure', () => {
    const err = Object.assign(new Error('Command failed: claude mcp list'), { code: 1 });
    const result = describeSpawnError(err, '', 'some real error text', bin, timeoutMs);
    expect(result.error).toBe('some real error text');
  });

  it('falls back to err.message when a non-timeout failure has no stderr', () => {
    const err = Object.assign(new Error('Command failed: claude mcp list'), { code: 1 });
    const result = describeSpawnError(err, '', '', bin, timeoutMs);
    expect(result.error).toBe('Command failed: claude mcp list');
  });

  it('renders the timeout seconds from the supplied budget', () => {
    const err = Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' as NodeJS.Signals });
    const result = describeSpawnError(err, '', '', bin, 30_000);
    expect(result.error).toContain('timed out after 30s');
  });
});
