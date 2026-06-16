import { Command } from 'commander';
import { AIDLC_CLI_GUIDE_TEXT } from '@aidlc/core';

/**
 * `aidlc guide` — print a static, no-LLM getting-started reference card.
 * Mirrors the testagent `guide` command: zero cost, always available, even
 * before a workspace or claude is configured.
 */
export function registerGuide(program: Command): void {
  program
    .command('guide')
    .description('step-by-step getting-started reference (no LLM, no cost)')
    .action(() => {
      console.log(AIDLC_CLI_GUIDE_TEXT);
    });
}
