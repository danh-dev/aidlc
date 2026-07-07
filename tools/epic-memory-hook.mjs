#!/usr/bin/env node
/**
 * Claude Code UserPromptSubmit hook: when a prompt refers to an epic that has a
 * memory digest, inject that digest into the context — so working on an epic
 * automatically loads its prior decisions/constraints/reflections without you
 * running /epic-context first.
 *
 * Opt-in: only active while enabled (aidlc / the extension writes the hook entry
 * into ~/.claude/settings.json; disabling removes it). Zero-dep, and always
 * exits 0 so it can never block a prompt.
 *
 * Contract: reads the hook payload JSON on stdin ({ prompt, cwd, ... }); on
 * exit 0 whatever it prints to stdout is added to Claude's context.
 */
import fs from 'fs';
import path from 'path';

let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try { run(raw); } catch { /* never break the prompt */ }
  process.exit(0);
});

function run(raw) {
  let input = {};
  try { input = JSON.parse(raw) || {}; } catch { /* ignore */ }
  const prompt = String(input.prompt || '');
  const cwd = String(input.cwd || process.cwd());
  if (!prompt.trim()) { return; }

  const epicsDir = path.join(cwd, 'docs', 'epics');
  let ids;
  try {
    ids = fs.readdirSync(epicsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch { return; } // no epics here
  if (!ids.length) { return; }

  const lower = prompt.toLowerCase();
  const matched = ids.filter((id) => {
    if (lower.includes(id.toLowerCase())) { return true; }
    // Also match the leading code (DEMO-002 for DEMO-002-AUTO-REVIEW, EPIC-001 …).
    const code = (id.match(/^[A-Za-z]+-\d+/) || [])[0];
    return code ? lower.includes(code.toLowerCase()) : false;
  });
  if (!matched.length) { return; }

  const blocks = [];
  for (const id of matched) {
    const p = path.join(epicsDir, id, 'epic-memory.json');
    let mem;
    try { mem = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    const digest = format(mem, id);
    if (digest) { blocks.push(digest); }
  }
  if (!blocks.length) { return; }

  console.log('# AIDLC epic memory (auto-loaded — prior context for this epic; prefer it over re-reading artifacts)\n');
  console.log(blocks.join('\n\n'));
}

function format(m, id) {
  const lines = [`## ${m.epic || id}`];
  if (m.summary) { lines.push(`Summary: ${m.summary}`); }
  const entries = Array.isArray(m.entries) ? m.entries : [];
  const reflections = Array.isArray(m.reflections) ? m.reflections : [];
  if (entries.length) {
    lines.push('Decisions/constraints/context:');
    for (const e of entries) { lines.push(`- [${e.kind || 'note'}] ${e.text}`); }
  }
  if (reflections.length) {
    lines.push('Reflections (prompt/work better):');
    for (const r of reflections) { lines.push(`- ${r.text}`); }
  }
  return lines.length > 1 ? lines.join('\n') : '';
}
