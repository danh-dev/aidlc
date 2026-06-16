/**
 * `aidlc.ask` — the extension's "Ask AIDLC" affordance, as a chat webview.
 *
 * Opens a single-instance chat panel where the user can ask what AIDLC does and
 * how to set it up. Each turn shells out to the local `claude` (grounded in the
 * shared AIDLC_KNOWLEDGE reference) and streams the answer back into the panel.
 *
 * Claude-only: it spawns the same `claude` binary the rest of AIDLC uses, so it
 * works as soon as claude is installed + authenticated (verify via `aidlc
 * doctor`). When AIDLC runs inside a Claude Code session, the inherited ephemeral
 * key is stripped (buildClaudeSpawnEnv) so the real login is used.
 */
import * as vscode from 'vscode';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { AIDLC_KNOWLEDGE, buildClaudeSpawnEnv } from '@aidlc/core';

const SUGGESTIONS = [
  'What is AIDLC and how do I get started?',
  'How do I set up the extension on a new project?',
  'What does Start Epic do?',
  'How do I run a pipeline from the Builder?',
];

const ASK_SYSTEM_PROMPT = `You are the AIDLC assistant, embedded in the AIDLC VS Code extension.
The user is chatting with you from inside the editor. Help them understand the
extension and how to set it up: prefer the exact sidebar button, command-palette
command (under the "AIDLC" category), or setting name over abstract description.
When setup is involved, give the concrete next step. Keep answers focused and use
Markdown. Use the reference below as ground truth and never invent commands,
buttons, or settings not listed in it.

${AIDLC_KNOWLEDGE}`;

/**
 * Curated, instant answers for the most common questions — returned without
 * spawning `claude`, so the suggestion chips (and close paraphrases) reply
 * immediately. Matched first by keyword; anything else falls through to claude.
 * Order matters: more specific topics are listed before the general one.
 */
interface QuickAnswer { keywords: string[]; answer: string; }
const QUICK_ANSWERS: QuickAnswer[] = [
  {
    keywords: ['start epic', 'epic'],
    answer: [
      '**Start Epic** kicks off a unit of work:',
      '1. You give a short **brief** of the task.',
      '2. AIDLC classifies it, picks a matching **recipe** (bugfix, small-feature, refactor, …) and assembles a pipeline.',
      '3. The run advances step by step — each step is **awaiting_work / awaiting_review**, with approve / reject / rerun.',
      '',
      'Find it at the top of the **AIDLC** sidebar (**Start Epic**), or run `aidlc epic start <id> --brief "…"` from the CLI.',
    ].join('\n'),
  },
  {
    keywords: ['run a pipeline', 'run pipeline', 'run the pipeline', 'chạy pipeline', 'builder', 'run from'],
    answer: [
      '**Run a pipeline from the Builder:**',
      '1. Open **Open Workspace Builder** → the **Workflows** tab.',
      '2. Pick a pipeline and start a run; the sidebar shows the active run.',
      "3. Each step runs its agent's slash command in the **Claude** terminal — mark it **done**, then **approve** / **reject** to advance.",
      '',
      'CLI equivalent:',
      '```',
      'aidlc run start <pipeline> --context key=value',
      'aidlc run exec <runId>      # streams claude, advances on success',
      '```',
    ].join('\n'),
  },
  {
    keywords: ['set up', 'setup', 'set-up', 'cài đặt', 'cai dat', 'install', 'new project', 'cấu hình'],
    answer: [
      '**Set up AIDLC on a project:**',
      '1. Install the **AIDLC** extension; make sure `claude` is on PATH and authenticated.',
      '2. Open your project folder.',
      '3. In the **AIDLC** sidebar → **Init Sample Workspace** (creates `.aidlc/workspace.yaml`), or apply a **Workflow** template.',
      '4. Use **Open Workspace Builder** to add agents / skills / pipelines visually.',
      '',
      'Verify anytime with `aidlc doctor` (checks workspace, claude binary, and auth).',
    ].join('\n'),
  },
  {
    keywords: ['get started', 'getting started', 'how to start', 'how do i start', 'what is aidlc', 'aidlc là gì', 'aidlc la gi', 'bắt đầu', 'bat dau', 'introduc', 'overview'],
    answer: [
      '**AIDLC** drives Claude through a pipeline you declare in `.aidlc/workspace.yaml` — agents, skills, pipelines, epics and runs — tracking every step and token.',
      '',
      '**Fastest start in VS Code:**',
      '1. Open the **AIDLC** sidebar (activity bar).',
      '2. **Load Demo Project** to explore, or **Init Sample Workspace** on your own folder.',
      '3. Apply a **Workflow** template (`code-review`, `sdlc`, `release-notes`) or hit **Start Epic**.',
      '',
      '**From the CLI:**',
      '```',
      'aidlc init                 # scaffold .aidlc/workspace.yaml',
      'aidlc doctor               # verify claude CLI + auth',
      'aidlc preset apply sdlc    # or code-review / release-notes',
      '```',
      'Prereq: `claude` on PATH + authenticated (claude login / API key / Bedrock / Vertex).',
    ].join('\n'),
  },
];

function matchQuickAnswer(question: string): string | null {
  const n = question.toLowerCase();
  for (const qa of QUICK_ANSWERS) {
    if (qa.keywords.some((k) => n.includes(k))) { return qa.answer; }
  }
  return null;
}

/** One exchange, kept host-side so follow-up questions have conversation context. */
interface Turn { role: 'user' | 'assistant'; text: string; }

export function registerAskCommand(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'aidlc.ask',
    (presetQuestion?: unknown) =>
      AskWebview.show(context.extensionUri, typeof presetQuestion === 'string' ? presetQuestion : undefined),
  );
}

export class AskWebview {
  public static readonly viewType = 'aidlcAsk';
  private static current: AskWebview | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly history: Turn[] = [];
  private proc: ChildProcessWithoutNullStreams | null = null;

  static show(extensionUri: vscode.Uri, presetQuestion?: string): void {
    if (AskWebview.current) {
      AskWebview.current.panel.reveal(vscode.ViewColumn.Beside);
      if (presetQuestion) { AskWebview.current.ask(presetQuestion); }
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      AskWebview.viewType,
      'Ask AIDLC',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] },
    );
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.svg');
    AskWebview.current = new AskWebview(panel, presetQuestion);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly presetQuestion?: string,
  ) {
    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg), null, this.disposables);
  }

  private handleMessage(msg: { type: string; [k: string]: unknown }): void {
    switch (msg.type) {
      case 'ready':
        if (this.presetQuestion) { this.ask(this.presetQuestion); }
        return;
      case 'ask': {
        const q = String(msg.question ?? '').trim();
        if (q) { this.ask(q); }
        return;
      }
      case 'stop':
        this.killProc();
        return;
    }
  }

  /** Run one turn: instant answer if it matches a template, else stream claude. */
  private ask(question: string): void {
    this.killProc(); // one in-flight request at a time
    this.history.push({ role: 'user', text: question });

    // Common questions answer instantly from a curated template — no claude
    // spawn, no waiting. Recorded in history so a follow-up still has context.
    const quick = matchQuickAnswer(question);
    if (quick) {
      this.history.push({ role: 'assistant', text: quick });
      void this.post({ type: 'instant', text: quick });
      return;
    }

    void this.post({ type: 'start' });

    const prompt = this.buildPrompt(question);
    const args = [
      '--print', '--output-format', 'stream-json', '--verbose',
      '--append-system-prompt', ASK_SYSTEM_PROMPT, prompt,
    ];
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('claude', args, { cwd, env: buildClaudeSpawnEnv() });
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
      return;
    }
    this.proc = child;

    let buf = '';
    let answer = '';
    let stderr = '';

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) { return; }
      let evt: StreamEvent;
      try { evt = JSON.parse(trimmed) as StreamEvent; } catch { return; }
      if (evt.type === 'assistant' && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            answer += block.text;
            void this.post({ type: 'chunk', text: block.text });
          }
        }
      } else if (evt.type === 'result' && typeof evt.result === 'string' && !answer) {
        // Some runs only carry the final text in the result event.
        answer = evt.result;
        void this.post({ type: 'chunk', text: evt.result });
      }
    };

    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });

    child.on('error', (err) => {
      if (this.proc !== child) { return; }
      this.proc = null;
      const code = (err as NodeJS.ErrnoException).code;
      this.fail(code === 'ENOENT'
        ? 'claude CLI not found on PATH (install: https://github.com/anthropics/claude-code)'
        : err.message);
    });

    child.on('close', (code) => {
      if (this.proc !== child) { return; } // superseded/killed
      this.proc = null;
      if (buf.trim()) { handleLine(buf); }
      const text = answer.trim();
      if (code === 0 && text) {
        this.history.push({ role: 'assistant', text });
        void this.post({ type: 'done' });
      } else if (!text) {
        this.fail(stderr.trim() || `claude exited ${code} with no output — try \`aidlc doctor\`.`);
      } else {
        // Non-zero exit but we did stream something — keep it, just close out.
        this.history.push({ role: 'assistant', text });
        void this.post({ type: 'done' });
      }
    });
  }

  /** Prior turns + the new question, so follow-ups have context (bounded). */
  private buildPrompt(question: string): string {
    const prior = this.history.slice(-7, -1); // last few turns, excluding the just-pushed question
    if (prior.length === 0) { return question; }
    const transcript = prior
      .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
      .join('\n\n');
    return `Conversation so far:\n${transcript}\n\nUser: ${question}`;
  }

  private fail(message: string): void {
    void this.post({ type: 'error', message });
  }

  private post(msg: Record<string, unknown>): Thenable<boolean> {
    return this.panel.webview.postMessage(msg);
  }

  private killProc(): void {
    if (this.proc) { this.proc.kill('SIGKILL'); this.proc = null; }
  }

  private dispose(): void {
    AskWebview.current = undefined;
    this.killProc();
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
  }

  private getHtml(): string {
    const nonce = makeNonce();
    const cspSource = this.panel.webview.cspSource;
    const suggestions = JSON.stringify(SUGGESTIONS);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src ${cspSource} https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ask AIDLC</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; height: 100vh; display: flex; flex-direction: column;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground); background: var(--vscode-editor-background);
  }
  header {
    display: flex; align-items: center; gap: 8px; padding: 10px 14px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
    font-weight: 600;
  }
  header .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-charts-green, #3fb950); }
  header .sub { font-weight: 400; opacity: .6; font-size: .85em; }
  #log { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; }
  .msg { display: flex; flex-direction: column; max-width: 92%; }
  .msg.user { align-self: flex-end; align-items: flex-end; }
  .msg.assistant { align-self: flex-start; align-items: flex-start; }
  .bubble {
    padding: 8px 12px; border-radius: 12px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word;
  }
  .msg.user .bubble {
    background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff);
    border-bottom-right-radius: 4px;
  }
  .msg.assistant .bubble {
    background: var(--vscode-input-background, rgba(128,128,128,.12)); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
    border-bottom-left-radius: 4px;
  }
  .bubble code {
    font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.2)); padding: 1px 5px; border-radius: 4px; font-size: .92em;
  }
  .bubble pre {
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.18)); padding: 10px 12px; border-radius: 8px;
    overflow-x: auto; margin: 8px 0;
  }
  .bubble pre code { background: none; padding: 0; }
  .role { font-size: .72em; text-transform: uppercase; letter-spacing: .08em; opacity: .55; margin: 0 4px 3px; }
  .typing .bubble::after { content: '▍'; animation: blink 1s step-start infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .think { display: inline-flex; align-items: center; gap: 8px; opacity: .8; }
  .think .spinner {
    width: 12px; height: 12px; border-radius: 50%;
    border: 2px solid var(--vscode-panel-border, rgba(128,128,128,.4));
    border-top-color: var(--vscode-charts-green, #3fb950); animation: spin .8s linear infinite;
  }
  .think .label { animation: pulse 1.4s ease-in-out infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse { 0%,100% { opacity: .45; } 50% { opacity: .95; } }
  .empty { margin: auto; text-align: center; opacity: .7; max-width: 360px; }
  .empty h2 { font-size: 1.05em; margin: 0 0 6px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; margin-top: 12px; }
  .chip {
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); background: transparent; color: inherit;
    padding: 5px 10px; border-radius: 14px; cursor: pointer; font: inherit; font-size: .88em;
  }
  .chip:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.15)); }
  .err { color: var(--vscode-errorForeground, #f14c4c); align-self: center; font-size: .9em; }
  footer { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); padding: 10px 12px; }
  .inputrow { display: flex; gap: 8px; align-items: flex-end; }
  textarea {
    flex: 1; resize: none; max-height: 140px; min-height: 36px; padding: 8px 10px; border-radius: 8px;
    font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,.4)));
  }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }
  button.send {
    border: none; cursor: pointer; padding: 8px 14px; border-radius: 8px; font: inherit; font-weight: 600;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); height: 36px;
  }
  button.send:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
  button.send:disabled { opacity: .5; cursor: default; }
  .hint { opacity: .5; font-size: .78em; margin-top: 6px; }
</style>
</head>
<body>
<header><span class="dot"></span> Ask AIDLC <span class="sub">· powered by your local Claude</span></header>
<div id="log"></div>
<footer>
  <div class="inputrow">
    <textarea id="q" rows="1" placeholder="Ask about AIDLC — setup, concepts, which command to use…"></textarea>
    <button class="send" id="send">Send</button>
  </div>
  <div class="hint">Enter to send · Shift+Enter for newline</div>
</footer>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const SUGGESTIONS = ${suggestions};
  const log = document.getElementById('log');
  const ta = document.getElementById('q');
  const send = document.getElementById('send');
  let busy = false, curBubble = null;

  function escapeHtml(s){return s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
  // Minimal, safe markdown: code fences, inline code, **bold**. Everything escaped first.
  function renderMd(s){
    const parts = s.split(/(\`\`\`[\\s\\S]*?\`\`\`)/g);
    return parts.map(p=>{
      if(p.startsWith('\`\`\`')){
        const body = p.replace(/^\`\`\`[^\\n]*\\n?/, '').replace(/\`\`\`$/, '');
        return '<pre><code>'+escapeHtml(body)+'</code></pre>';
      }
      let h = escapeHtml(p);
      h = h.replace(/\`([^\`]+)\`/g,'<code>$1</code>');
      h = h.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>');
      return h;
    }).join('');
  }
  function clearEmpty(){ const e=log.querySelector('.empty'); if(e) e.remove(); }
  function addMsg(role){
    clearEmpty();
    const wrap=document.createElement('div'); wrap.className='msg '+role;
    const r=document.createElement('div'); r.className='role'; r.textContent=role==='user'?'You':'AIDLC';
    const b=document.createElement('div'); b.className='bubble';
    wrap.appendChild(r); wrap.appendChild(b); log.appendChild(wrap);
    log.scrollTop=log.scrollHeight; return {wrap,b};
  }
  function renderEmpty(){
    log.innerHTML='';
    const d=document.createElement('div'); d.className='empty';
    d.innerHTML='<h2>👋 Ask AIDLC anything</h2><div>What it does, how to set it up, which command to use.</div>';
    const chips=document.createElement('div'); chips.className='chips';
    SUGGESTIONS.forEach(s=>{const c=document.createElement('button');c.className='chip';c.textContent=s;c.onclick=()=>submit(s);chips.appendChild(c);});
    d.appendChild(chips); log.appendChild(d);
  }
  function setBusy(v){ busy=v; send.textContent=v?'Stop':'Send'; ta.disabled=false; }
  function submit(text){
    const q=(text!=null?text:ta.value).trim();
    if(busy){ vscode.postMessage({type:'stop'}); return; }
    if(!q) return;
    addMsg('user').b.textContent=q;
    ta.value=''; ta.style.height='auto';
    setBusy(true);
    vscode.postMessage({type:'ask', question:q});
  }
  send.addEventListener('click',()=>submit());
  ta.addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submit();} });
  ta.addEventListener('input',()=>{ ta.style.height='auto'; ta.style.height=Math.min(ta.scrollHeight,140)+'px'; });

  const THINKING=['Thinking…','Searching the AIDLC docs…','Preparing your answer…'];
  function stopThinking(){ if(curBubble&&curBubble.timer){clearInterval(curBubble.timer);curBubble.timer=null;} }
  window.addEventListener('message',ev=>{
    const m=ev.data;
    if(m.type==='start'){
      const {wrap,b}=addMsg('assistant'); curBubble={wrap,b,raw:'',started:false,timer:null};
      let i=0;
      b.innerHTML='<span class="think"><span class="spinner"></span><span class="label">'+THINKING[0]+'</span></span>';
      curBubble.timer=setInterval(()=>{ i=(i+1)%THINKING.length; const el=b.querySelector('.think .label'); if(el) el.textContent=THINKING[i]; },1800);
    }
    else if(m.type==='chunk'&&curBubble){
      if(!curBubble.started){ curBubble.started=true; stopThinking(); curBubble.wrap.classList.add('typing'); curBubble.b.innerHTML=''; }
      curBubble.raw+=m.text; curBubble.b.innerHTML=renderMd(curBubble.raw); log.scrollTop=log.scrollHeight;
    }
    else if(m.type==='done'){ stopThinking(); if(curBubble){curBubble.wrap.classList.remove('typing');curBubble=null;} setBusy(false); ta.focus(); }
    else if(m.type==='instant'){ const {b}=addMsg('assistant'); b.innerHTML=renderMd(m.text); log.scrollTop=log.scrollHeight; setBusy(false); ta.focus(); }
    else if(m.type==='error'){
      stopThinking();
      if(curBubble){ curBubble.wrap.remove(); curBubble=null; }
      const e=document.createElement('div'); e.className='err'; e.textContent='⚠ '+m.message; log.appendChild(e);
      log.scrollTop=log.scrollHeight; setBusy(false);
    }
  });

  renderEmpty();
  ta.focus();
  vscode.postMessage({type:'ready'});
</script>
</body>
</html>`;
  }
}

/** Shape of the claude `--output-format stream-json` NDJSON events we read. */
interface StreamEvent {
  type: string;
  message?: { content?: Array<{ type: string; text?: string }> };
  result?: string;
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) { out += chars[Math.floor(Math.random() * chars.length)]; }
  return out;
}
