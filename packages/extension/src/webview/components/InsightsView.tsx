/**
 * "Insights" tab — live, per-session observability built entirely from the
 * Claude Code transcript (`~/.claude/projects/**.jsonl`). No external server,
 * no plugin: the host parses the JSONL and fs.watches it for live appends.
 *
 * Seven panels, one data source:
 *   Overview · Context+Cache timeline · Hooks · Prompts ·
 *   Context management · Retrieval · Tools · Subagents
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Activity, Webhook, MessageSquare, Layers, Search, Wrench, Bot, Database, Clock, AlertTriangle, Radio,
} from 'lucide-react';
import { onHostMessage, postMessage } from '../lib/bridge';
import { cn } from '../lib/utils';
import type {
  InsightPanelState, SessionInsight, TurnPoint, ToolCount, OtelSnapshot,
} from '../lib/types';

function useOtelState(): OtelSnapshot | null {
  const [snap, setSnap] = useState<OtelSnapshot | null>(null);
  useEffect(
    () => onHostMessage((msg) => { if (msg.type === 'otel') setSnap(msg.snapshot as OtelSnapshot); }),
    [],
  );
  return snap;
}

// ── formatting helpers ──────────────────────────────────────────────────────
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'k';
  return String(n);
}
function fmtCost(n: number): string {
  return '$' + (n < 1 ? n.toFixed(3) : n.toFixed(2));
}
function fmtMs(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + 's' : Math.round(n) + 'ms';
}
function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function shortModel(m: string): string {
  return m.replace(/^claude-/, '').replace(/-\d{6,}$/, '').replace(/\[1m\]$/, ' (1M)');
}

// ── small layout primitives ─────────────────────────────────────────────────
function Panel({ icon, title, subtitle, children, className }: {
  icon: React.ReactNode; title: string; subtitle?: string; children: React.ReactNode; className?: string;
}) {
  return (
    <section className={cn('rounded-xl border border-border bg-card/40 p-4', className)}>
      <header className="mb-3 flex items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {subtitle && <span className="text-xs text-muted-foreground">· {subtitle}</span>}
      </header>
      {children}
    </section>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'warn' }) {
  return (
    <div className="rounded-lg border border-border bg-background/50 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 text-lg font-semibold tabular-nums',
        tone === 'good' ? 'text-emerald-500' : tone === 'warn' ? 'text-amber-500' : 'text-foreground')}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

/** Horizontal labelled bar list (tools, retrieval). */
function BarList({ items, max }: { items: ToolCount[]; max?: number }) {
  const top = max ? items.slice(0, max) : items;
  const peak = Math.max(1, ...top.map((i) => i.count));
  return (
    <div className="space-y-1.5">
      {top.map((it) => (
        <div key={it.name} className="flex items-center gap-2">
          <div className="w-32 shrink-0 truncate text-xs text-muted-foreground" title={it.name}>{it.name}</div>
          <div className="relative h-4 flex-1 overflow-hidden rounded bg-secondary/40">
            <div className="absolute inset-y-0 left-0 rounded bg-primary/70" style={{ width: `${(it.count / peak) * 100}%` }} />
          </div>
          <div className="w-8 shrink-0 text-right text-xs tabular-nums text-foreground">{it.count}</div>
        </div>
      ))}
      {top.length === 0 && <div className="text-xs text-muted-foreground">None</div>}
    </div>
  );
}

/** Hand-rolled stacked area chart of context composition over turns. */
function ContextChart({ turns }: { turns: TurnPoint[] }) {
  const W = 640, H = 140, pad = 4;
  const data = turns;
  if (data.length < 2) return <div className="text-xs text-muted-foreground">Not enough turns yet.</div>;
  const peak = Math.max(1, ...data.map((t) => t.contextTokens));
  const x = (i: number) => pad + (i / (data.length - 1)) * (W - 2 * pad);
  const y = (v: number) => H - pad - (v / peak) * (H - 2 * pad);
  // cache_read (bottom) + input + cache_creation stacked = contextTokens
  const layer = (pick: (t: TurnPoint) => number, base: (t: TurnPoint) => number) => {
    const up = data.map((t, i) => `${x(i)},${y(base(t) + pick(t))}`).join(' ');
    const down = data.map((t, i) => `${x(data.length - 1 - i)},${y(base(data[data.length - 1 - i]))}`).join(' ');
    return `M ${up} L ${down} Z`;
  };
  const read = (t: TurnPoint) => t.cacheReadTokens;
  const input = (t: TurnPoint) => t.inputTokens;
  const create = (t: TurnPoint) => t.cacheCreationTokens;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none">
        <path d={layer(read, () => 0)} className="fill-emerald-500/40" />
        <path d={layer(input, read)} className="fill-primary/50" />
        <path d={layer(create, (t) => read(t) + input(t))} className="fill-amber-500/40" />
        <polyline
          points={data.map((t, i) => `${x(i)},${y(t.contextTokens)}`).join(' ')}
          className="fill-none stroke-foreground/60" strokeWidth={1}
        />
      </svg>
      <div className="mt-1 flex gap-4 text-[11px] text-muted-foreground">
        <Legend className="bg-emerald-500/40" label="cache read" />
        <Legend className="bg-primary/50" label="input" />
        <Legend className="bg-amber-500/40" label="cache write" />
        <span className="ml-auto">peak {fmtTokens(peak)} tok</span>
      </div>
    </div>
  );
}
function Legend({ className, label }: { className: string; label: string }) {
  return <span className="flex items-center gap-1"><span className={cn('inline-block h-2 w-3 rounded-sm', className)} />{label}</span>;
}

/** Live OTel strip — Claude Code's native telemetry, low-latency counters. */
function OtelStrip({ snap }: { snap: OtelSnapshot | null }) {
  if (!snap) { return null; }
  const fresh = snap.lastEventAt != null && Date.now() - snap.lastEventAt < 30_000;
  if (!snap.receiving) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border bg-card/30 p-3 text-xs text-muted-foreground">
        <Radio size={14} className="text-muted-foreground" />
        <span>
          OTel live metrics {snap.listening ? `(receiver on :${snap.port})` : '(receiver off)'} —{' '}
          {snap.envConfigured ? 'enabled in settings; start a new Claude Code session to stream.' : 'not enabled.'}
        </span>
        {!snap.envConfigured && (
          <button onClick={() => postMessage({ type: 'enableOtel' })}
            className="ml-auto rounded-md border border-border px-2 py-1 text-foreground hover:bg-secondary">
            Enable Claude Code telemetry → here
          </button>
        )}
        {snap.envConfigured && (
          <button onClick={() => postMessage({ type: 'disableOtel' })}
            className="ml-auto rounded-md border border-border px-2 py-1 hover:bg-secondary">Disable</button>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-500">
        <span className={cn('h-1.5 w-1.5 rounded-full bg-emerald-500', fresh && 'animate-pulse')} /> OTel live
      </span>
      <Mini label="cost" value={fmtCost(snap.totalCostUsd)} />
      <Mini label="tokens" value={fmtTokens(snap.totalTokens)} />
      <Mini label="in" value={fmtTokens(snap.tokensByType['input'] ?? 0)} />
      <Mini label="out" value={fmtTokens(snap.tokensByType['output'] ?? 0)} />
      <Mini label="cacheRead" value={fmtTokens(snap.tokensByType['cacheRead'] ?? 0)} />
      <Mini label="sessions" value={String(snap.sessions)} />
      <Mini label="LOC +/-" value={`${snap.linesAdded}/${snap.linesRemoved}`} />
      <Mini label="commits" value={String(snap.commits)} />
      <span className="ml-auto text-[11px] text-muted-foreground">{snap.byModel.map((m) => shortModel(m.model)).slice(0, 3).join(' · ')}</span>
    </div>
  );
}
function Mini({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-foreground">{value}</span>
    </span>
  );
}

// ── main view ────────────────────────────────────────────────────────────────
export function InsightsView({ state }: { state: InsightPanelState }) {
  const { sessions, selectedPath, insight, loading } = state;
  const otel = useOtelState();
  const sessionOptions = useMemo(
    () => sessions.map((s) => ({
      value: s.jsonlPath,
      label: `${s.projectPath.split('/').pop() || s.project} · ${s.sessionId.slice(0, 8)} · ${new Date(s.mtimeMs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
    })),
    [sessions],
  );

  return (
    <div className="space-y-4 p-6">
      {/* picker */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={selectedPath ?? ''}
          onChange={(e) => postMessage({ type: 'selectSession', jsonlPath: e.target.value })}
          className="max-w-xl flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground"
        >
          {sessionOptions.length === 0 && <option value="">No recent sessions found</option>}
          {sessionOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button
          onClick={() => postMessage({ type: 'listSessions' })}
          className="rounded-md border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          Refresh
        </button>
        {loading && <span className="text-xs text-muted-foreground">updating…</span>}
        <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-emerald-500">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> live (transcript watch)
        </span>
      </div>

      <OtelStrip snap={otel} />

      {!insight && <div className="rounded-xl border border-border bg-card/40 p-8 text-center text-sm text-muted-foreground">
        {loading ? 'Parsing transcript…' : 'Select a session to inspect.'}
      </div>}

      {insight && <InsightBody insight={insight} />}
    </div>
  );
}

function InsightBody({ insight: s }: { insight: SessionInsight }) {
  const cacheTone = s.cache.hitRatio >= 0.8 ? 'good' : s.cache.hitRatio >= 0.5 ? undefined : 'warn';
  const ctxPct = Math.min(100, Math.round((s.context.lastTokens / 200_000) * 100)); // 200k window heuristic

  return (
    <>
      {/* header */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold text-foreground">{s.title || s.sessionId.slice(0, 8)}</h2>
        <span className="text-xs text-muted-foreground">{s.projectPath}</span>
        {s.gitBranch && <span className="rounded bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">{s.gitBranch}</span>}
        {s.version && <span className="text-[11px] text-muted-foreground">cc v{s.version}</span>}
        <span className="ml-auto text-[11px] text-muted-foreground">{fmtTime(s.startedAt)} → {fmtTime(s.endedAt)}</span>
      </div>

      {/* overview */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        <Stat label="Cost" value={fmtCost(s.totals.cost)} sub={`${s.totals.calls} calls`} />
        <Stat label="Output" value={fmtTokens(s.totals.outputTokens)} sub="generated tok" />
        <Stat label="Cache hit" value={`${Math.round(s.cache.hitRatio * 100)}%`} sub={`${fmtTokens(s.cache.readTokens)} read`} tone={cacheTone} />
        <Stat label="Context now" value={fmtTokens(s.context.lastTokens)} sub={`~${ctxPct}% of 200k`} tone={ctxPct > 85 ? 'warn' : undefined} />
        <Stat label="Subagents" value={String(s.subagents.length)} sub={`${s.fileEdits} file edits`} />
        <Stat label="Hooks" value={String(s.hookSummary.reduce((a, h) => a + h.count, 0))} sub={`${s.hookSummary.reduce((a, h) => a + h.errorCount, 0)} errors`} tone={s.hookSummary.some((h) => h.errorCount) ? 'warn' : undefined} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* context + cache timeline */}
        <Panel icon={<Activity size={15} />} title="Context & cache over turns" subtitle={`${s.turns.length} turns`} className="lg:col-span-2">
          <ContextChart turns={s.turns} />
        </Panel>

        {/* hooks */}
        <Panel icon={<Webhook size={15} />} title="Hooks" subtitle="config from transcript runs">
          <div className="space-y-2">
            {s.hookSummary.map((h) => (
              <div key={h.command} className="rounded-lg border border-border bg-background/40 p-2">
                <div className="flex items-center gap-2">
                  <code className="truncate text-xs text-foreground" title={h.command}>{h.command}</code>
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{h.count}× · {fmtMs(h.totalMs)}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {h.events.map((e) => <span key={e} className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">{e}</span>)}
                  {h.errorCount > 0 && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-amber-500" title={h.lastError ?? ''}>
                      <AlertTriangle size={11} /> {h.errorCount} err
                    </span>
                  )}
                </div>
                {h.lastError && <div className="mt-1 truncate text-[10px] text-amber-500/80" title={h.lastError}>{h.lastError}</div>}
              </div>
            ))}
            {s.hookSummary.length === 0 && <div className="text-xs text-muted-foreground">No hooks fired in this session.</div>}
          </div>
        </Panel>

        {/* subagents */}
        <Panel icon={<Bot size={15} />} title="Agents & subagents" subtitle={`${s.subagents.length} spawned`}>
          <div className="space-y-2">
            {s.subagents.map((a) => (
              <div key={a.agentId} className="rounded-lg border border-border bg-background/40 p-2">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[11px] font-medium text-primary">{a.agentType || 'agent'}</span>
                  <span className="text-[11px] text-muted-foreground">{a.turns} turns</span>
                  <span className="ml-auto text-[11px] tabular-nums text-foreground">{fmtCost(a.cost)} · {fmtTokens(a.outputTokens)} out</span>
                </div>
                {a.tools.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {a.tools.slice(0, 8).map((t) => <span key={t.name} className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">{t.name}·{t.count}</span>)}
                  </div>
                )}
              </div>
            ))}
            {s.subagents.length === 0 && <div className="text-xs text-muted-foreground">No subagents spawned.</div>}
          </div>
        </Panel>

        {/* prompts */}
        <Panel icon={<MessageSquare size={15} />} title="Prompts" subtitle={`${s.prompts.length} user turns`}>
          <ol className="space-y-1.5">
            {s.prompts.slice(-12).map((p, i) => (
              <li key={i} className="flex gap-2 text-xs">
                <span className="shrink-0 text-muted-foreground">{fmtTime(p.ts).split(', ').pop()}</span>
                <span className="line-clamp-2 text-foreground/90">{p.text}</span>
              </li>
            ))}
            {s.prompts.length === 0 && <li className="text-xs text-muted-foreground">No prompts.</li>}
          </ol>
        </Panel>

        {/* context management */}
        <Panel icon={<Layers size={15} />} title="Context management">
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Compactions" value={String(s.compactions.length)} sub="auto-summaries" tone={s.compactions.length ? 'warn' : 'good'} />
            <Stat label="Peak context" value={fmtTokens(s.context.peakTokens)} sub="largest prompt" />
            <Stat label="Cache write" value={fmtTokens(s.cache.creationTokens)} sub="new cache tok" />
            <Stat label="File edits" value={String(s.fileEdits)} sub="snapshots" />
          </div>
          {s.compactions.length > 0 && (
            <ul className="mt-2 space-y-1">
              {s.compactions.map((c, i) => (
                <li key={i} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Clock size={11} /> {fmtTime(c.ts)} {c.preTokens && `· ${fmtTokens(c.preTokens)} → summary`} {c.trigger && `(${c.trigger})`}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* retrieval */}
        <Panel icon={<Search size={15} />} title="Retrieval" subtitle="reads / search / MCP">
          <div className="mb-3 grid grid-cols-4 gap-2">
            <Stat label="File reads" value={String(s.retrieval.fileReads)} />
            <Stat label="Web search" value={String(s.retrieval.webSearches)} />
            <Stat label="Web fetch" value={String(s.retrieval.webFetches)} />
            <Stat label="MCP reads" value={String(s.retrieval.mcpReads)} />
          </div>
          <BarList items={s.retrieval.byTool} max={8} />
          <div className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
            <Database size={11} /> {s.retrieval.readPaths.length} distinct files read
          </div>
        </Panel>

        {/* tools */}
        <Panel icon={<Wrench size={15} />} title="Tool usage" subtitle={`${s.toolUse.reduce((a, t) => a + t.count, 0)} calls`}>
          <BarList items={s.toolUse} max={12} />
        </Panel>
      </div>
    </>
  );
}
