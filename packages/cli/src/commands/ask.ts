import { execSync } from 'child_process';
import { Command } from 'commander';
import chalk from 'chalk';
import { DefaultRunner, AIDLC_KNOWLEDGE } from '@aidlc/core';
import { resolveWorkspaceRoot } from '../workspaceRoot';

/**
 * `aidlc ask <prompt...>` — ask Claude a question about AIDLC: what it is, how
 * to set it up, and which command does what. Grounded in AIDLC_KNOWLEDGE so the
 * model answers from the real command surface instead of guessing.
 *
 * Works before a workspace exists (it only needs `claude` on PATH), so a fresh
 * user can ask "how do I get started?" as their very first command. Streams the
 * answer live via the same DefaultRunner the pipeline engine uses.
 */
const ASK_SYSTEM_PROMPT = `You are the AIDLC assistant, embedded in the \`aidlc\` CLI.
Answer the user's question about AIDLC concisely and practically — prefer the
exact command, flag, or button name over abstract description. When the user is
getting started, give them the concrete next command to run. Use the reference
below as ground truth and never invent commands or settings not listed in it.

${AIDLC_KNOWLEDGE}`;

export function registerAsk(program: Command): void {
  program
    .command('ask <prompt...>')
    .description('ask Claude about AIDLC — setup, concepts, and CLI commands')
    .action(async (promptParts: string[], _opts: unknown, cmd: Command) => {
      const userPrompt = promptParts.join(' ').trim();
      if (!userPrompt) {
        console.error(chalk.red('✘ Provide a question, e.g. aidlc ask "how do I start a run?"'));
        process.exit(1);
      }

      // Preflight — `ask` is useless without claude on PATH, and the failure
      // mode (a silent spawn error) is confusing. Check up front.
      try {
        execSync('which claude', { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        console.error(chalk.red('✘ claude CLI not found on PATH.'));
        console.error(chalk.dim('  install: https://github.com/anthropics/claude-code  ·  then: aidlc doctor'));
        process.exit(1);
      }

      const root = resolveWorkspaceRoot(cmd);
      const runner = new DefaultRunner();

      process.stderr.write('\n');
      const result = await runner.run({
        skill: ASK_SYSTEM_PROMPT,
        env: {},
        args: [userPrompt],
        workspaceRoot: root,
        onOutput: (chunk) => process.stdout.write(chunk),
        onError: (chunk) => process.stderr.write(chunk),
        claude: null,
      });
      process.stdout.write('\n');

      if (!result.success) {
        console.error(chalk.red('\n✘ claude exited with an error — try `aidlc doctor`.'));
        process.exit(1);
      }
    });
}
