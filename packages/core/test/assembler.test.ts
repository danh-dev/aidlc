import { describe, it, expect } from 'vitest';

import {
  assemblePipeline,
  PipelineAssembleError,
  collectWorkspaceRefIssues,
  validateWorkspace,
  type WorkspaceConfig,
} from '../src';

/**
 * A workspace shaped like the built-in SDLC preset: a parallel "full"
 * pipeline plus recipes that carve task-type subsets out of it.
 */
function workspace(): WorkspaceConfig {
  return validateWorkspace(
    {
      version: '1.0',
      name: 'test',
      agents: [
        { id: 'po', name: 'PO', skills: ['prd'] },
        { id: 'tech-lead', name: 'Tech Lead', skills: ['tech-design'] },
        { id: 'developer', name: 'Dev', skills: ['implement'] },
        { id: 'qa', name: 'QA', skills: ['test-plan', 'test-report'] },
      ],
      skills: [
        { id: 'prd', builtin: true },
        { id: 'tech-design', builtin: true },
        { id: 'implement', builtin: true },
        { id: 'test-plan', builtin: true },
        { id: 'test-report', builtin: true },
      ],
      pipelines: [
        {
          id: 'sdlc-full',
          on_failure: 'stop',
          steps: [
            { name: 'plan', agent: 'po', skills: ['prd'], produces: ['{epicDir}/PRD.md'], human_review: true },
            { name: 'design', agent: 'tech-lead', skills: ['tech-design'], depends_on: ['plan'], human_review: true },
            { name: 'test-plan', agent: 'qa', skills: ['test-plan'], depends_on: ['plan'] },
            { name: 'implement', agent: 'developer', skills: ['implement'], depends_on: ['design'] },
            { name: 'test-report', agent: 'qa', skills: ['test-report'], depends_on: ['implement', 'test-plan'] },
          ],
        },
      ],
      recipes: [
        { id: 'bugfix', steps: ['implement', 'test-report'] },
        { id: 'large-feature', steps: ['plan', 'design', 'test-plan', 'implement', 'test-report'] },
      ],
    },
    'test.yaml',
  );
}

describe('assemblePipeline', () => {
  it('selects the recipe steps in order', () => {
    const p = assemblePipeline(workspace(), { recipeId: 'large-feature', pipelineId: 'epic-1' });
    expect(p.id).toBe('epic-1');
    expect(p.steps.map((s) => (s as { name: string }).name)).toEqual([
      'plan', 'design', 'test-plan', 'implement', 'test-report',
    ]);
  });

  it('prunes depends_on edges to excluded upstream steps', () => {
    const p = assemblePipeline(workspace(), { recipeId: 'bugfix' });
    const byName = Object.fromEntries(
      p.steps.map((s) => [(s as { name: string }).name, s as { depends_on: string[] }]),
    );
    // implement normally depends on 'design' (excluded) → pruned to root.
    expect(byName.implement.depends_on).toEqual([]);
    // test-report depends on [implement, test-plan]; test-plan excluded → only implement survives.
    expect(byName['test-report'].depends_on).toEqual(['implement']);
  });

  it('re-links depends_on across an excluded intermediate to the nearest ancestor', () => {
    const ws = workspace();
    // implement → design → plan. Exclude design; implement should re-link to plan.
    ws.recipes.push({ id: 'plan-then-build', steps: ['plan', 'implement'] });
    const p = assemblePipeline(ws, { recipeId: 'plan-then-build' });
    const implement = p.steps.find((s) => (s as { name: string }).name === 'implement') as { depends_on: string[] };
    expect(implement.depends_on).toEqual(['plan']);
  });

  it('defaults the assembled pipeline id to the recipe id', () => {
    const p = assemblePipeline(workspace(), { recipeId: 'bugfix' });
    expect(p.id).toBe('bugfix');
  });

  it('throws on an unknown recipe', () => {
    expect(() => assemblePipeline(workspace(), { recipeId: 'nope' })).toThrow(PipelineAssembleError);
  });

  it('throws when a recipe references an unknown source pipeline', () => {
    const ws = workspace();
    ws.recipes.push({ id: 'bad', from: 'ghost', steps: ['plan'] });
    expect(() => assemblePipeline(ws, { recipeId: 'bad' })).toThrow(/not defined/);
  });

  it('throws when the assembled pipeline references an undefined agent', () => {
    const ws = workspace();
    // Corrupt the source step's agent, then assemble a recipe that includes it.
    (ws.pipelines[0].steps[0] as { agent: string }).agent = 'ghost-agent';
    ws.recipes.push({ id: 'broken', steps: ['plan'] });
    expect(() => assemblePipeline(ws, { recipeId: 'broken' })).toThrow(/unresolved references/);
  });
});

describe('collectWorkspaceRefIssues', () => {
  it('reports a clean workspace as having no issues', () => {
    expect(collectWorkspaceRefIssues(workspace())).toEqual([]);
  });

  it('flags a pipeline step pointing at an undefined agent', () => {
    const ws = workspace();
    (ws.pipelines[0].steps[0] as { agent: string }).agent = 'ghost';
    const issues = collectWorkspaceRefIssues(ws);
    expect(issues.some((i) => i.code === 'unknown-agent')).toBe(true);
  });

  it('flags a recipe referencing a step missing from its source pipeline', () => {
    const ws = workspace();
    ws.recipes.push({ id: 'x', steps: ['nonexistent-step'] });
    const issues = collectWorkspaceRefIssues(ws);
    expect(issues.some((i) => i.code === 'unknown-recipe-step')).toBe(true);
  });
});
