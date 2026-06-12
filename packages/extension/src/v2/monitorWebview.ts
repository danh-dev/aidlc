/**
 * Unified "AIDLC Monitor" panel host — one webview, two tabs:
 *   • Token Usage — same data/report as the standalone token panel
 *   • Agents      — agents-observe live summary + embedded dashboard iframe
 *
 * The panel is single-instance per window. It drives two independent streams
 * to the React app: token report state (computed here from ~/.claude/projects
 * logs) and agents-observe status (polled from /api/health + /api/db/stats). Polling fails
 * soft — when the observe server is off the Agents tab just shows an off-state.
 */
import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { themeManager } from './themeManager';
import { loadAllRecords } from './tokenRecords';
import { buildReport, type TokenReport } from './tokenReport';
import { missingBundleHtml } from './webviewBundleGuard';
import { listSessions, parseSession, type SessionInsight, type SessionListItem } from './sessionInsights';
import { OtelReceiver, setTelemetryEnv, type OtelSnapshot } from './otelReceiver';
import {
  DASHBOARD_URL,
  OBSERVE_PORT,
  fetchObserveStatus,
  offlineStatus,
  type ObserveStatus,
} from './observeClient';

type MonitorTab = 'tokens' | 'agents' | 'insights';

interface TokenPanelState {
  report: TokenReport | null;
  loading: boolean;
  error: string | null;
  windowDays: number;
}

function aidlcDataDir(): string {
  return path.join(os.homedir(), '.aidlc', 'observe-data');
}

export class MonitorWebview {
  public static readonly viewType = 'aidlcMonitor';
  private static current: MonitorWebview | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private tokenState: TokenPanelState = { report: null, loading: false, error: null, windowDays: 30 };
  private loadPromise: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  // ── Session Insights state ──
  private selectedPath: string | null = null;
  private watchers: fs.FSWatcher[] = [];
  private watchDebounce: ReturnType<typeof setTimeout> | undefined;
  private parsing = false;

  // ── OTel live receiver ──
  private readonly otel = new OtelReceiver();
  private otelPushDebounce: ReturnType<typeof setTimeout> | undefined;

  static show(extensionUri: vscode.Uri, tab: MonitorTab = 'tokens'): void {
    if (MonitorWebview.current) {
      MonitorWebview.current.panel.reveal(vscode.ViewColumn.Active);
      void MonitorWebview.current.panel.webview.postMessage({ type: 'switchTab', tab });
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      MonitorWebview.viewType,
      'AIDLC Monitor',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );
    MonitorWebview.current = new MonitorWebview(panel, extensionUri, tab);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly initialTab: MonitorTab,
  ) {
    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg), null, this.disposables);
    this.disposables.push(themeManager.register(this.panel.webview));

    void this.loadReport();
    void this.pollAgents();
    void this.loadSessions();
    this.startOtel();
    this.startPolling();
  }

  // ── OTel live receiver ───────────────────────────────────────────────────

  private startOtel(): void {
    this.otel.start(() => this.pushOtelDebounced());
    this.disposables.push({ dispose: () => this.otel.stop() });
  }

  /** Coalesce bursts of OTLP posts into at most one webview push per 500ms. */
  private pushOtelDebounced(): void {
    if (this.otelPushDebounce) { return; }
    this.otelPushDebounce = setTimeout(() => {
      this.otelPushDebounce = undefined;
      this.pushOtel();
    }, 500);
  }

  private pushOtel(): void {
    const snapshot: OtelSnapshot = this.otel.snapshot();
    void this.panel.webview.postMessage({ type: 'otel', snapshot });
  }

  // ── Session Insights ───────────────────────────────────────────────────────

  /** Refresh the session list and, if nothing is selected yet, auto-pick the newest. */
  private async loadSessions(): Promise<void> {
    let sessions: SessionListItem[] = [];
    try {
      sessions = await listSessions(14);
    } catch {
      sessions = [];
    }
    void this.panel.webview.postMessage({ type: 'sessionList', sessions });
    if (!this.selectedPath && sessions.length > 0) {
      void this.selectSession(sessions[0].jsonlPath);
    } else if (this.selectedPath) {
      void this.refreshInsight();
    }
  }

  /** Switch the active session: re-parse, push, and (re)attach the live watcher. */
  private async selectSession(jsonlPath: string): Promise<void> {
    this.selectedPath = jsonlPath;
    this.stopWatch();
    await this.refreshInsight();
    this.startWatch(jsonlPath);
  }

  private async refreshInsight(): Promise<void> {
    const target = this.selectedPath;
    if (!target) { return; }
    if (this.parsing) { return; } // a parse is in flight; the watcher will re-fire
    this.parsing = true;
    void this.panel.webview.postMessage({ type: 'insightLoading', selectedPath: target });
    let insight: SessionInsight | null = null;
    try {
      insight = await parseSession(target);
    } catch {
      insight = null;
    } finally {
      this.parsing = false;
    }
    // Only push if the selection didn't change while parsing.
    if (this.selectedPath === target) {
      void this.panel.webview.postMessage({ type: 'insight', insight, selectedPath: target });
    }
  }

  /** Watch the session jsonl (+ its subagents dir) for live appends. */
  private startWatch(jsonlPath: string): void {
    const debounced = () => {
      if (this.watchDebounce) { clearTimeout(this.watchDebounce); }
      this.watchDebounce = setTimeout(() => { void this.refreshInsight(); }, 500);
    };
    try {
      this.watchers.push(fs.watch(jsonlPath, debounced));
    } catch { /* file may not exist yet — ignore */ }
    // subagents land in a sibling dir; watch it if/when present.
    const subDir = path.join(path.dirname(jsonlPath), path.basename(jsonlPath, '.jsonl'), 'subagents');
    try {
      if (fs.existsSync(subDir)) { this.watchers.push(fs.watch(subDir, debounced)); }
    } catch { /* ignore */ }
  }

  private stopWatch(): void {
    if (this.watchDebounce) { clearTimeout(this.watchDebounce); this.watchDebounce = undefined; }
    for (const w of this.watchers) { try { w.close(); } catch { /* ignore */ } }
    this.watchers = [];
  }

  // ── Token report ─────────────────────────────────────────────────────────

  private async loadReport(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    const cfg = vscode.workspace.getConfiguration('aidlc.tokenMonitor');
    const windowDays = Math.max(1, cfg.get<number>('suggestionWindowDays', 30));
    this.tokenState = { ...this.tokenState, loading: true, error: null, windowDays };
    this.pushTokenState();
    this.loadPromise = (async () => {
      try {
        const records = await loadAllRecords(windowDays);
        this.tokenState = { report: buildReport(records, windowDays), loading: false, error: null, windowDays };
      } catch (e) {
        this.tokenState = { ...this.tokenState, loading: false, error: e instanceof Error ? e.message : String(e) };
      } finally {
        this.pushTokenState();
        this.loadPromise = null;
      }
    })();
    return this.loadPromise;
  }

  private pushTokenState(): void {
    void this.panel.webview.postMessage({ type: 'state', state: this.tokenState });
  }

  // ── Agents-observe status ──────────────────────────────────────────────────

  private startPolling(): void {
    const intervalSec = Math.max(
      5,
      vscode.workspace.getConfiguration('aidlc.monitor').get<number>('pollIntervalSeconds', 10),
    );
    this.pollTimer = setInterval(() => { void this.pollAgents(); this.pushOtel(); }, intervalSec * 1000);
    this.disposables.push({ dispose: () => { if (this.pollTimer) clearInterval(this.pollTimer); } });
  }

  private async pollAgents(): Promise<void> {
    let status: ObserveStatus;
    try {
      status = await fetchObserveStatus();
    } catch (e) {
      status = offlineStatus(e instanceof Error ? e.message : String(e));
    }
    void this.panel.webview.postMessage({
      type: 'agentStatus',
      state: {
        status,
        dashboardUrl: DASHBOARD_URL,
        dataDir: aidlcDataDir(),
      },
    });
  }

  // ── Messages from the webview ──────────────────────────────────────────────

  private async handleMessage(msg: { type: string; [k: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.pushTokenState();
        void this.pollAgents();
        void this.loadSessions();
        this.pushOtel();
        return;
      case 'enableOtel':
        try {
          setTelemetryEnv(true);
          void vscode.window.showInformationMessage(
            'Claude Code telemetry enabled → AIDLC Insights. Restart your Claude Code sessions for it to take effect.',
          );
        } catch (e) {
          void vscode.window.showErrorMessage('Failed to write telemetry env: ' + (e instanceof Error ? e.message : String(e)));
        }
        this.pushOtel();
        return;
      case 'disableOtel':
        try { setTelemetryEnv(false); } catch { /* ignore */ }
        this.pushOtel();
        return;
      case 'refresh':
        void this.loadReport();
        return;
      case 'refreshAgents':
        void this.pollAgents();
        return;
      case 'listSessions':
        void this.loadSessions();
        return;
      case 'selectSession': {
        const p = typeof msg.jsonlPath === 'string' ? msg.jsonlPath : '';
        if (p) { void this.selectSession(p); }
        return;
      }
      case 'openExternal':
        void vscode.env.openExternal(vscode.Uri.parse(DASHBOARD_URL));
        return;
      case 'startMonitor': {
        // Pin agents-observe's `npm install` to the public registry so it never
        // inherits a private CodeArtifact/Artifactory default (whose token may
        // be expired → E401). Set on the terminal so it applies to the whole tree.
        const terminal = vscode.window.createTerminal({
          name: 'AIDLC Monitor',
          env: { npm_config_registry: 'https://registry.npmjs.org/', npm_config_always_auth: 'false' },
        });
        terminal.sendText('aidlc monitor --start');
        terminal.show();
        // The server can take a while to come up (docker pull, or a local
        // npm install + build on first run). Re-probe a few times so the
        // dashboard swaps in as soon as it's reachable.
        for (const delay of [4000, 10000, 20000, 40000]) {
          setTimeout(() => { void this.pollAgents(); }, delay);
        }
        return;
      }
      case 'setTheme': {
        const mode = String(msg.mode ?? '');
        if (mode === 'auto' || mode === 'light' || mode === 'dark') await themeManager.set(mode);
        return;
      }
    }
  }

  private dispose(): void {
    MonitorWebview.current = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.otelPushDebounce) clearTimeout(this.otelPushDebounce);
    this.stopWatch();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private getHtml(): string {
    const nonce = makeNonce();
    const webview = this.panel.webview;
    const cspSource = webview.cspSource;
    const fallback = missingBundleHtml(this.extensionUri.fsPath, 'monitor.js', cspSource, nonce);
    if (fallback) return fallback;

    const initialTheme = themeManager.current;
    const assetsRoot = vscode.Uri.joinPath(this.extensionUri, 'out', 'webviews');
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsRoot, 'styles.css')).toString();
    const entryUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsRoot, 'monitor.js')).toString();
    const frame = `http://localhost:${OBSERVE_PORT} http://127.0.0.1:${OBSERVE_PORT}`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
           img-src ${cspSource} https: data:;
           font-src ${cspSource} https: data:;
           style-src ${cspSource} 'unsafe-inline';
           frame-src ${frame};
           script-src 'nonce-${nonce}' ${cspSource};">
<title>AIDLC Monitor</title>
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}">
window.__AIDLC_INITIAL_STATE__ = ${JSON.stringify(this.tokenState)};
window.__AIDLC_INITIAL_THEME__ = ${JSON.stringify(initialTheme)};
window.__AIDLC_MONITOR_TAB__ = ${JSON.stringify(this.initialTab)};
</script>
<script type="module" nonce="${nonce}" src="${entryUri}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
