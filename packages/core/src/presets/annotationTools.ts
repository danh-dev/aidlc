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
  const epicMemoryHookSrc = path.join(bundleRoot, 'tools', 'epic-memory-hook.mjs');
  const annotronSrc = path.join(bundleRoot, 'vendor', 'annotron');
  // Skill source → skill name. Claude Code discovers personal skills as
  // `~/.claude/skills/<name>/SKILL.md` (directory form), NOT flat `.md` files.
  const skills: Array<[string, string]> = [
    [path.join(bundleRoot, 'assets', 'annotate-artifact.skill.md'), 'annotate-artifact'],
    [path.join(bundleRoot, 'assets', 'epic-context.skill.md'), 'epic-context'],
  ];

  // If the bundle is incomplete, do nothing rather than install a half tool.
  const required = [rendererSrc, markedSrc, epicMemorySrc, epicMemoryHookSrc, annotronSrc, ...skills.map(([s]) => s)];
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
  copyFile(epicMemoryHookSrc, path.join(toolsDest, 'epic-memory-hook.mjs'));
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

// ── Epic-memory auto-load hook (opt-in) ──────────────────────────────────────
// A UserPromptSubmit hook that injects an epic's memory when a prompt refers to
// it. Toggled explicitly by the user (CLI / extension); writes only the hook
// entry into ~/.claude/settings.json — nothing else is touched.

const HOOK_SCRIPT = 'epic-memory-hook.mjs';

interface HookEntry { type?: string; command?: string }
interface HookGroup { matcher?: string; hooks?: HookEntry[] }

function groupHasOurHook(g: HookGroup): boolean {
  return Array.isArray(g.hooks)
    && g.hooks.some((h) => typeof h.command === 'string' && h.command.includes(HOOK_SCRIPT));
}

/** Is the epic-memory auto-load hook currently enabled in ~/.claude/settings.json? */
export function isEpicMemoryHookEnabled(home: string): boolean {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    const groups = settings?.hooks?.UserPromptSubmit;
    return Array.isArray(groups) && groups.some((g: HookGroup) => groupHasOurHook(g));
  } catch {
    return false;
  }
}

/**
 * Enable / disable the epic-memory auto-load hook by editing the
 * `hooks.UserPromptSubmit` list in ~/.claude/settings.json. Additive/subtractive
 * merge — never touches other hooks or settings. Returns whether a change was
 * written and the resulting state.
 */
export function setEpicMemoryHook(
  enabled: boolean,
  home: string,
  log?: (msg: string) => void,
): { changed: boolean; enabled: boolean } {
  const settingsPath = path.join(home, '.claude', 'settings.json');
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (parsed && typeof parsed === 'object') { settings = parsed as Record<string, unknown>; }
    } catch {
      log?.('epicMemoryHook: ~/.claude/settings.json is not valid JSON — skipping');
      return { changed: false, enabled: isEpicMemoryHookEnabled(home) };
    }
  }
  const hooks = (settings.hooks && typeof settings.hooks === 'object'
    ? settings.hooks
    : (settings.hooks = {})) as Record<string, unknown>;
  const list = (Array.isArray(hooks.UserPromptSubmit)
    ? hooks.UserPromptSubmit
    : (hooks.UserPromptSubmit = [])) as HookGroup[];

  const has = list.some((g) => groupHasOurHook(g));
  let changed = false;

  if (enabled && !has) {
    const command = `node "${path.join(home, '.claude', 'tools', HOOK_SCRIPT)}"`;
    list.push({ hooks: [{ type: 'command', command }] });
    changed = true;
  } else if (!enabled && has) {
    const pruned = list
      .map((g) => (Array.isArray(g.hooks)
        ? { ...g, hooks: g.hooks.filter((h) => !(typeof h.command === 'string' && h.command.includes(HOOK_SCRIPT))) }
        : g))
      .filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
    if (pruned.length > 0) { hooks.UserPromptSubmit = pruned; }
    else { delete hooks.UserPromptSubmit; }
    changed = true;
  }

  if (changed) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    log?.(`epicMemoryHook: ${enabled ? 'enabled' : 'disabled'}`);
  }
  return { changed, enabled };
}
