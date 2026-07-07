/**
 * Installs the annotation + epic-memory tooling into the user's global Claude
 * folder so `/annotate-artifact` and `/epic-context` work out of the box in any
 * project — no `python`, no `pip install`, no global `annotron`, just `node`
 * (which Claude Code already requires).
 *
 * Shared by the VS Code extension (auto-runs on activation) and the CLI
 * (`aidlc globals install`). The caller passes a `bundleRoot` — a directory that
 * contains the bundled payload:
 *   <bundleRoot>/tools/md-to-html.mjs        — zero-dep Node renderer (marked vendored)
 *   <bundleRoot>/tools/vendor/marked.esm.mjs — vendored markdown lib
 *   <bundleRoot>/tools/epic-memory.mjs       — per-epic memory CLI (zero-dep)
 *   <bundleRoot>/vendor/annotron/{bin,src,…} — vendored annotron (zero-dep)
 *   <bundleRoot>/assets/annotate-artifact.skill.md
 *   <bundleRoot>/assets/epic-context.skill.md
 *
 * They land under `~/.claude/`:
 *   tools/md-to-html.mjs, tools/vendor/marked.esm.mjs, tools/epic-memory.mjs,
 *   tools/annotron/**, skills/annotate-artifact/SKILL.md, skills/epic-context/SKILL.md
 *
 * The tools are ours and versioned with the release, so they're overwritten
 * every run. Skills are marker-stamped and only overwritten if they're ours — a
 * hand-edited file (no marker) is left alone.
 *
 * It does NOT touch the user's settings.json — permissions stay under the user's
 * control (the skill documents the allows to add for a prompt-free loop).
 *
 * Safe to call repeatedly; wrap the call in try/catch at the call site so a
 * filesystem hiccup never blocks startup.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SKILL_MARKER = '<!-- AIDLC annotation tool — reinstalled by AIDLC; hand edits are overwritten -->';
const SKILL_MARKER_KEY = 'AIDLC annotation tool';

export interface AnnotationToolsReport {
  installed: boolean;
  reason?: string;
}

export function installAnnotationTools(
  bundleRoot: string,
  log?: (msg: string) => void,
): AnnotationToolsReport {
  const home = os.homedir();
  const toolsDest = path.join(home, '.claude', 'tools');
  const skillsDest = path.join(home, '.claude', 'skills');

  const rendererSrc = path.join(bundleRoot, 'tools', 'md-to-html.mjs');
  const markedSrc = path.join(bundleRoot, 'tools', 'vendor', 'marked.esm.mjs');
  const epicMemorySrc = path.join(bundleRoot, 'tools', 'epic-memory.mjs');
  const annotronSrc = path.join(bundleRoot, 'vendor', 'annotron');
  // Skill source → skill name. Claude Code discovers personal skills as
  // `~/.claude/skills/<name>/SKILL.md` (directory form), NOT flat `.md` files.
  const skills: Array<[string, string]> = [
    [path.join(bundleRoot, 'assets', 'annotate-artifact.skill.md'), 'annotate-artifact'],
    [path.join(bundleRoot, 'assets', 'epic-context.skill.md'), 'epic-context'],
  ];

  // If the bundle is incomplete, do nothing rather than install a half tool.
  const required = [rendererSrc, markedSrc, epicMemorySrc, annotronSrc, ...skills.map(([s]) => s)];
  for (const p of required) {
    if (!fs.existsSync(p)) {
      const reason = `missing bundled source ${p}`;
      log?.(`annotationTools: ${reason} — skipping install`);
      return { installed: false, reason };
    }
  }

  fs.mkdirSync(path.join(toolsDest, 'vendor'), { recursive: true });
  fs.mkdirSync(skillsDest, { recursive: true });

  copyFile(rendererSrc, path.join(toolsDest, 'md-to-html.mjs'));
  copyFile(markedSrc, path.join(toolsDest, 'vendor', 'marked.esm.mjs'));
  copyFile(epicMemorySrc, path.join(toolsDest, 'epic-memory.mjs'));
  copyDir(annotronSrc, path.join(toolsDest, 'annotron'));

  for (const [src, name] of skills) {
    installSkill(src, path.join(skillsDest, name), name, log);
    // Migrate away from the earlier (broken) flat-file form.
    removeIfOurs(path.join(skillsDest, `aidlc-${name}.md`), log);
  }

  log?.(`annotationTools: installed renderer + annotron + epic-memory + skills into ${path.join(home, '.claude')}`);
  return { installed: true };
}

function installSkill(src: string, destDir: string, name: string, log?: (msg: string) => void): void {
  const body = fs.readFileSync(src, 'utf8');
  // Frontmatter stays on line 1; marker appended at the end.
  const stamped = `${body.replace(/\s*$/, '')}\n\n${SKILL_MARKER}\n`;
  const dest = path.join(destDir, 'SKILL.md');

  if (fs.existsSync(dest)) {
    const existing = fs.readFileSync(dest, 'utf8');
    if (!existing.includes(SKILL_MARKER_KEY)) {
      log?.(`annotationTools: skill ${name} exists and is user-owned — leaving it alone`);
      return; // never clobber a hand-authored skill
    }
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(dest, stamped, 'utf8');
}

/** Remove a file only if it carries our ownership marker (never a user's). */
function removeIfOurs(filePath: string, log?: (msg: string) => void): void {
  try {
    if (!fs.existsSync(filePath)) { return; }
    if (fs.readFileSync(filePath, 'utf8').includes(SKILL_MARKER_KEY)) {
      fs.unlinkSync(filePath);
      log?.(`annotationTools: removed stale ${path.basename(filePath)}`);
    }
  } catch { /* best-effort cleanup */ }
}

function copyFile(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}
