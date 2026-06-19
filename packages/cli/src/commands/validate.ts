import { Command } from 'commander';
import chalk from 'chalk';
import {
  WorkspaceLoader,
  WorkspaceNotFoundError,
  WorkspaceParseError,
  WorkspaceValidationError,
  collectWorkspaceRefIssues,
} from '@aidlc/core';
import { resolveWorkspaceRoot } from '../workspaceRoot';

export function registerValidate(program: Command): void {
  program
    .command('validate')
    .description('Validate .aidlc/workspace.yaml against the schema (and cross-reference check)')
    .option('--strict', 'Treat dangling cross-references (unknown agent/skill/recipe) as failures')
    .action(async (opts: { strict?: boolean }, cmd: Command) => {
      const root = resolveWorkspaceRoot(cmd);
      try {
        const ws = await WorkspaceLoader.load(root);
        const c = ws.config;
        console.log(`workspace.yaml OK (${ws.configPath})`);
        console.log(`  agents:    ${c.agents.length}`);
        console.log(`  skills:    ${c.skills.length}`);
        console.log(`  pipelines: ${c.pipelines.length}`);

        // Schema validity ≠ referential integrity. The Zod schema accepts a
        // pipeline step that names an agent which doesn't exist yet (so
        // hand-authored configs don't hard-fail mid-edit). Surface those as
        // warnings here, and let --strict callers (CI) fail on them.
        const refIssues = collectWorkspaceRefIssues(c);
        if (refIssues.length > 0) {
          const label = opts.strict ? chalk.red : chalk.yellow;
          console.error(
            label(`\n${refIssues.length} cross-reference issue${refIssues.length !== 1 ? 's' : ''}:`),
          );
          for (const issue of refIssues) {
            console.error(label(`  - ${issue.path}: ${issue.message}`));
          }
          if (opts.strict) {
            process.exit(1);
          }
          console.error(chalk.dim('  (warnings only — re-run with --strict to fail on these)'));
        }
      } catch (err) {
        if (err instanceof WorkspaceNotFoundError) {
          console.error(err.message);
        } else if (err instanceof WorkspaceParseError) {
          console.error(`workspace.yaml parse error: ${err.message}`);
        } else if (err instanceof WorkspaceValidationError) {
          console.error('workspace.yaml validation failed:');
          for (const issue of err.issues) {
            console.error(`  - ${issue.path.join('.') || '<root>'}: ${issue.message}`);
          }
        } else {
          throw err;
        }
        process.exit(1);
      }
    });
}
