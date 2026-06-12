/**
 * Minimal OpenTelemetry receiver for Claude Code's built-in telemetry.
 *
 * Claude Code can natively export metrics/logs over OTLP when these env vars
 * are set (we write them to ~/.claude/settings.json via `enableTelemetryEnv`):
 *   CLAUDE_CODE_ENABLE_TELEMETRY=1
 *   OTEL_METRICS_EXPORTER=otlp
 *   OTEL_EXPORTER_OTLP_PROTOCOL=http/json
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:<port>
 *
 * We run a tiny HTTP server that accepts OTLP/JSON POSTs on `/v1/metrics`
 * (and tolerates `/v1/logs`), parses the metric data points, and keeps a live
 * aggregate snapshot. JSON protocol is used deliberately so we need no
 * protobuf dependency — just JSON.parse.
 *
 * This complements the JSONL watcher: JSONL gives the full per-session story
 * after the fact; OTel gives low-latency counters as the session runs.
 */
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface OtelModelRow { model: string; tokens: number; cost: number; }

export interface OtelSnapshot {
  /** Receiver HTTP server is listening. */
  listening: boolean;
  port: number;
  /** True once we've received at least one OTLP payload. */
  receiving: boolean;
  lastEventAt: number | null;
  tokensByType: Record<string, number>;
  totalTokens: number;
  totalCostUsd: number;
  byModel: OtelModelRow[];
  sessions: number;
  linesAdded: number;
  linesRemoved: number;
  commits: number;
  /** True when the env vars that point Claude Code at us are present in settings.json. */
  envConfigured: boolean;
}

const DEFAULT_PORT = 4319;

/** One time-series, keyed by metric name + sorted attributes; we keep the latest value. */
type SeriesMap = Map<string, { metric: string; attrs: Record<string, string>; value: number }>;

export class OtelReceiver {
  private server: http.Server | undefined;
  private readonly series: SeriesMap = new Map();
  private lastEventAt: number | null = null;
  private onUpdate: (() => void) | undefined;

  constructor(private readonly port = DEFAULT_PORT) {}

  start(onUpdate: () => void): void {
    if (this.server) { return; }
    this.onUpdate = onUpdate;
    const server = http.createServer((req, res) => this.handle(req, res));
    server.on('error', () => { /* port busy / shutting down — stay soft */ });
    server.listen(this.port, '127.0.0.1');
    this.server = server;
  }

  stop(): void {
    try { this.server?.close(); } catch { /* ignore */ }
    this.server = undefined;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST') { res.writeHead(200).end('ok'); return; }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const url = req.url ?? '';
      try {
        if (url.includes('/v1/metrics')) {
          this.ingestMetrics(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        }
        // /v1/logs and /v1/traces are accepted but not parsed (yet).
      } catch { /* malformed payload — ignore */ }
      // OTLP/JSON expects an empty-ish 200 JSON response.
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      this.lastEventAt = Date.now();
      this.onUpdate?.();
    });
    req.on('error', () => { try { res.writeHead(400).end(); } catch { /* ignore */ } });
  }

  /** Parse an OTLP/JSON ExportMetricsServiceRequest and fold data points into `series`. */
  private ingestMetrics(body: unknown): void {
    const rms = (body as { resourceMetrics?: unknown[] })?.resourceMetrics;
    if (!Array.isArray(rms)) { return; }
    for (const rm of rms) {
      const sms = (rm as { scopeMetrics?: unknown[] })?.scopeMetrics;
      if (!Array.isArray(sms)) { continue; }
      for (const sm of sms) {
        const metrics = (sm as { metrics?: unknown[] })?.metrics;
        if (!Array.isArray(metrics)) { continue; }
        for (const m of metrics) {
          const metric = m as { name?: string; sum?: { dataPoints?: unknown[] }; gauge?: { dataPoints?: unknown[] } };
          const name = metric.name ?? '';
          const points = metric.sum?.dataPoints ?? metric.gauge?.dataPoints;
          if (!name || !Array.isArray(points)) { continue; }
          for (const p of points) {
            const dp = p as { asInt?: string | number; asDouble?: number; attributes?: unknown[] };
            const value = dp.asDouble != null ? Number(dp.asDouble)
              : dp.asInt != null ? Number(dp.asInt) : 0;
            const attrs = parseAttrs(dp.attributes);
            const key = name + '|' + Object.entries(attrs).sort().map(([k, v]) => `${k}=${v}`).join(',');
            // Counters are cumulative per process: keep the latest (max) value per series.
            const prev = this.series.get(key);
            this.series.set(key, { metric: name, attrs, value: prev ? Math.max(prev.value, value) : value });
          }
        }
      }
    }
  }

  snapshot(): OtelSnapshot {
    const tokensByType: Record<string, number> = {};
    const modelMap = new Map<string, OtelModelRow>();
    const sessionIds = new Set<string>();
    let totalTokens = 0, totalCostUsd = 0, linesAdded = 0, linesRemoved = 0, commits = 0;

    for (const s of this.series.values()) {
      const sid = s.attrs['session.id'] ?? s.attrs['session_id'];
      if (sid) { sessionIds.add(sid); }
      const model = s.attrs['model'] ?? 'unknown';
      switch (s.metric) {
        case 'claude_code.token.usage': {
          const type = s.attrs['type'] ?? 'unknown';
          tokensByType[type] = (tokensByType[type] ?? 0) + s.value;
          totalTokens += s.value;
          const row = modelMap.get(model) ?? { model, tokens: 0, cost: 0 };
          row.tokens += s.value; modelMap.set(model, row);
          break;
        }
        case 'claude_code.cost.usage': {
          totalCostUsd += s.value;
          const row = modelMap.get(model) ?? { model, tokens: 0, cost: 0 };
          row.cost += s.value; modelMap.set(model, row);
          break;
        }
        case 'claude_code.lines_of_code.count': {
          if ((s.attrs['type'] ?? '') === 'removed') { linesRemoved += s.value; } else { linesAdded += s.value; }
          break;
        }
        case 'claude_code.commit.count':
          commits += s.value;
          break;
      }
    }

    return {
      listening: !!this.server,
      port: this.port,
      receiving: this.lastEventAt != null,
      lastEventAt: this.lastEventAt,
      tokensByType,
      totalTokens,
      totalCostUsd,
      byModel: [...modelMap.values()].sort((a, b) => b.tokens - a.tokens),
      sessions: sessionIds.size,
      linesAdded,
      linesRemoved,
      commits,
      envConfigured: isTelemetryEnvConfigured(this.port),
    };
  }
}

function parseAttrs(attrs: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(attrs)) { return out; }
  for (const a of attrs) {
    const kv = a as { key?: string; value?: Record<string, unknown> };
    if (!kv.key || !kv.value) { continue; }
    const v = kv.value;
    out[kv.key] = String(
      v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? '',
    );
  }
  return out;
}

// ── settings.json env wiring ────────────────────────────────────────────────

function settingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function readSettings(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8') || '{}'); } catch { return {}; }
}

export function telemetryEnv(port = DEFAULT_PORT): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${port}`,
    OTEL_METRIC_EXPORT_INTERVAL: '10000',
  };
}

export function isTelemetryEnvConfigured(port = DEFAULT_PORT): boolean {
  const env = (readSettings().env ?? {}) as Record<string, unknown>;
  return env.CLAUDE_CODE_ENABLE_TELEMETRY === '1'
    && typeof env.OTEL_EXPORTER_OTLP_ENDPOINT === 'string'
    && (env.OTEL_EXPORTER_OTLP_ENDPOINT as string).includes(`:${port}`);
}

/** Write (or remove) the telemetry env keys in ~/.claude/settings.json. Backs up once. */
export function setTelemetryEnv(enable: boolean, port = DEFAULT_PORT): void {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = readSettings();
  if (fs.existsSync(file)) { fs.copyFileSync(file, `${file}.bak`); }
  const env = (data.env && typeof data.env === 'object' ? data.env : {}) as Record<string, unknown>;
  const keys = Object.keys(telemetryEnv(port));
  if (enable) {
    Object.assign(env, telemetryEnv(port));
  } else {
    for (const k of keys) { delete env[k]; }
  }
  if (Object.keys(env).length > 0) { data.env = env; } else { delete data.env; }
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
