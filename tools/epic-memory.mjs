#!/usr/bin/env node
/**
 * Per-epic memory: a compact, durable digest of an epic kept in
 * `<epicDir>/epic-memory.json`, so continuing the epic later — with any
 * agent — is cheap on tokens. Instead of re-reading every artifact and the
 * git history, an agent reads this digest first.
 *
 * It holds three things:
 *   - summary      : one-paragraph "what this epic is + where it stands"
 *   - entries[]    : distilled decisions / constraints / context / notes
 *   - reflections[]: lessons on how to prompt / work more effectively next time
 *
 * Every write records who made it (git identity, hostname fallback) + a timestamp.
 * Zero external deps — runs with just `node`.
 *
 * Usage:
 *   node epic-memory.mjs show    <epicDir>
 *   node epic-memory.mjs add     <epicDir> --kind decision|constraint|context|note --text "..."
 *   node epic-memory.mjs reflect <epicDir> --text "..."
 *   node epic-memory.mjs summary <epicDir> --text "..."
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const FILE = 'epic-memory.json';
const KINDS = ['decision', 'constraint', 'context', 'note'];

function die(msg) { console.error(msg); process.exit(1); }

function detectAuthor(cwd) {
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 })
        .toString().trim();
    } catch { return ''; }
  };
  const name = git(['config', 'user.name']);
  if (name) {
    const email = git(['config', 'user.email']);
    return email ? `${name} <${email}>` : name;
  }
  return os.hostname();
}

function load(epicDir) {
  const p = path.join(epicDir, FILE);
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (data && typeof data === 'object') { return data; }
  } catch { /* missing or invalid → fresh */ }
  return { epic: path.basename(epicDir), summary: '', entries: [], reflections: [] };
}

function save(epicDir, mem) {
  mem.epic = mem.epic || path.basename(epicDir);
  mem.updatedAt = new Date().toISOString();
  mem.entries = mem.entries || [];
  mem.reflections = mem.reflections || [];
  fs.writeFileSync(path.join(epicDir, FILE), JSON.stringify(mem, null, 2) + '\n', 'utf8');
}

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--kind') { out.kind = args[++i]; }
    else if (args[i] === '--text') { out.text = args[++i]; }
  }
  return out;
}

function show(epicDir) {
  const p = path.join(epicDir, FILE);
  if (!fs.existsSync(p)) {
    console.log(`(no epic memory yet at ${p} — start fresh; add decisions with \`epic-memory.mjs add\`)`);
    return;
  }
  const m = load(epicDir);
  const lines = [`# Epic memory — ${m.epic}${m.updatedAt ? `  (updated ${m.updatedAt})` : ''}`];
  if (m.summary) { lines.push('', '## Summary', m.summary); }
  if (m.entries?.length) {
    lines.push('', '## Context & decisions');
    for (const e of m.entries) {
      lines.push(`- [${e.kind}] ${e.text}  —  ${e.author || '?'}, ${e.at || ''}`);
    }
  }
  if (m.reflections?.length) {
    lines.push('', '## Reflections (prompt/work better next time)');
    for (const r of m.reflections) {
      lines.push(`- ${r.text}  —  ${r.author || '?'}, ${r.at || ''}`);
    }
  }
  console.log(lines.join('\n'));
}

function main() {
  const [cmd, epicDir, ...rest] = process.argv.slice(2);
  if (!cmd || !epicDir) {
    die('usage: node epic-memory.mjs show|add|reflect|summary <epicDir> [--kind K] [--text "..."]');
  }
  if (!fs.existsSync(epicDir)) { die(`epic dir not found: ${epicDir}`); }

  if (cmd === 'show') { show(epicDir); return; }

  const { kind, text } = parseFlags(rest);
  const mem = load(epicDir);

  if (cmd === 'add') {
    if (!text) { die('add requires --text "..."'); }
    const k = KINDS.includes(kind) ? kind : 'note';
    mem.entries.push({ at: new Date().toISOString(), author: detectAuthor(epicDir), kind: k, text });
    save(epicDir, mem);
    console.log(`added ${k} to ${mem.epic} memory`);
  } else if (cmd === 'reflect') {
    if (!text) { die('reflect requires --text "..."'); }
    mem.reflections.push({ at: new Date().toISOString(), author: detectAuthor(epicDir), text });
    save(epicDir, mem);
    console.log(`added reflection to ${mem.epic} memory`);
  } else if (cmd === 'summary') {
    if (!text) { die('summary requires --text "..."'); }
    mem.summary = text;
    save(epicDir, mem);
    console.log(`set summary for ${mem.epic} memory`);
  } else {
    die(`unknown command: ${cmd}`);
  }
}

main();
