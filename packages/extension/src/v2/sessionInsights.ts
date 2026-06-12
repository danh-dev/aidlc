/**
 * Rich per-session transcript parser for the observability dashboard.
 *
 * Where `tokenRecords.ts` keeps only assistant calls (for cost rules), this
 * does a FULL single-session pass over every JSONL entry type and produces a
 * `SessionInsight` covering the seven dashboard panels:
 *   hooks · prompts · context-management · cache · context-window · subagents · retrieval.
 *
 * All field names below were verified against real transcripts (Claude Code
 * writes `~/.claude/projects/<encoded-dir>/<session-id>.jsonl`). Field shapes
 * can drift across Claude Code versions, so we capture the `version` field per
 * session and parse defensively — unknown entry types are ignored, never throw.
 *
 * Verified entry types: user, assistant, system, attachment, file-history-snapshot,
 * last-prompt, ai-title, queue-operation. Compaction shows as
 * `type:system, subtype:compact_boundary` (+ compactMetadata). Subagents live in
 * a sibling `subagents/agent-<id>.jsonl` and carry `agentId` / `attributionAgent`
 * / `sourceToolAssistantUUID` / `isSidechain:true`.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import { calcCost, type Usage } from './tokenPricing';
import { projectsRoot, decodeProject, shortenPath } from './tokenRecords';

/** One assistant call — a point on the token/cache/context timeline. */
export interface TurnPoint {
  ts: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Full prompt size for this call ≈ input + cache_read + cache_creation. Proxy for context-window fill. */
  contextTokens: number;
  cost: number;
  /** Running cost up to and including this turn. */
  cumulativeCost: number;
  /** Tool names invoked in this assistant turn. */
  tools: string[];
}

export interface PromptEntry {
  ts: string;
  text: string;
  /** `promptSource` — e.g. 'user', 'slashCommand', etc. */
  source: string | null;
  permissionMode: string | null;
}

/** One hook execution, from `type:system, subtype:*_hook_summary`. */
export interface HookEvent {
  ts: string;
  /** e.g. 'stop_hook_summary', 'pre_tool_use_hook_summary'. */
  subtype: string;
  command: string;
  durationMs: number;
  error: string | null;
}

export interface HookCommandSummary {
  command: string;
  /** Human label derived from the subtype (event the hook fired on). */
  events: string[];
  count: number;
  totalMs: number;
  errorCount: number;
  lastError: string | null;
}

export interface CompactionEvent {
  ts: string;
  /** Pre/post token counts when present in compactMetadata. */
  preTokens: number | null;
  trigger: string | null;
}

export interface ToolCount {
  name: string;
  count: number;
}

export interface RetrievalSummary {
  /** Read/Grep/Glob/WebFetch/WebSearch/MCP resource reads — the "retrieval" surface. */
  byTool: ToolCount[];
  fileReads: number;
  webSearches: number;
  webFetches: number;
  mcpReads: number;
  /** Distinct file paths read (deduped, capped for display). */
  readPaths: string[];
}

export interface SubagentInsight {
  agentId: string;
  /** `attributionAgent` — the subagent type/name (e.g. 'Explore', 'general-purpose'). */
  agentType: string | null;
  /** Links back to the Task tool_use UUID in the parent session. */
  parentToolUuid: string | null;
  startedAt: string | null;
  endedAt: string | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cost: number;
  tools: ToolCount[];
}

export interface SessionTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cost: number;
}

export interface SessionInsight {
  sessionId: string;
  /** Encoded project dir name under `~/.claude/projects/`. */
  project: string;
  /** Human-friendly decoded project path. */
  projectPath: string;
  cwd: string;
  title: string | null;
  gitBranch: string | null;
  /** Claude Code version that wrote this transcript (for field-drift awareness). */
  version: string | null;
  startedAt: string | null;
  endedAt: string | null;

  totals: SessionTotals;
  cache: { hitRatio: number; readTokens: number; creationTokens: number };
  context: { peakTokens: number; lastTokens: number };

  turns: TurnPoint[];
  prompts: PromptEntry[];
  hooks: HookEvent[];
  hookSummary: HookCommandSummary[];
  compactions: CompactionEvent[];
  fileEdits: number;
  retrieval: RetrievalSummary;
  toolUse: ToolCount[];
  subagents: SubagentInsight[];
}

/** Lightweight session-index row for a picker (no full parse). */
export interface SessionListItem {
  sessionId: string;
  project: string;
  projectPath: string;
  jsonlPath: string;
  mtimeMs: number;
  sizeBytes: number;
}

const RETRIEVAL_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookRead']);

function cacheCreationTotal(u: RawUsage | undefined): number {
  if (!u) { return 0; }
  const c = u.cache_creation;
  if (c) {
    return (Number(c.ephemeral_5m_input_tokens) || 0) + (Number(c.ephemeral_1h_input_tokens) || 0);
  }
  return Number(u.cache_creation_input_tokens) || 0;
}

function toUsage(u: RawUsage): Usage {
  return {
    input_tokens: Number(u.input_tokens) || 0,
    output_tokens: Number(u.output_tokens) || 0,
    cache_read_input_tokens: Number(u.cache_read_input_tokens) || 0,
    cache_creation_input_tokens: cacheCreationTotal(u),
    cache_creation: u.cache_creation,
  };
}

function inc(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function countsToSorted(map: Map<string, number>): ToolCount[] {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') { return content; }
  if (!Array.isArray(content)) { return ''; }
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') { parts.push(block); continue; }
    if (block && typeof block === 'object') {
      const b = block as { type?: string; text?: string };
      if (b.type === 'text' && typeof b.text === 'string') { parts.push(b.text); }
    }
  }
  return parts.join('\n').trim();
}

/**
 * Parse a single session transcript into a `SessionInsight`. Also folds in any
 * subagent transcripts found in the sibling `subagents/` directory.
 */
export async function parseSession(jsonlPath: string): Promise<SessionInsight | null> {
  if (!fs.existsSync(jsonlPath)) { return null; }
  const project = path.basename(path.dirname(jsonlPath));
  const sessionId = path.basename(jsonlPath, '.jsonl');

  const turns: TurnPoint[] = [];
  const prompts: PromptEntry[] = [];
  const hooks: HookEvent[] = [];
  const compactions: CompactionEvent[] = [];
  const toolCounts = new Map<string, number>();
  const retrievalCounts = new Map<string, number>();
  const readPaths = new Set<string>();

  let title: string | null = null;
  let gitBranch: string | null = null;
  let version: string | null = null;
  let cwd = '';
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let fileEdits = 0;
  let cumulativeCost = 0;

  // Dedup assistant turns by message.id (Claude emits one entry per content block).
  const seenMsgIds = new Set<string>();

  const stream = fs.createReadStream(jsonlPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line || line[0] !== '{') { continue; }
      let o: RawEntry;
      try { o = JSON.parse(line); } catch { continue; }

      if (o.timestamp) {
        if (!startedAt) { startedAt = o.timestamp; }
        endedAt = o.timestamp;
      }
      if (o.gitBranch) { gitBranch = o.gitBranch; }
      if (o.version) { version = o.version; }
      if (o.cwd) { cwd = o.cwd; }

      switch (o.type) {
        case 'ai-title':
          if (typeof o.aiTitle === 'string') { title = o.aiTitle; }
          break;

        case 'file-history-snapshot':
          if (!o.isSnapshotUpdate) { fileEdits++; }
          break;

        case 'user': {
          const text = textFromContent(o.message?.content);
          if (text) {
            prompts.push({
              ts: o.timestamp ?? '',
              text,
              source: o.promptSource ?? null,
              permissionMode: o.permissionMode ?? null,
            });
          }
          break;
        }

        case 'system': {
          const sub = o.subtype ?? '';
          if (sub === 'compact_boundary') {
            const meta = o.compactMetadata ?? {};
            compactions.push({
              ts: o.timestamp ?? '',
              preTokens: Number(meta.preTokens ?? meta.preCompactionTokenCount) || null,
              trigger: typeof meta.trigger === 'string' ? meta.trigger : null,
            });
          } else if (sub.endsWith('hook_summary') && Array.isArray(o.hookInfos)) {
            const errs = Array.isArray(o.hookErrors) ? o.hookErrors : [];
            o.hookInfos.forEach((h, i) => {
              hooks.push({
                ts: o.timestamp ?? '',
                subtype: sub,
                command: typeof h.command === 'string' ? h.command : '(unknown)',
                durationMs: Number(h.durationMs) || 0,
                error: typeof errs[i] === 'string' ? errs[i] : (errs.length === 1 && i === 0 ? errs[0] : null),
              });
            });
          }
          break;
        }

        case 'assistant': {
          const msg = o.message;
          if (!msg) { break; }
          const msgId = msg.id ?? '';
          // tool blocks accumulate across every entry for this msg id
          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (!block || typeof block !== 'object') { continue; }
              const c = block as { type?: string; name?: string; input?: { file_path?: string } };
              if (c.type !== 'tool_use') { continue; }
              const name = c.name ?? '';
              if (!name) { continue; }
              inc(toolCounts, name);
              const isMcp = name.startsWith('mcp__');
              if (RETRIEVAL_TOOLS.has(name) || isMcp) { inc(retrievalCounts, name); }
              if (name === 'Read' && typeof c.input?.file_path === 'string') {
                readPaths.add(c.input.file_path);
              }
            }
          }
          // usage/cost once per msg id
          if (msgId && !seenMsgIds.has(msgId) && msg.usage) {
            seenMsgIds.add(msgId);
            const usage = toUsage(msg.usage);
            const model = msg.model ?? 'unknown';
            const cost = calcCost(usage, model);
            cumulativeCost += cost;
            const contextTokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
            turns.push({
              ts: o.timestamp ?? '',
              model,
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              cacheReadTokens: usage.cache_read_input_tokens,
              cacheCreationTokens: usage.cache_creation_input_tokens,
              contextTokens,
              cost,
              cumulativeCost,
              tools: [],
            });
          }
          break;
        }

        default:
          break;
      }
    }
  } finally {
    rl.close();
    stream.close();
  }

  // ── derive aggregates ──────────────────────────────────────────────────
  const totals: SessionTotals = {
    calls: turns.length,
    inputTokens: sum(turns, (t) => t.inputTokens),
    outputTokens: sum(turns, (t) => t.outputTokens),
    cacheReadTokens: sum(turns, (t) => t.cacheReadTokens),
    cacheCreationTokens: sum(turns, (t) => t.cacheCreationTokens),
    cost: cumulativeCost,
  };
  const cacheDenom = totals.inputTokens + totals.cacheReadTokens + totals.cacheCreationTokens;
  const cache = {
    hitRatio: cacheDenom > 0 ? totals.cacheReadTokens / cacheDenom : 0,
    readTokens: totals.cacheReadTokens,
    creationTokens: totals.cacheCreationTokens,
  };
  const context = {
    peakTokens: turns.reduce((m, t) => Math.max(m, t.contextTokens), 0),
    lastTokens: turns.length ? turns[turns.length - 1].contextTokens : 0,
  };

  const hookSummary = summarizeHooks(hooks);
  const subagents = await parseSubagents(path.join(path.dirname(jsonlPath), sessionId, 'subagents'));

  const retrieval: RetrievalSummary = {
    byTool: countsToSorted(retrievalCounts),
    fileReads: retrievalCounts.get('Read') ?? 0,
    webSearches: retrievalCounts.get('WebSearch') ?? 0,
    webFetches: retrievalCounts.get('WebFetch') ?? 0,
    mcpReads: [...retrievalCounts.entries()].filter(([n]) => n.startsWith('mcp__')).reduce((a, [, c]) => a + c, 0),
    readPaths: [...readPaths].map(shortenPath).slice(0, 200),
  };

  return {
    sessionId,
    project,
    projectPath: decodeProject(project),
    cwd,
    title,
    gitBranch,
    version,
    startedAt,
    endedAt,
    totals,
    cache,
    context,
    turns,
    prompts,
    hooks,
    hookSummary,
    compactions,
    fileEdits,
    retrieval,
    toolUse: countsToSorted(toolCounts),
    subagents,
  };
}

function sum<T>(arr: T[], f: (t: T) => number): number {
  let s = 0;
  for (const x of arr) { s += f(x); }
  return s;
}

function summarizeHooks(hooks: HookEvent[]): HookCommandSummary[] {
  const byCmd = new Map<string, HookCommandSummary>();
  for (const h of hooks) {
    let s = byCmd.get(h.command);
    if (!s) {
      s = { command: h.command, events: [], count: 0, totalMs: 0, errorCount: 0, lastError: null };
      byCmd.set(h.command, s);
    }
    s.count++;
    s.totalMs += h.durationMs;
    const evt = h.subtype.replace(/_hook_summary$/, '');
    if (!s.events.includes(evt)) { s.events.push(evt); }
    if (h.error) { s.errorCount++; s.lastError = h.error; }
  }
  return [...byCmd.values()].sort((a, b) => b.count - a.count);
}

async function parseSubagents(dir: string): Promise<SubagentInsight[]> {
  if (!fs.existsSync(dir)) { return []; }
  let files: string[];
  try { files = await fs.promises.readdir(dir); } catch { return []; }
  const out: SubagentInsight[] = [];
  for (const name of files) {
    if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) { continue; }
    const insight = await parseSubagentFile(path.join(dir, name));
    if (insight) { out.push(insight); }
  }
  out.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
  return out;
}

async function parseSubagentFile(file: string): Promise<SubagentInsight | null> {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const tools = new Map<string, number>();
  const seen = new Set<string>();
  let agentId = path.basename(file, '.jsonl').replace(/^agent-/, '');
  let agentType: string | null = null;
  let parentToolUuid: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cost = 0;
  try {
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line || line[0] !== '{') { continue; }
      let o: RawEntry;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.agentId) { agentId = o.agentId; }
      if (o.attributionAgent) { agentType = o.attributionAgent; }
      if (o.sourceToolAssistantUUID && !parentToolUuid) { parentToolUuid = o.sourceToolAssistantUUID; }
      if (o.timestamp) { if (!startedAt) { startedAt = o.timestamp; } endedAt = o.timestamp; }
      if (o.type !== 'assistant' || !o.message) { continue; }
      const msg = o.message;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          const c = block as { type?: string; name?: string };
          if (c?.type === 'tool_use' && c.name) { inc(tools, c.name); }
        }
      }
      const msgId = msg.id ?? '';
      if (msgId && !seen.has(msgId) && msg.usage) {
        seen.add(msgId);
        turns++;
        const usage = toUsage(msg.usage);
        inputTokens += usage.input_tokens;
        outputTokens += usage.output_tokens;
        cacheReadTokens += usage.cache_read_input_tokens;
        cost += calcCost(usage, msg.model ?? 'unknown');
      }
    }
  } finally {
    rl.close();
    stream.close();
  }
  return {
    agentId,
    agentType,
    parentToolUuid,
    startedAt,
    endedAt,
    turns,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cost,
    tools: countsToSorted(tools),
  };
}

/** Cheap index of recent sessions for a picker — stat only, no content parse. */
export async function listSessions(windowDays = 14): Promise<SessionListItem[]> {
  const root = projectsRoot();
  if (!fs.existsSync(root)) { return []; }
  const cutoff = windowDays > 0 ? Date.now() - windowDays * 86_400_000 : 0;
  const out: SessionListItem[] = [];
  let dirs: fs.Dirent[];
  try { dirs = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return []; }
  for (const d of dirs) {
    if (!d.isDirectory()) { continue; }
    const projectDir = path.join(root, d.name);
    let files: string[];
    try { files = await fs.promises.readdir(projectDir); } catch { continue; }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) { continue; }
      const jsonlPath = path.join(projectDir, name);
      let stat: fs.Stats;
      try { stat = await fs.promises.stat(jsonlPath); } catch { continue; }
      if (cutoff > 0 && stat.mtimeMs < cutoff) { continue; }
      out.push({
        sessionId: path.basename(name, '.jsonl'),
        project: d.name,
        projectPath: decodeProject(d.name),
        jsonlPath,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
      });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

// ── raw JSONL shapes (defensive; everything optional) ──────────────────────
interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

interface RawEntry {
  type?: string;
  subtype?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  promptSource?: string;
  permissionMode?: string;
  aiTitle?: string;
  isSnapshotUpdate?: boolean;
  isSidechain?: boolean;
  agentId?: string;
  attributionAgent?: string;
  sourceToolAssistantUUID?: string;
  hookInfos?: Array<{ command?: string; durationMs?: number }>;
  hookErrors?: string[];
  compactMetadata?: { preTokens?: number; preCompactionTokenCount?: number; trigger?: string };
  message?: {
    id?: string;
    model?: string;
    usage?: RawUsage;
    content?: unknown;
  };
}
