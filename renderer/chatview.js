'use strict';

// ChatView renders a ChatGPT-style conversation: user bubbles, streaming
// assistant messages with markdown, collapsible thinking, and tool-use cards.
// It is UI-only — the host wires sending/interrupting via callbacks.

const MarkdownIt = require('markdown-it');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
// Syntax highlighting is optional — the chat still renders without it.
let hljs = null;
try { hljs = require('highlight.js/lib/common'); } catch (_) { hljs = null; }
const { clipboard, webUtils } = require('electron');
const { MicRecorder, Speaker, cleanTranscript } = require('./voice.js');

const MIC_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/>' +
  '<path d="M5 10v1a7 7 0 0 0 14 0v-1"/><path d="M12 18v4"/></svg>';

function copyToClipboard(text) {
  try { clipboard.writeText(String(text == null ? '' : text)); return true; }
  catch (_) { return false; }
}

// Shown immediately so the picker is usable before the (sometimes slow) session
// init arrives. The live model from init is highlighted via setActiveModel(),
// and the full list from the SDK replaces these once supportedModels() returns.
const DEFAULT_MODELS = [
  { value: '', displayName: 'Default (recommended)', description: 'Use the CLI default model' },
  { value: 'opus', displayName: 'Claude Opus — most capable', description: 'opus' },
  { value: 'sonnet', displayName: 'Claude Sonnet — balanced', description: 'sonnet' },
  { value: 'sonnet[1m]', displayName: 'Claude Sonnet — 1M context', description: 'sonnet[1m]' },
  { value: 'haiku', displayName: 'Claude Haiku — fastest', description: 'haiku' },
];

// Returns highlighted HTML for a code string. hljs escapes its input, so the
// result is safe to inject; on any failure we return '' and markdown-it falls
// back to its own escaping.
function highlightCode(code, lang) {
  if (!hljs || !code || code.length > 60000) return '';
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    }
  } catch (_) { /* fall through */ }
  return '';
}

const md = new MarkdownIt({
  html: false, // raw HTML in model output is escaped, not rendered
  linkify: true,
  breaks: true,
  highlight: highlightCode,
});

// Remember the language of each fenced block so the copy bar can label it.
const defaultFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const lang = (tokens[idx].info || '').trim().split(/\s+/)[0];
  const html = defaultFence(tokens, idx, options, env, self);
  return lang ? html.replace(/^<pre/, '<pre data-lang="' + esc(lang) + '"') : html;
};

// Image formats the Anthropic API accepts as base64 blocks; PDFs go inline as
// document blocks; anything else is attached as a path reference Claude opens
// with its own tools.
const IMAGE_MEDIA_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // API limit per image
// Every page costs ~1.5-3k tokens and stays in the conversation, and a PDF the
// API rejects fails every later turn too — so only PDFs known to be small go
// inline. Bigger ones (or ones we can't count) go by path; Claude's Read tool
// opens them a few pages at a time.
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_PDF_PAGES = 30;

/** Page count without a PDF library: the larger of the page-tree /Count and
 *  the number of /Type /Page objects, looking inside compressed object
 *  streams (PDF 1.5+) too. Rewritten objects can make it overcount, never
 *  under. 0 = couldn't tell. */
function pdfPageCount(buf) {
  const raw = buf.toString('latin1');
  if (!raw.startsWith('%PDF')) return 0;
  const texts = [raw];
  const streamRe = />>\s*stream\r?\n/g;
  let m;
  while ((m = streamRe.exec(raw))) {
    const dict = raw.slice(Math.max(0, m.index - 600), m.index);
    if (!/\/ObjStm/.test(dict.slice(dict.lastIndexOf(' obj') + 1))) continue;
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    try {
      texts.push(zlib.inflateSync(buf.subarray(start, end),
        { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('latin1'));
    } catch (_) { /* not Flate — skip */ }
  }
  let objects = 0;
  let tree = 0;
  for (const t of texts) {
    objects += (t.match(/\/Type\s*\/Page(?![A-Za-z])/g) || []).length;
    const pagesRe = /\/Type\s*\/Pages\b/g;
    let p;
    while ((p = pagesRe.exec(t))) {
      const near = t.slice(Math.max(0, p.index - 400), p.index + 400).match(/\/Count\s+(\d+)/g) || [];
      for (const c of near) tree = Math.max(tree, Number(c.replace(/\D/g, '')));
    }
  }
  return Math.max(objects, tree);
}

function isPdf(name, type) {
  return type === 'application/pdf' || /\.pdf$/i.test(String(name || ''));
}

/** A PDF small enough to send inline, or null (then it goes by path). */
function pdfAttachment(name, buf, filePath) {
  const pages = buf.length <= MAX_PDF_BYTES ? pdfPageCount(buf) : 0;
  if (!pages || pages > MAX_PDF_PAGES) return { pages, inline: null };
  return {
    pages,
    inline: {
      kind: 'pdf', name, path: filePath || '', pages,
      mediaType: 'application/pdf', base64: buf.toString('base64'),
    },
  };
}

function pagesLabel(n) {
  return n + (n === 1 ? ' page' : ' pages');
}

// Pasted or dragged-in data with no file on disk is parked in the temp dir so
// Claude can open it by path like any other attachment.
function saveTempAttachment(name, buf) {
  const dir = path.join(os.tmpdir(), 'ccs-attachments',
    Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(String(name || ''));
  const full = path.join(dir, base && !/^\.*$/.test(base) ? base : 'pasted-file');
  fs.writeFileSync(full, buf);
  return full;
}

const EFFORT_LABELS = {
  '': 'Effort: default', low: 'Effort: low', medium: 'Effort: medium',
  high: 'Effort: high', xhigh: 'Effort: xhigh', max: 'Effort: max',
};

// Auto model: a quick local read of each message decides how much model it
// needs — no extra API call. Opus for design, debugging and big asks; Haiku
// for short questions that touch no code; Sonnet for everything in between.
const HEAVY_WORK = new RegExp('\\b(architect\\w*|design\\w*|refactor\\w*|debug\\w*|investigat\\w*|' +
  'root cause|why (is|does|did|do|isn\'t|doesn\'t|won\'t)|race condition|memory leak|deadlock|' +
  'migrat\\w*|optimi[sz]\\w*|performance|secur\\w*|vulnerab\\w*|audit|review\\w*|plan|strategy|' +
  'trade-?offs?|from scratch|end-to-end|entire|whole (app|codebase|project|repo)|complex|tricky)\\b', 'i');
const CODE_WORK = /\b(bug|error|fix\w*|wrong|fail\w*|crash\w*|broken|implement\w*|add|write|create|build|test\w*|update|change|edit)\b/i;
const LIGHT_WORK = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|continue|go on|next)\b|\b(typo|rename|what is|what's|define|translate|summari[sz]e|format|spell|list|show me|version)\b/i;
const MODEL_LABELS = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };

/** → { model, why } for the message about to be sent, or null to leave the
 *  model alone (slash commands run on whatever is selected). */
function pickModelForTask(text, atts, mode) {
  const t = String(text || '').trim();
  const n = (atts || []).length;
  if (t.startsWith('/')) return null;
  if (mode === 'plan') return { model: 'opus', why: 'planning' };
  if (mode === 'auto') return { model: 'opus', why: 'Auto mode needs Opus' };
  if (t.length > 1200 || n > 2 || HEAVY_WORK.test(t)) return { model: 'opus', why: 'complex task' };
  if (t.length < 120 && !n && LIGHT_WORK.test(t) && !CODE_WORK.test(t)) {
    return { model: 'haiku', why: 'quick question' };
  }
  return { model: 'sonnet', why: 'everyday task' };
}

// "claude-opus-4-7[1m]" -> "Opus 4.7 (1M)"; "claude-sonnet-4-6" -> "Sonnet 4.6"
function prettyModel(id) {
  if (!id) return 'Default';
  let m = id;
  const onem = /\[1m\]/i.test(m);
  m = m.replace(/\[1m\]/i, '');
  const match = m.match(/(opus|sonnet|haiku)-?(\d+)?-?(\d+)?/i);
  if (match) {
    const name = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    const ver = [match[2], match[3]].filter(Boolean).join('.');
    return name + (ver ? ' ' + ver : '') + (onem ? ' (1M)' : '');
  }
  return id;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[c]));
}

function toolSummary(name, input) {
  input = input || {};
  switch (name) {
    case 'Bash':
      return { label: 'Ran a command', detail: input.command || '' };
    case 'Edit':
    case 'MultiEdit':
      return { label: 'Edited a file', detail: input.file_path || '' };
    case 'Write':
      return { label: 'Wrote a file', detail: input.file_path || '' };
    case 'Read':
      return { label: 'Read a file', detail: input.file_path || '' };
    case 'NotebookEdit':
      return { label: 'Edited a notebook', detail: input.notebook_path || '' };
    case 'Glob':
      return { label: 'Searched for files', detail: input.pattern || '' };
    case 'Grep':
      return { label: 'Searched in code', detail: input.pattern || '' };
    case 'WebFetch':
      return { label: 'Fetched a web page', detail: input.url || '' };
    case 'WebSearch':
      return { label: 'Searched the web', detail: input.query || '' };
    case 'Task':
    case 'Agent':
      return { label: 'Ran a sub-agent', detail: input.description || '' };
    case 'TodoWrite':
      return { label: 'Updated the task list', detail: '' };
    case 'AskUserQuestion':
      return {
        label: 'Asked you a question',
        detail: (((input.questions || [])[0] || {}).question) || '',
      };
    case 'ExitPlanMode':
      return { label: 'Proposed a plan', detail: '' };
    case 'KillShell':
      return { label: 'Stopped a command', detail: '' };
    default:
      return { label: name || 'Tool', detail: '' };
  }
}

// Files the Artifacts panel can render locally, by extension.
const ARTIFACT_KINDS = {
  html: 'html', htm: 'html', svg: 'svg', md: 'markdown', markdown: 'markdown',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
};
function artifactKind(filePath) {
  const ext = (String(filePath || '').match(/\.([a-z0-9]+)$/i) || [])[1];
  return ARTIFACT_KINDS[(ext || '').toLowerCase()] || null;
}

// What the status line says while a tool is running.
function activityLabel(name) {
  switch (name) {
    case 'Bash': return 'Running a command…';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': return 'Editing a file…';
    case 'Write': return 'Writing a file…';
    case 'Read': return 'Reading a file…';
    case 'Glob': return 'Looking for files…';
    case 'Grep': return 'Searching the code…';
    case 'WebFetch': return 'Fetching a web page…';
    case 'WebSearch': return 'Searching the web…';
    case 'Task':
    case 'Agent': return 'Running a sub-agent…';
    case 'TodoWrite': return 'Updating the task list…';
    case 'AskUserQuestion': return 'Waiting for your answer…';
    case 'ExitPlanMode': return 'Waiting for your go-ahead…';
    default: return 'Working…';
  }
}

/** Readable "Input" section for a tool card — a command line for Bash, tidy
 *  key/value rows for flat inputs, JSON only as the last resort. */
function inputSectionHtml(name, input) {
  const wrap = (inner) => '<div class="tool-section"><div class="tool-section-h">Input</div>' + inner + '</div>';
  if (!input || typeof input !== 'object') {
    return wrap('<pre>' + esc(String(input == null ? '' : input)) + '</pre>');
  }
  if (name === 'Bash' && typeof input.command === 'string') {
    return '<div class="tool-section">' +
      (input.description ? '<div class="tool-section-h">' + esc(input.description) + '</div>' : '') +
      '<pre class="tool-cmd"><span class="tool-cmd-ps">$</span> ' + esc(input.command) + '</pre></div>';
  }
  const keys = Object.keys(input);
  const flat = keys.length > 0 && keys.length <= 8 && keys.every((k) => {
    const v = input[k];
    return v == null || ['string', 'number', 'boolean'].includes(typeof v);
  });
  if (flat && !keys.some((k) => typeof input[k] === 'string' && input[k].length > 400)) {
    let rows = '';
    for (const k of keys) {
      rows += '<div class="tool-kv"><span class="tool-k">' + esc(k) + '</span>' +
        '<span class="tool-v">' + esc(String(input[k])) + '</span></div>';
    }
    return wrap('<div class="tool-kvs">' + rows + '</div>');
  }
  return wrap('<pre>' + esc(JSON.stringify(input, null, 2)) + '</pre>');
}

// Line-level LCS diff → array of { type: 'ctx'|'add'|'del', text }.
function diffLines(oldStr, newStr) {
  const a = String(oldStr == null ? '' : oldStr).split('\n');
  const b = String(newStr == null ? '' : newStr).split('\n');
  const n = a.length;
  const m = b.length;
  // LCS table (guarded against pathologically large inputs).
  if (n * m > 4_000_000) {
    return [
      ...a.map((t) => ({ type: 'del', text: t })),
      ...b.map((t) => ({ type: 'add', text: t })),
    ];
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'ctx', text: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i++] });
    } else {
      out.push({ type: 'add', text: b[j++] });
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
}

// Collapse long runs of unchanged context to keep diffs readable.
function collapseContext(rows, pad = 3) {
  const keep = new Array(rows.length).fill(false);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type !== 'ctx') {
      for (let k = Math.max(0, i - pad); k <= Math.min(rows.length - 1, i + pad); k++) keep[k] = true;
    }
  }
  const out = [];
  let hidden = 0;
  for (let i = 0; i < rows.length; i++) {
    if (keep[i]) {
      if (hidden) { out.push({ type: 'gap', text: '⋯ ' + hidden + ' unchanged line' + (hidden === 1 ? '' : 's') }); hidden = 0; }
      out.push(rows[i]);
    } else {
      hidden++;
    }
  }
  if (hidden) out.push({ type: 'gap', text: '⋯ ' + hidden + ' unchanged line' + (hidden === 1 ? '' : 's') });
  return out;
}

function renderDiffHtml(oldStr, newStr) {
  const rows = collapseContext(diffLines(oldStr, newStr));
  const sign = { add: '+', del: '-', ctx: ' ', gap: '' };
  let added = 0;
  let removed = 0;
  let body = '';
  for (const r of rows) {
    if (r.type === 'add') added++;
    if (r.type === 'del') removed++;
    if (r.type === 'gap') {
      body += '<div class="diff-gap">' + esc(r.text) + '</div>';
    } else {
      body += '<div class="diff-line ' + r.type + '"><span class="diff-sign">' +
        sign[r.type] + '</span>' + esc(r.text || ' ') + '</div>';
    }
  }
  const stat = '<span class="diff-add">+' + added + '</span> <span class="diff-del">−' + removed + '</span>';
  return { html: '<div class="diff">' + body + '</div>', stat };
}

/** Plain-language title/description for a tool permission prompt. */
function permFriendly(toolName) {
  switch (toolName) {
    case 'Bash':
      return { title: 'Run a command?', desc: 'Claude wants to run this command on your computer.' };
    case 'Write':
      return { title: 'Create or overwrite a file?', desc: 'Claude wants to write this file.' };
    case 'Edit':
    case 'MultiEdit':
      return { title: 'Edit a file?', desc: 'Claude wants to make changes to this file.' };
    case 'NotebookEdit':
      return { title: 'Edit a notebook?', desc: 'Claude wants to change this notebook.' };
    case 'WebFetch':
      return { title: 'Fetch a web page?', desc: 'Claude wants to download content from this URL.' };
    case 'WebSearch':
      return { title: 'Search the web?', desc: 'Claude wants to run this web search.' };
    case 'Task':
    case 'Agent':
      return { title: 'Run a sub-agent?', desc: 'Claude wants to start a background agent for this task.' };
    case 'KillShell':
      return { title: 'Stop a running command?', desc: 'Claude wants to stop a background command.' };
    default:
      return {
        title: 'Allow this action?',
        desc: 'Claude wants to use the ' + (toolName || 'unknown') + ' tool.',
      };
  }
}

/** The most useful single piece of a tool input to show in a prompt. */
function permInputText(req) {
  const i = (req && req.input) || {};
  if (req && req.toolName === 'Bash' && i.command) return i.command;
  if (i.file_path) return i.file_path;
  if (i.url) return i.url;
  if (i.command) return i.command;
  if (i.query) return i.query;
  try {
    const j = JSON.stringify(i, null, 2);
    return j === '{}' ? '' : j.slice(0, 1400);
  } catch (_) {
    return '';
  }
}

/** Turn a saved AskUserQuestion result into "question → answer" rows. */
function answersHtml(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    return '';
  }
  const answers = data && data.answers;
  if (!answers || typeof answers !== 'object') return '';
  let html = '';
  for (const q of Object.keys(answers)) {
    html +=
      '<div class="ask-answered"><span class="ask-answered-ico">✓</span>' +
      '<span class="ask-answered-q">' + esc(q) + '</span>' +
      '<span class="ask-answered-a">' + esc(answers[q]) + '</span></div>';
  }
  return html ? '<div class="tool-section">' + html + '</div>' : '';
}

/** Render a TodoWrite task list as a checklist. */
function todoListHtml(todos) {
  let done = 0;
  let active = '';
  let body = '';
  for (const t of todos) {
    const status = t && t.status === 'completed' ? 'completed'
      : t && t.status === 'in_progress' ? 'in_progress' : 'pending';
    if (status === 'completed') done++;
    const icon = status === 'completed' ? '✓' : status === 'in_progress' ? '▸' : '○';
    const text = status === 'in_progress' && t.activeForm ? t.activeForm : (t && t.content) || '';
    if (status === 'in_progress' && !active) active = text;
    body += '<div class="todo-row ' + status + '">' +
      '<span class="todo-ico">' + icon + '</span>' +
      '<span class="todo-text">' + esc(text) + '</span></div>';
  }
  return {
    html: '<div class="todo-list">' + body + '</div>',
    done,
    total: todos.length,
    active,
  };
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

class ChatView {
  /**
   * @param {HTMLElement} container
   * @param {{onSend:Function,onInterrupt:Function,onOpenLink:Function,
   *          onPickFiles:Function,onSetModel:Function}} opts
   */
  constructor(container, opts) {
    this.opts = opts || {};
    this.busy = false;
    this.streaming = null; // current assistant message being built
    this.typingEl = null;
    this.toolCards = new Map(); // tool_use_id -> { card, body }
    this.meta = { model: '', models: [], skills: [], tools: [], mcp: [] };

    container.classList.add('chat-view');
    container.innerHTML =
      '<div class="chat-scroll">' +
      '  <div class="chat-empty">' +
      '    <div class="chat-empty-mark">✳</div>' +
      '    <div class="chat-empty-title">How can I help?</div>' +
      '    <div class="chat-empty-sub">Ask a question, or describe something you want done.</div>' +
      '    <div class="chat-starters">' +
      '      <button data-p="Build a polished landing page for ">🎨 Design a page</button>' +
      '      <button data-p="Give me a tour of this project: what it does, how it is organised, and where to start.">🧭 Explain this project</button>' +
      '      <button data-p="Find and fix the bug where ">🐞 Fix a bug</button>' +
      '      <button data-p="Draw an SVG diagram of ">📐 Make a diagram</button>' +
      '    </div>' +
      '  </div>' +
      '</div>' +
      '<button class="jump-bottom" title="Jump to latest" style="display:none">↓</button>' +
      '<div class="prompt-dock" style="display:none"></div>' +
      '<div class="composer">' +
      '  <div class="activity" style="display:none">' +
      '    <span class="activity-spin">✳</span>' +
      '    <span class="activity-text">Working…</span>' +
      '    <span class="activity-time"></span>' +
      '    <span class="activity-esc">Esc to stop</span>' +
      '  </div>' +
      '  <div class="composer-queue" style="display:none"></div>' +
      '  <div class="voice-status" style="display:none"></div>' +
      '  <div class="composer-toolbar">' +
      '    <label class="cc-model" title="Model in use">' +
      '      <span class="cc-model-dot"></span>' +
      '      <select class="cc-model-select"><option value="">default model</option></select>' +
      '    </label>' +
      '    <button class="cc-tool-btn cc-auto-model" title="Auto model: pick Haiku, Sonnet or Opus for each message based on the task">✦ Auto model</button>' +
      '    <label class="cc-mode" title="How Claude asks before editing files or running commands">' +
      '      <span class="cc-mode-dot"></span>' +
      '      <select class="cc-mode-select">' +
      '        <option value="default" title="Ask before each edit or command">Manual</option>' +
      '        <option value="acceptEdits" title="File edits apply without asking; commands still ask">Accept edits</option>' +
      '        <option value="plan" title="Propose a plan without changing files">Plan</option>' +
      '        <option value="auto" title="A safety check approves or blocks each action (supported models only)">Auto</option>' +
      '        <option value="bypassPermissions" title="Run every tool without asking">Bypass</option>' +
      '      </select>' +
      '    </label>' +
      '    <label class="cc-effort" title="How hard Claude thinks before answering">' +
      '      <span class="cc-effort-dot"></span>' +
      '      <select class="cc-effort-select">' +
      Object.keys(EFFORT_LABELS).map((k) => '<option value="' + k + '">' + EFFORT_LABELS[k] + '</option>').join('') +
      '      </select>' +
      '    </label>' +
      '    <button class="cc-tool-btn cc-skills-btn" title="Skills & slash commands">⚡ Skills</button>' +
      '    <button class="cc-tool-btn cc-files-btn" title="Attach a file">📎 File</button>' +
      '    <button class="cc-tool-btn cc-caps-btn" title="Available tools & capabilities">ⓘ Capabilities</button>' +
      '    <span class="cc-usage" title="Tokens and estimated cost this session" style="display:none"></span>' +
      '    <span class="cc-ctx" style="display:none"><span class="cc-ctx-bar"><span class="cc-ctx-fill"></span></span><span class="cc-ctx-text"></span></span>' +
      '    <div class="cc-popover" style="display:none"></div>' +
      '  </div>' +
      '  <div class="cc-ac" style="display:none"></div>' +
      '  <div class="composer-attach" style="display:none"></div>' +
      '  <div class="composer-inner">' +
      '    <textarea class="composer-input" rows="1" placeholder="Message Claude…"></textarea>' +
      '    <button class="composer-mic" title="Talk to Claude (Ctrl+M)">' + MIC_ICON + '</button>' +
      '    <button class="composer-btn" title="Send">▲</button>' +
      '  </div>' +
      '  <div class="composer-hint">Enter to send · Shift+Enter new line · / commands · @ files · Shift+Tab mode · Ctrl+M talk</div>' +
      '</div>';

    this.container = container;
    this.scrollEl = container.querySelector('.chat-scroll');
    this.dockEl = container.querySelector('.prompt-dock');
    this.activityEl = container.querySelector('.activity');
    this.activityText = container.querySelector('.activity-text');
    this.activityTime = container.querySelector('.activity-time');
    this.queueEl = container.querySelector('.composer-queue');
    this.ctxEl = container.querySelector('.cc-ctx');
    this.queued = []; // messages typed while Claude is busy; sent one per turn
    this.micBtn = container.querySelector('.composer-mic');
    this.voiceStatusEl = container.querySelector('.voice-status');
    this.mic = null; // MicRecorder while listening
    this.micBusy = false; // transcribing the last take
    this.voiceDraft = false; // composer text came from the mic (review-first mode)
    this.speakTurn = false; // read this turn's reply aloud
    this.speaker = new Speaker({
      prefs: () => this._voicePrefs(),
      onChange: (speaking) => this._reflectSpeaking(speaking),
    });
    this.sentHistory = []; // for ↑ recall
    this.sentIdx = -1;
    this.subSteps = new Map(); // sub-agent tool_use_id -> row element
    this.artifacts = []; // previewable files written in this chat
    this.context = { tokens: 0, window: 0 };
    this.emptyEl = container.querySelector('.chat-empty');
    this.jumpBtn = container.querySelector('.jump-bottom');
    this.jumpBtn.addEventListener('click', () => {
      this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
      this._updateJump();
    });
    this.scrollEl.addEventListener('scroll', () => this._updateJump());
    container.querySelectorAll('.chat-starters button').forEach((b) => {
      b.addEventListener('click', () => {
        this.input.value = b.dataset.p;
        this._growInput();
        this.input.focus();
      });
    });
    this.input = container.querySelector('.composer-input');
    this.sendBtn = container.querySelector('.composer-btn');
    this.modelSelect = container.querySelector('.cc-model-select');
    this.modeSelect = container.querySelector('.cc-mode-select');
    this.effortSelect = container.querySelector('.cc-effort-select');
    this.autoModelBtn = container.querySelector('.cc-auto-model');
    this.autoModel = false;
    this.skillsBtn = container.querySelector('.cc-skills-btn');
    this.filesBtn = container.querySelector('.cc-files-btn');
    this.capsBtn = container.querySelector('.cc-caps-btn');
    this.acEl = container.querySelector('.cc-ac');
    this.attachEl = container.querySelector('.composer-attach');
    this.attachments = [];
    this.ac = { open: false, items: [], active: 0, kind: '', start: 0, end: 0, token: '' };
    this.usageEl = container.querySelector('.cc-usage');
    this.popover = container.querySelector('.cc-popover');
    this.usage = { costUsd: 0, inTokens: 0, outTokens: 0, cacheReadTokens: 0, turns: 0 };

    this.modelSelect.addEventListener('change', () => {
      // Picking a model by hand overrides Auto model.
      if (this.autoModel) this._toggleAutoModel(false);
      this._setModeAvailable('auto', true); // availability depends on the model
      if (this.opts.onSetModel) this.opts.onSetModel(this.modelSelect.value);
      this._hidePopover();
    });
    this.autoModelBtn.addEventListener('click', () => this._toggleAutoModel(!this.autoModel));
    this.modeSelect.addEventListener('change', async () => {
      const mode = this.modeSelect.value;
      const prev = this.meta.permissionMode;
      this._hidePopover();
      const r = this.opts.onSetPermissionMode ? await this.opts.onSetPermissionMode(mode) : null;
      if (r && r.rejected) {
        // e.g. Auto mode on a model that doesn't support it — stay put, and
        // keep Shift+Tab from landing on it again.
        this.modeSelect.value = prev;
        this._setModeAvailable(mode, false);
        this._addNotice('Could not switch mode: ' + r.error, true);
        return;
      }
      this._reflectMode(mode);
    });
    this.effortSelect.addEventListener('change', async () => {
      const effort = this.effortSelect.value;
      const prev = this.meta.effort || '';
      this._hidePopover();
      const r = this.opts.onSetEffort ? await this.opts.onSetEffort(effort) : null;
      if (r && r.rejected) {
        this.effortSelect.value = prev;
        this._addNotice('Could not change effort: ' + r.error, true);
        return;
      }
      this._reflectEffort(effort);
    });
    this.skillsBtn.addEventListener('click', () => this._toggleSkills());
    this.capsBtn.addEventListener('click', () => this._toggleCaps());
    this.filesBtn.addEventListener('click', async () => {
      this._hidePopover();
      if (!this.opts.onPickFiles) return;
      const paths = await this.opts.onPickFiles();
      if (paths && paths.length) this._addAttachmentPaths(paths);
    });

    // Drag & drop anywhere on the conversation attaches the dropped files.
    container.addEventListener('dragover', (e) => {
      const types = (e.dataTransfer && e.dataTransfer.types) || [];
      if (Array.from(types).includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        container.classList.add('dragging');
      }
    });
    container.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget || !container.contains(e.relatedTarget)) {
        container.classList.remove('dragging');
      }
    });
    container.addEventListener('drop', (e) => {
      container.classList.remove('dragging');
      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      e.preventDefault();
      for (const f of files) this._attachFile(f);
      this._renderAttachments();
      this.focusInput();
    });
    document.addEventListener('click', (e) => {
      if (!this.popover.contains(e.target) &&
          e.target !== this.skillsBtn && e.target !== this.capsBtn) {
        this._hidePopover();
      }
    });

    this.sendBtn.addEventListener('click', () => this._onButton());
    this.micBtn.addEventListener('click', () => this.toggleMic());
    this.input.addEventListener('keydown', (e) => {
      if (this.ac.open) {
        if (e.key === 'ArrowDown') { e.preventDefault(); return this._moveAC(1); }
        if (e.key === 'ArrowUp') { e.preventDefault(); return this._moveAC(-1); }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return this._applyAC(); }
        if (e.key === 'Escape') { e.preventDefault(); return this._hideAC(); }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._send();
      } else if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        this._cycleMode();
      } else if (e.key === 'Escape' && (this.mic || this.speaker.speaking)) {
        // Esc drops the take / silences the reply before it interrupts Claude.
        e.preventDefault();
        if (this.mic) this._cancelMic();
        else this.speaker.stop();
      } else if (e.key === 'Escape' && this.busy) {
        e.preventDefault();
        if (this.opts.onInterrupt) this.opts.onInterrupt();
      } else if (e.key === 'ArrowUp' && !this.input.value && this.sentHistory.length) {
        e.preventDefault();
        this.sentIdx = this.sentIdx < 0 ? this.sentHistory.length - 1 : Math.max(0, this.sentIdx - 1);
        this.input.value = this.sentHistory[this.sentIdx];
        this._growInput();
      }
    });
    this.input.addEventListener('input', () => {
      if (!this.input.value.trim()) this.voiceDraft = false;
      this._growInput();
      this._updateAutocomplete();
      this._reflectButton();
      if (this.opts.onDraft) this.opts.onDraft(this.input.value);
    });
    // Pasting files (a screenshot, or files copied in the file manager)
    // attaches them instead of pasting text.
    this.input.addEventListener('paste', (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const files = [];
      for (const it of items) {
        if (it.kind === 'file') {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (!files.length) return;
      e.preventDefault();
      for (const f of files) this._attachFile(f);
      this._renderAttachments();
    });
    this.input.addEventListener('blur', () => setTimeout(() => this._hideAC(), 120));

    this.scrollEl.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a');
      if (a && /^https?:\/\//.test(a.href)) {
        e.preventDefault();
        if (this.opts.onOpenLink) this.opts.onOpenLink(a.href);
      }
    });

    this.setModels(DEFAULT_MODELS); // usable immediately; refined once init arrives
  }

  // -- input ------------------------------------------------------------

  _growInput() {
    this.input.style.height = 'auto';
    this.input.style.height = Math.min(this.input.scrollHeight, 200) + 'px';
  }

  _onButton() {
    // While Claude works the button stops it — unless you've typed a follow-up,
    // in which case it queues that instead.
    if (this.busy && !this.input.value.trim() && !this.attachments.length) {
      if (this.opts.onInterrupt) this.opts.onInterrupt();
    } else {
      this._send();
    }
  }

  /** voice: the message was spoken, so its reply may be read aloud. */
  _send(voice) {
    const text = this.input.value.trim();
    const atts = this.attachments.slice();
    if (!text && !atts.length) return;
    voice = !!voice || this.voiceDraft;
    this.voiceDraft = false;
    this.input.value = '';
    this.attachments = [];
    this._renderAttachments();
    this._growInput();
    if (this.opts.onDraft) this.opts.onDraft('');
    if (text) { this.sentHistory.push(text); this.sentIdx = -1; }
    if (this.busy) {
      this.queued.push({ text, atts, voice });
      this._renderQueue();
      this._reflectButton();
      return;
    }
    this._dispatch(text, atts, voice);
  }

  async _dispatch(text, atts, voice) {
    this.addUserBubble(text, atts);
    this.setBusy(true);
    this.speaker.stop(); // a new message makes the last reply moot
    const read = this._voicePrefs().read || 'mic';
    this.speakTurn = read === 'always' || (read === 'mic' && !!voice);
    if (this.autoModel) await this._routeModel(text, atts);
    if (this.opts.onSend) {
      this.opts.onSend(text, atts.map((a) => ({
        kind: a.kind,
        name: a.name,
        path: a.path || null,
        mediaType: a.mediaType || null,
        base64: a.base64 || null,
      })));
    }
  }

  _renderQueue() {
    const el = this.queueEl;
    el.innerHTML = '';
    el.style.display = this.queued.length ? '' : 'none';
    this.queued.forEach((q, i) => {
      const row = document.createElement('div');
      row.className = 'queue-row';
      const label = document.createElement('span');
      label.className = 'queue-text';
      label.textContent = '⏳ Queued: ' + (q.text || q.atts.length + ' attachment(s)');
      const rm = document.createElement('button');
      rm.className = 'att-remove';
      rm.title = 'Remove from queue';
      rm.textContent = '✕';
      rm.addEventListener('click', () => { this.queued.splice(i, 1); this._renderQueue(); });
      row.appendChild(label);
      row.appendChild(rm);
      el.appendChild(row);
    });
  }

  /** Send button: ▲ send/queue, ■ stop (only when busy with nothing typed). */
  _reflectButton() {
    const stop = this.busy && !this.input.value.trim() && !this.attachments.length;
    this.sendBtn.classList.toggle('busy', stop);
    this.sendBtn.innerHTML = stop ? '■' : '▲';
    this.sendBtn.title = stop ? 'Stop (Esc)' : this.busy ? 'Queue this message' : 'Send';
  }

  setDraft(text) {
    if (!text || this.input.value) return;
    this.input.value = text;
    this._growInput();
  }

  _cycleMode() {
    // Shift+Tab never lands on Bypass — that one has to be picked on purpose.
    const order = [...this.modeSelect.options]
      .filter((o) => !o.disabled && o.value !== 'bypassPermissions')
      .map((o) => o.value);
    const next = order[(order.indexOf(this.modeSelect.value) + 1) % order.length];
    this.modeSelect.value = next;
    this.modeSelect.dispatchEvent(new Event('change'));
  }

  // -- voice ------------------------------------------------------------

  _voicePrefs() {
    return (this.opts.voicePrefs && this.opts.voicePrefs()) || {};
  }

  /** Mic button / Ctrl+M: start listening, or finish the take in progress. */
  async toggleMic() {
    if (this.mic) return this._finishMic();
    if (this.micBusy || !this.opts.onTranscribe) return;
    this.speaker.stop(); // don't transcribe Claude talking
    const rec = new MicRecorder({
      onLevel: (l) => this.micBtn.style.setProperty('--lvl', l.toFixed(2)),
      onSilence: () => { if (this.mic === rec && this._voicePrefs().autoSend !== false) this._finishMic(); },
    });
    this.mic = rec;
    try {
      await rec.start();
    } catch (err) {
      this.mic = null;
      this._addNotice('Microphone unavailable: ' + (err && err.message ? err.message : err), true);
      return;
    }
    if (this.mic !== rec) return; // cancelled while the mic was opening
    this.micBtn.classList.add('rec');
    this.micBtn.title = 'Done talking (Ctrl+M)';
    this._voiceStatus(this._voicePrefs().autoSend !== false
      ? 'Listening… sends when you pause · Ctrl+M to finish now · Esc to cancel'
      : 'Listening… Ctrl+M or the mic button when done · Esc to cancel');
    this.input.focus();
  }

  _resetMicButton() {
    this.micBtn.classList.remove('rec');
    this.micBtn.style.removeProperty('--lvl');
    this.micBtn.title = 'Talk to Claude (Ctrl+M)';
  }

  _cancelMic() {
    if (!this.mic) return;
    this.mic.cancel();
    this.mic = null;
    this._resetMicButton();
    this._voiceStatus('');
  }

  async _finishMic() {
    const rec = this.mic;
    if (!rec) return;
    this.mic = null;
    this._resetMicButton();
    this.micBusy = true;
    this.micBtn.classList.add('busy');
    this._voiceStatus('Transcribing…');
    let text = '';
    try {
      const audio = await rec.stop();
      if (!audio) {
        this._addNotice('No sound from the microphone — is it muted?', true);
        return;
      }
      const r = await this.opts.onTranscribe(audio);
      if (!r || !r.ok) {
        this._addNotice('Could not transcribe: ' + ((r && r.error) || 'unknown error'), true);
        return;
      }
      text = cleanTranscript(r.text);
      if (!text) this._addNotice('Didn\'t catch that — try again.', true);
    } catch (err) {
      this._addNotice('Could not transcribe: ' + (err && err.message ? err.message : err), true);
    } finally {
      this.micBusy = false;
      this.micBtn.classList.remove('busy');
      this._voiceStatus('');
    }
    if (!text) return;
    const cur = this.input.value.trim();
    this.input.value = cur ? cur + ' ' + text : text;
    this._growInput();
    this._reflectButton();
    if (this.opts.onDraft) this.opts.onDraft(this.input.value);
    if (this._voicePrefs().autoSend !== false) {
      this._send(true);
    } else {
      this.voiceDraft = true;
      this.input.focus();
    }
  }

  /** First mic use downloads the speech model; show how far along it is. */
  voiceProgress(loaded, total) {
    if (!this.micBusy || !total) return;
    this._voiceStatus('Downloading the speech model (first time only)… ' +
      Math.round((loaded / total) * 100) + '%');
  }

  _reflectSpeaking(speaking) {
    if (this.mic || this.micBusy) return; // the mic owns the status line
    if (speaking) {
      this._voiceStatus('🔊 Reading the reply aloud', { label: 'Stop (Esc)', run: () => this.speaker.stop() });
    } else if (this.voiceStatusEl.dataset.kind === 'speaking') {
      this._voiceStatus('');
    }
  }

  /** One line above the input for listening / transcribing / speaking. */
  _voiceStatus(text, action) {
    const el = this.voiceStatusEl;
    el.innerHTML = '';
    el.dataset.kind = action ? 'speaking' : '';
    el.style.display = text ? '' : 'none';
    if (!text) return;
    const t = document.createElement('span');
    t.textContent = text;
    el.appendChild(t);
    if (action) {
      const b = document.createElement('button');
      b.className = 'voice-status-btn';
      b.textContent = action.label;
      b.addEventListener('click', action.run);
      el.appendChild(b);
    }
  }

  focusInput() {
    // A card waiting on the user owns the keyboard (number keys pick options),
    // so coming back to this tab should land there, not in the composer.
    if (
      this.pendingCard &&
      this.pendingCard.isConnected &&
      !this.pendingCard.classList.contains('answered')
    ) {
      this.pendingCard.focus();
      return;
    }
    this.input.focus();
  }

  // -- autocomplete (/ commands, @ files) ------------------------------

  _updateAutocomplete() {
    const val = this.input.value;
    const pos = this.input.selectionStart || 0;
    const before = val.slice(0, pos);
    const cmd = before.match(/^\/([a-zA-Z0-9:_-]*)$/);
    if (cmd) {
      this.ac.kind = 'cmd';
      this.ac.start = 0;
      this.ac.end = pos;
      this.ac.token = cmd[1];
      return this._showCommandAC(cmd[1]);
    }
    const at = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (at) {
      const token = at[1];
      this.ac.kind = 'file';
      this.ac.start = pos - token.length - 1;
      this.ac.end = pos;
      this.ac.token = token;
      return this._showFileAC(token);
    }
    this._hideAC();
  }

  _showCommandAC(prefix) {
    const cmds = (this.meta.commands && this.meta.commands.length)
      ? this.meta.commands
      : (this.meta.skills || []).map((s) => ({ name: s, description: '' }));
    const p = prefix.toLowerCase();
    const items = cmds
      .filter((c) => c.name.toLowerCase().includes(p))
      .slice(0, 8)
      .map((c) => ({ label: '/' + c.name, desc: c.description || '', insert: '/' + c.name + ' ' }));
    if (!items.length) return this._hideAC();
    this._renderAC(items);
  }

  async _showFileAC(prefix) {
    if (!this.opts.onListFiles) return this._hideAC();
    let files;
    try { files = await this.opts.onListFiles(prefix); } catch (_) { return this._hideAC(); }
    // The user may have typed more since the request fired — bail if stale.
    if (this.ac.kind !== 'file' || this.ac.token !== prefix) return;
    if (!files || !files.length) return this._hideAC();
    const items = files.slice(0, 10).map((f) => ({ label: f, desc: '', insert: '@' + f + ' ' }));
    this._renderAC(items);
  }

  _renderAC(items) {
    this.ac.items = items;
    this.ac.active = 0;
    this.ac.open = true;
    let html = '';
    items.forEach((it, i) => {
      html += '<div class="cc-ac-item' + (i === 0 ? ' active' : '') + '" data-i="' + i + '">' +
        '<span class="cc-ac-label">' + esc(it.label) + '</span>' +
        (it.desc ? '<span class="cc-ac-desc">' + esc(it.desc.slice(0, 60)) + '</span>' : '') +
        '</div>';
    });
    this.acEl.innerHTML = html;
    this.acEl.style.display = 'block';
    this.acEl.querySelectorAll('.cc-ac-item').forEach((row) => {
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.ac.active = Number(row.dataset.i);
        this._applyAC();
      });
    });
  }

  _moveAC(delta) {
    if (!this.ac.items.length) return;
    this.ac.active = (this.ac.active + delta + this.ac.items.length) % this.ac.items.length;
    [...this.acEl.children].forEach((c, i) => c.classList.toggle('active', i === this.ac.active));
  }

  _applyAC() {
    const it = this.ac.items[this.ac.active];
    if (!it) return this._hideAC();
    const val = this.input.value;
    const newVal = val.slice(0, this.ac.start) + it.insert + val.slice(this.ac.end);
    this.input.value = newVal;
    const caret = this.ac.start + it.insert.length;
    this._hideAC();
    this._growInput();
    this.input.focus();
    try { this.input.setSelectionRange(caret, caret); } catch (_) { /* ignore */ }
  }

  _hideAC() {
    this.ac.open = false;
    this.ac.items = [];
    if (this.acEl) this.acEl.style.display = 'none';
  }

  // -- model / skills / files toolbar ----------------------------------

  /** Populate the model dropdown. models: [{value, displayName, description}] */
  setModels(models, active) {
    this.meta.models = models || [];
    const cur = active || this.meta.model || '';
    this.modelSelect.innerHTML = '';
    if (!this.meta.models.length) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = active || 'default model';
      this.modelSelect.appendChild(o);
      return;
    }
    for (const m of this.meta.models) {
      const o = document.createElement('option');
      o.value = m.value;
      o.textContent = m.displayName || m.value;
      if (m.description) o.title = m.description;
      this.modelSelect.appendChild(o);
    }
    if (cur) this.setActiveModel(cur);
  }

  /** Mark which model is currently in use (selects it in the dropdown). */
  setActiveModel(model) {
    if (!model) return;
    this.meta.model = model;
    const opts = [...this.modelSelect.options];
    let hit = opts.find((o) => o.value === model);
    if (!hit) {
      // active model not in the list (e.g. an alias resolved to a versioned id
      // like "claude-opus-4-7[1m]") — add it, nicely labelled, as "in use".
      hit = document.createElement('option');
      hit.value = model;
      hit.textContent = prettyModel(model) + ' — in use';
      this.modelSelect.appendChild(hit);
    }
    this.modelSelect.value = hit.value;
  }

  /** Sync the permission-mode dropdown (e.g. when resuming a session). */
  setPermissionMode(mode, quiet) {
    if (!mode || !this.modeSelect) return;
    const known = [...this.modeSelect.options].some((o) => o.value === mode);
    if (known) this.modeSelect.value = mode;
    this._reflectMode(this.modeSelect.value, quiet);
  }

  /** Update the mode indicator colour + a one-line notice when it changes. */
  _reflectMode(mode, quiet) {
    if (this.meta.permissionMode === mode) return;
    const first = this.meta.permissionMode === undefined;
    this.meta.permissionMode = mode;
    if (this.modeSelect) this.modeSelect.dataset.mode = mode;
    if (first || quiet) return; // don't announce the initial state
    if (mode === 'plan') {
      this._addNotice('Plan mode on — Claude will propose a plan without changing files.');
    } else if (mode === 'acceptEdits') {
      this._addNotice('Auto-accept edits on — file edits apply without asking (commands still ask).');
    } else if (mode === 'auto') {
      this._addNotice('Auto mode on — a safety check approves or blocks each action instead of asking you.');
    } else if (mode === 'bypassPermissions') {
      this._addNotice('Bypass permissions on — every tool runs without asking, commands included. Use only in a folder you trust.', true);
    } else {
      this._addNotice('Manual mode — Claude asks before each action.');
    }
  }

  /** Grey a mode out of the dropdown (and Shift+Tab) when the session refuses it. */
  _setModeAvailable(mode, on) {
    const o = [...this.modeSelect.options].find((x) => x.value === mode);
    if (o) o.disabled = !on;
  }

  /** Sync the effort dropdown (e.g. restoring a tab). '' = model default. */
  setEffort(effort, quiet) {
    if (effort == null || !(effort in EFFORT_LABELS)) effort = '';
    this.effortSelect.value = effort;
    this._reflectEffort(effort, quiet);
  }

  _reflectEffort(effort, quiet) {
    if (this.meta.effort === effort) return;
    const first = this.meta.effort === undefined;
    this.meta.effort = effort;
    this.effortSelect.dataset.effort = effort;
    if (first || quiet) return;
    this._addNotice(effort
      ? EFFORT_LABELS[effort] + ' — applies from the next reply.'
      : 'Effort back to the model default.');
  }

  /** Turn Auto model on/off without announcing it (e.g. restoring a tab). */
  setAutoModel(on) {
    this.autoModel = !!on;
    this.autoModelBtn.classList.toggle('on', this.autoModel);
    this.modelSelect.closest('.cc-model').classList.toggle('auto', this.autoModel);
  }

  _toggleAutoModel(on) {
    this.setAutoModel(on);
    if (this.opts.onSetAutoModel) this.opts.onSetAutoModel(this.autoModel);
    this._addNotice(this.autoModel
      ? 'Auto model on — each message goes to Haiku, Sonnet or Opus depending on the task.'
      : 'Auto model off — staying on the selected model.');
  }

  /** Auto model: switch to the model this message needs before it goes out. */
  async _routeModel(text, atts) {
    // Auto mode only runs on some models, so don't move it off a working one.
    if (this.meta.permissionMode === 'auto') return;
    const pick = pickModelForTask(text, atts, this.meta.permissionMode);
    const family = (String(this.meta.model || '').match(/opus|sonnet|haiku/i) || [''])[0].toLowerCase();
    if (!pick || family === pick.model) return;
    // Near a full window a smaller-context model could overflow, and each
    // switch re-reads the whole history uncached — so stay put.
    if (this.context.tokens > 150000) return;
    if (this.opts.onSetModel) await this.opts.onSetModel(pick.model);
    this.setActiveModel(pick.model);
    this._setModeAvailable('auto', true);
    this._addNotice('Auto model → ' + MODEL_LABELS[pick.model] + ' (' + pick.why + ')');
  }

  /** Record available skills, tools and MCP servers from the session init. */
  setCapabilities({ skills, tools, mcp, slashCommands }) {
    if (skills) this.meta.skills = skills;
    if (slashCommands) this.meta.slashCommands = slashCommands;
    if (tools) this.meta.tools = tools;
    if (mcp) this.meta.mcp = mcp;
    this._updateSkillsCount();
  }

  /** Authoritative skill/command list from supportedCommands(): {name, description, argumentHint}. */
  setCommands(commands) {
    this.meta.commands = (commands || []).map((c) =>
      typeof c === 'string' ? { name: c.replace(/^\//, ''), description: '' } : c
    );
    this._updateSkillsCount();
  }

  _updateSkillsCount() {
    const n = (this.meta.commands && this.meta.commands.length) || (this.meta.skills || []).length;
    this.skillsBtn.textContent = n ? '⚡ Skills (' + n + ')' : '⚡ Skills';
  }

  _hidePopover() {
    this.popover.style.display = 'none';
  }

  _toggleSkills() {
    if (this.popover.style.display !== 'none' && this.popover.dataset.kind === 'skills') {
      return this._hidePopover();
    }
    // Prefer the rich command list (name + description); fall back to plain names.
    let commands = this.meta.commands && this.meta.commands.length
      ? this.meta.commands
      : (this.meta.skills || []).map((s) => ({ name: s, description: '' }));
    let html = '<div class="cc-pop-title">Skills & commands — click to use</div>';
    if (!commands.length) {
      html += '<div class="cc-pop-empty">Loading available skills… (a chat session must be active)</div>';
      return this._showPopover(html, 'skills');
    }
    html += '<input class="cc-pop-search" placeholder="Filter skills…" />';
    html += '<div class="cc-pop-list">';
    for (const c of commands) {
      const hint = c.argumentHint ? ' ' + c.argumentHint : '';
      const desc = (c.description || '').slice(0, 90);
      html += '<button class="cc-pop-item" data-insert="/' + esc(c.name) + hint.trim() + ' " data-name="' + esc(c.name) + '">' +
        '<span class="cc-pop-name">⚡ /' + esc(c.name) + '</span>' +
        (desc ? '<span class="cc-pop-desc">' + esc(desc) + '</span>' : '') +
        '</button>';
    }
    html += '</div>';
    this._showPopover(html, 'skills');
    const search = this.popover.querySelector('.cc-pop-search');
    if (search) {
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        this.popover.querySelectorAll('.cc-pop-item').forEach((b) => {
          b.style.display = b.dataset.name.toLowerCase().includes(q) ? '' : 'none';
        });
      });
      setTimeout(() => search.focus(), 0);
    }
  }

  _toggleCaps() {
    if (this.popover.style.display !== 'none' && this.popover.dataset.kind === 'caps') {
      return this._hidePopover();
    }
    const tools = this.meta.tools || [];
    const mcp = this.meta.mcp || [];
    let html = '<div class="cc-pop-title">Model in use</div>' +
      '<div class="cc-pop-active">' + esc(this.meta.model || 'default') + '</div>';
    html += '<div class="cc-pop-title">Tools (' + tools.length + ')</div><div class="cc-pop-tags">';
    for (const t of tools) html += '<span class="cc-tag">' + esc(t) + '</span>';
    html += '</div>';
    if (mcp.length) {
      html += '<div class="cc-pop-title">MCP servers</div><div class="cc-pop-tags">';
      for (const s of mcp) {
        const ok = (s.status || '').toLowerCase() === 'connected';
        html += '<span class="cc-tag ' + (ok ? 'ok' : 'off') + '">' +
          esc(s.name || s) + '</span>';
      }
      html += '</div>';
    }
    this._showPopover(html, 'caps');
  }

  _showPopover(html, kind) {
    this.popover.innerHTML = html;
    this.popover.dataset.kind = kind;
    this.popover.style.display = 'block';
    this.popover.querySelectorAll('[data-insert]').forEach((b) => {
      b.addEventListener('click', () => {
        this._insertAtStart(b.dataset.insert);
        this._hidePopover();
        this.focusInput();
      });
    });
  }

  _insertAtStart(text) {
    this.input.value = text + this.input.value;
    this._growInput();
  }

  // -- attachments ------------------------------------------------------

  _addAttachmentPaths(paths) {
    for (const p of paths) this._attachPath(p);
    this._renderAttachments();
    this.focusInput();
  }

  /** Attach a dropped or pasted browser File — by its real path when it has
   *  one, otherwise from its bytes. */
  _attachFile(f) {
    let p = '';
    try {
      p = webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(f) : (f.path || '');
    } catch (_) { p = f.path || ''; }
    if (p) this._attachPath(p);
    else this._attachFileObject(f);
  }

  /** Attach a file by absolute path. Images the API accepts are read now
   *  (thumbnail + base64 payload); any other file — or an image over the size
   *  limit — travels as a path reference Claude opens itself. */
  _attachPath(p) {
    const name = String(p).split('/').pop() || String(p);
    const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1];
    const mediaType = IMAGE_MEDIA_TYPES[(ext || '').toLowerCase()];
    if (isPdf(name)) return this._attachPdf(name, p);
    try {
      if (mediaType && fs.statSync(p).size <= MAX_IMAGE_BYTES) {
        const base64 = fs.readFileSync(p).toString('base64');
        this.attachments.push({
          kind: 'image', name, path: p, mediaType, base64,
          dataUrl: 'data:' + mediaType + ';base64,' + base64,
        });
        return;
      }
    } catch (_) { /* unreadable here — let Claude try with its own tools */ }
    this.attachments.push({ kind: 'file', name, path: p });
  }

  /** Attach a PDF: inline as a document block when it's small enough,
   *  otherwise by path. `buf` is given for pasted data with no file yet. */
  _attachPdf(name, p, buf) {
    let size = buf ? buf.length : 0;
    try {
      if (!buf) size = fs.statSync(p).size;
      if (!buf && size <= MAX_PDF_BYTES) buf = fs.readFileSync(p);
    } catch (_) { /* unreadable here — let Claude try with its own tools */ }
    const { pages, inline } = buf ? pdfAttachment(name, buf, p) : { pages: 0, inline: null };
    if (inline) {
      this.attachments.push(inline);
      return;
    }
    if (!p) {
      p = saveTempAttachment(name, buf);
      name = path.basename(p);
    }
    const why = size > MAX_PDF_BYTES ? 'Over 10 MB'
      : pages ? pagesLabel(pages) + ' (over ' + MAX_PDF_PAGES + ')'
        : "Couldn't check its length";
    this.attachments.push({
      kind: 'file', name, path: p,
      note: why + ' — attached by path; Claude opens it with its Read tool a few pages at a time.',
    });
  }

  /** Attach a File with no filesystem path (a pasted screenshot, a file
   *  dragged out of another app). API images and small PDFs go inline;
   *  anything else is saved to the temp dir and attached by path. */
  _attachFileObject(f) {
    const type = f.type === 'image/jpg' ? 'image/jpeg' : (f.type || '');
    const inline = Object.values(IMAGE_MEDIA_TYPES).includes(type) && f.size <= MAX_IMAGE_BYTES;
    f.arrayBuffer().then((ab) => {
      const buf = Buffer.from(ab);
      if (isPdf(f.name, type)) {
        this._attachPdf(f.name || 'pasted.pdf', '', buf);
      } else if (inline) {
        const base64 = buf.toString('base64');
        this.attachments.push({
          kind: 'image',
          name: f.name || 'pasted-image.' + type.split('/')[1],
          mediaType: type, base64,
          dataUrl: 'data:' + type + ';base64,' + base64,
        });
      } else {
        const p = saveTempAttachment(f.name, buf);
        this.attachments.push({ kind: 'file', name: path.basename(p), path: p });
      }
      this._renderAttachments();
    }).catch(() => {
      this._addNotice('Could not attach "' + (f.name || 'file') + '".', true);
    });
  }

  _renderAttachments() {
    const el = this.attachEl;
    if (!el) return;
    el.innerHTML = '';
    if (!this.attachments.length) { el.style.display = 'none'; return; }
    el.style.display = '';
    this.attachments.forEach((a, i) => {
      const chip = document.createElement('div');
      chip.className = 'att-chip';
      if (a.kind === 'image' && a.dataUrl) {
        const img = document.createElement('img');
        img.className = 'att-thumb';
        img.src = a.dataUrl;
        img.alt = a.name;
        chip.appendChild(img);
      } else {
        const ic = document.createElement('span');
        ic.className = 'att-icon' + (a.kind === 'pdf' ? ' pdf' : '');
        ic.textContent = a.kind === 'pdf' ? 'PDF' : '📄';
        chip.appendChild(ic);
      }
      const nm = document.createElement('span');
      nm.className = 'att-name';
      nm.textContent = a.name;
      nm.title = [a.path || a.name, a.note].filter(Boolean).join('\n');
      chip.appendChild(nm);
      if (a.kind === 'pdf' || a.note) {
        const meta = document.createElement('span');
        meta.className = 'att-meta';
        meta.textContent = a.kind === 'pdf' ? pagesLabel(a.pages) : 'read by page';
        meta.title = a.kind === 'pdf' ? 'Sent to Claude as a PDF — it sees the text and the page images' : a.note;
        chip.appendChild(meta);
      }
      const rm = document.createElement('button');
      rm.className = 'att-remove';
      rm.title = 'Remove attachment';
      rm.textContent = '✕';
      rm.addEventListener('click', () => {
        this.attachments.splice(i, 1);
        this._renderAttachments();
      });
      chip.appendChild(rm);
      el.appendChild(chip);
    });
  }

  setBusy(busy) {
    const was = this.busy;
    this.busy = busy;
    this._reflectButton();
    if (busy) this._showTyping();
    else this._removeTyping();
    if (busy && !was) {
      this.busySince = Date.now();
      this._setActivity('Thinking…');
      this.activityEl.style.display = '';
      clearInterval(this.activityTimer);
      this.activityTimer = setInterval(() => this._tickActivity(), 1000);
      this._tickActivity();
    } else if (!busy) {
      clearInterval(this.activityTimer);
      this.activityTimer = null;
      this.activityEl.style.display = 'none';
    }
  }

  _setActivity(text) {
    if (this.activityText && text) this.activityText.textContent = text;
  }

  _tickActivity() {
    const s = Math.floor((Date.now() - (this.busySince || Date.now())) / 1000);
    this.activityTime.textContent = s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  }

  /** Release timers when the pane is torn down. */
  dispose() {
    clearInterval(this.activityTimer);
    this._cancelMic();
    if (this.speaker.speaking) this.speaker.stop();
  }

  // -- incoming SDK messages -------------------------------------------

  handleSdkMessage(msg) {
    if (!msg || !msg.type) return;
    // A sub-agent's traffic belongs inside the card that launched it, not in
    // the main conversation.
    if (msg.parent_tool_use_id) return this._onSubagentMessage(msg);
    if (msg.type === 'stream_event') this._onStreamEvent(msg.event);
    else if (msg.type === 'assistant') this._onAssistant(msg);
    else if (msg.type === 'user') this._onUser(msg);
    else if (msg.type === 'result') this._onResult(msg);
    else if (msg.type === 'system' && msg.subtype === 'init') {
      this.setCapabilities({
        skills: msg.skills,
        slashCommands: msg.slash_commands,
        tools: msg.tools,
        mcp: msg.mcp_servers,
      });
      if (msg.model) this.setActiveModel(msg.model);
      // A session asked to start in Auto mode quietly falls back to Manual on
      // models that don't support it — show what it's really running.
      if (this.meta.permissionMode === 'auto' && msg.permissionMode && msg.permissionMode !== 'auto') {
        this.setPermissionMode(msg.permissionMode, true);
        this._addNotice('Auto mode isn\'t available for this model — switched to Manual.', true);
      }
    } else if (msg.type === 'system' && msg.subtype === 'permission_denied') {
      this._addNotice('Action declined: ' + (msg.message || ''), true);
    }
  }

  _onSubagentMessage(msg) {
    const parent = this.toolCards.get(msg.parent_tool_use_id);
    if (!parent || msg.type === 'stream_event') return;
    const content = (msg.message && msg.message.content) || [];
    if (!Array.isArray(content)) return;
    let steps = parent.body.querySelector('.sub-steps');
    if (!steps) {
      steps = document.createElement('div');
      steps.className = 'tool-section sub-steps';
      steps.innerHTML = '<div class="tool-section-h">Sub-agent activity</div>';
      parent.body.appendChild(steps);
    }
    for (const b of content) {
      if (msg.type === 'assistant' && b.type === 'tool_use') {
        const info = toolSummary(b.name, b.input);
        const row = document.createElement('div');
        row.className = 'sub-step';
        row.dataset.status = 'running';
        row.innerHTML = '<span class="tool-dot"></span><span class="sub-step-label">' +
          esc(info.label) + '</span><span class="sub-step-detail">' + esc(info.detail) + '</span>';
        steps.appendChild(row);
        this.subSteps.set(b.id, row);
        this._setActivity('Sub-agent: ' + activityLabel(b.name));
      } else if (msg.type === 'user' && b.type === 'tool_result') {
        const row = this.subSteps.get(b.tool_use_id);
        if (row) row.dataset.status = b.is_error ? 'error' : 'done';
      }
    }
    const n = steps.querySelectorAll('.sub-step').length;
    const stat = parent.card.querySelector('.tool-substat');
    if (stat) stat.textContent = n + ' step' + (n === 1 ? '' : 's');
    this._autoscroll();
  }

  /** Render a previously saved conversation (array of SessionMessage). */
  renderHistory(messages) {
    // Questions and plans in a saved chat were answered long ago — replay them
    // as a read-only record instead of asking again.
    this.replaying = true;
    try {
      this._replay(messages);
    } finally {
      this.replaying = false;
    }
    this._autoscroll(true);
  }

  _replay(messages) {
    for (const m of messages || []) {
      const inner = m && m.message;
      if (!inner) continue;
      if (m.type === 'user') {
        const c = inner.content;
        if (typeof c === 'string') {
          if (c.trim()) this.addUserBubble(c);
        } else if (Array.isArray(c)) {
          const txt = c
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
          const results = c.filter((b) => b.type === 'tool_result');
          const images = c
            .filter((b) => b.type === 'image' && b.source && b.source.type === 'base64')
            .map((b) => ({
              kind: 'image',
              name: 'image',
              dataUrl: 'data:' + b.source.media_type + ';base64,' + b.source.data,
            }))
            .concat(c.filter((b) => b.type === 'document')
              .map((b) => ({ kind: 'pdf', name: b.title || 'PDF document' })));
          if ((txt.trim() || images.length) && !results.length) {
            this.addUserBubble(txt, images);
          }
          for (const r of results) this._updateToolCard(r.tool_use_id, r);
        }
      } else if (m.type === 'assistant') {
        this._onAssistant({ message: inner });
      }
    }
  }

  _onStreamEvent(ev) {
    if (!ev) return;
    if (ev.type === 'message_start') {
      this.streaming = this._beginAssistant();
    } else if (ev.type === 'content_block_delta') {
      if (!this.streaming) this.streaming = this._beginAssistant();
      const d = ev.delta || {};
      if (d.type === 'text_delta' && typeof d.text === 'string') {
        this.streaming.text += d.text;
        this._scheduleRender(this.streaming);
        this._setActivity('Writing…');
        if (this.speakTurn) this.speaker.feed(d.text);
      } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
        this.streaming.thinking += d.thinking;
        this._renderThinking(this.streaming);
        this._setActivity('Thinking…');
      }
    } else if (ev.type === 'content_block_stop' && this.speakTurn) {
      this.speaker.flush();
    }
    this._autoscroll();
  }

  _onAssistant(msg) {
    const content = (msg.message && msg.message.content) || [];
    const st = this.streaming || this._beginAssistant();

    const text = content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n\n');
    const thinking = content
      .filter((b) => b.type === 'thinking')
      .map((b) => b.thinking)
      .join('\n');

    if (thinking) {
      st.thinking = thinking;
      this._renderThinking(st);
    }
    st.text = text;
    this._renderText(st);

    for (const b of content) {
      if (b.type === 'tool_use') {
        this._addToolCard(st, b);
        if (!this.replaying) this._setActivity(activityLabel(b.name));
      }
    }
    const u = msg.message && msg.message.usage;
    if (u) {
      this.context.tokens = Number(u.input_tokens || 0) +
        Number(u.cache_read_input_tokens || 0) + Number(u.cache_creation_input_tokens || 0) +
        Number(u.output_tokens || 0);
      this._renderContext();
    }
    if (msg.error) {
      this._addNotice('The model reported an error: ' + msg.error, true);
    }
    this.streaming = null;
    this._autoscroll();
  }

  _onUser(msg) {
    const content = msg.message && msg.message.content;
    if (!Array.isArray(content)) return; // plain string = our own prompt echo
    for (const b of content) {
      if (b.type === 'tool_result') this._updateToolCard(b.tool_use_id, b);
    }
    this._setActivity('Working…');
    this._autoscroll();
  }

  _onResult(msg) {
    this.setBusy(false);
    this.streaming = null;
    if (this.speakTurn) this.speaker.flush();
    this.speakTurn = false;
    this._accrueUsage(msg);
    for (const k of Object.keys(msg.modelUsage || {})) {
      const w = Number(msg.modelUsage[k] && msg.modelUsage[k].contextWindow) || 0;
      if (w > this.context.window) this.context.window = w;
    }
    this._renderContext();
    // Anything typed while Claude was busy goes out now, one turn at a time.
    if (this.queued.length) {
      const next = this.queued.shift();
      this._renderQueue();
      setTimeout(() => this._dispatch(next.text, next.atts, next.voice), 0);
    }
    if (msg.subtype !== 'success' || msg.is_error) {
      let m = 'The response did not complete.';
      if (msg.subtype === 'error_max_turns') m = 'Reached the maximum number of steps.';
      else if (typeof msg.result === 'string' && msg.result) m = msg.result;
      this._addNotice(m, true);
    }
    this._autoscroll(true);
  }

  // -- usage HUD --------------------------------------------------------

  /** Accumulate token/cost totals from a `result` message and refresh the HUD. */
  _accrueUsage(msg) {
    if (!msg) return;
    const u = msg.usage || {};
    this.usage.turns += 1;
    this.usage.inTokens += Number(u.input_tokens || 0);
    this.usage.outTokens += Number(u.output_tokens || 0);
    this.usage.cacheReadTokens += Number(u.cache_read_input_tokens || 0);
    if (typeof msg.total_cost_usd === 'number') this.usage.costUsd = msg.total_cost_usd;
    this._renderUsage();
  }

  _renderUsage() {
    if (!this.usageEl) return;
    const u = this.usage;
    if (!u.turns) { this.usageEl.style.display = 'none'; return; }
    const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n));
    const tokens = fmt(u.inTokens + u.outTokens);
    const cost = u.costUsd ? ' · $' + (u.costUsd < 0.01 ? u.costUsd.toFixed(4) : u.costUsd.toFixed(2)) : '';
    this.usageEl.textContent = '◔ ' + tokens + ' tok' + cost;
    this.usageEl.title =
      'This session: ' + u.inTokens.toLocaleString() + ' in / ' +
      u.outTokens.toLocaleString() + ' out tokens' +
      (u.cacheReadTokens ? ' (' + u.cacheReadTokens.toLocaleString() + ' cached)' : '') +
      (u.costUsd ? ' · est. $' + u.costUsd.toFixed(4) : '') +
      ' · ' + u.turns + ' turn' + (u.turns === 1 ? '' : 's');
    this.usageEl.style.display = '';
  }

  /** How full the model's context window is, from the latest assistant turn. */
  _renderContext() {
    const { tokens } = this.context;
    if (!tokens || !this.ctxEl) return;
    const win = this.context.window || 200000;
    const pct = Math.min(100, Math.round((tokens / win) * 100));
    this.ctxEl.style.display = '';
    this.ctxEl.dataset.level = pct >= 85 ? 'high' : pct >= 60 ? 'mid' : 'low';
    this.ctxEl.querySelector('.cc-ctx-fill').style.width = pct + '%';
    this.ctxEl.querySelector('.cc-ctx-text').textContent = pct + '% context';
    this.ctxEl.title = tokens.toLocaleString() + ' of ' + win.toLocaleString() +
      ' context tokens used' + (pct >= 85 ? ' — consider /compact' : '');
  }

  // -- rendering --------------------------------------------------------

  /** Re-rendering markdown on every delta is wasteful on long replies —
   *  coalesce to one render per animation frame. */
  _scheduleRender(st) {
    if (st.renderQueued) return;
    st.renderQueued = true;
    requestAnimationFrame(() => {
      st.renderQueued = false;
      this._renderText(st);
      this._autoscroll();
    });
  }

  _hideEmpty() {
    if (this.emptyEl) this.emptyEl.style.display = 'none';
  }

  addUserBubble(text, attachments) {
    this._hideEmpty();
    const el = document.createElement('div');
    el.className = 'msg user';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const atts = (attachments || []).filter(Boolean);
    if (atts.length) {
      const wrap = document.createElement('div');
      wrap.className = 'bubble-atts';
      for (const a of atts) {
        if (a.kind === 'image' && a.dataUrl) {
          const img = document.createElement('img');
          img.className = 'bubble-att-img';
          img.src = a.dataUrl;
          img.alt = a.name || 'image';
          img.title = (a.name || '') + ' — click to expand';
          img.addEventListener('click', () => img.classList.toggle('expanded'));
          wrap.appendChild(img);
        } else {
          const chip = document.createElement('span');
          chip.className = 'bubble-att-file';
          chip.textContent = (a.kind === 'pdf' ? '📕 ' : '📄 ') + (a.name || a.path || 'file') +
            (a.kind === 'pdf' && a.pages ? ' · ' + pagesLabel(a.pages) : '');
          chip.title = a.path || '';
          wrap.appendChild(chip);
        }
      }
      bubble.appendChild(wrap);
    }
    if (text) {
      const t = document.createElement('div');
      t.className = 'bubble-text';
      t.textContent = text;
      bubble.appendChild(t);
    }
    el.appendChild(bubble);
    this.scrollEl.appendChild(el);
    this._autoscroll(true);
  }

  _beginAssistant() {
    this._hideEmpty();
    this._removeTyping();
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML =
      '<div class="avatar">✳</div>' +
      '<div class="msg-content">' +
      '  <div class="thinking-wrap"></div>' +
      '  <div class="msg-body"></div>' +
      '  <div class="msg-actions"><button class="msg-copy" title="Copy this reply">⧉ Copy</button></div>' +
      '</div>';
    this.scrollEl.appendChild(el);
    const st = {
      el,
      contentEl: el.querySelector('.msg-content'),
      bodyEl: el.querySelector('.msg-body'),
      thinkingWrap: el.querySelector('.thinking-wrap'),
      actionsEl: el.querySelector('.msg-actions'),
      text: '',
      thinking: '',
    };
    const copyBtn = el.querySelector('.msg-copy');
    copyBtn.addEventListener('click', () => {
      copyToClipboard(st.text);
      copyBtn.textContent = '✓ Copied';
      setTimeout(() => { copyBtn.textContent = '⧉ Copy'; }, 1200);
    });
    return st;
  }

  _renderText(st) {
    if (st.text) {
      st.bodyEl.innerHTML = md.render(st.text);
      st.bodyEl.style.display = '';
      this._decorateCode(st.bodyEl);
      if (st.actionsEl) st.actionsEl.style.display = '';
    } else {
      st.bodyEl.style.display = 'none';
      if (st.actionsEl) st.actionsEl.style.display = 'none';
    }
  }

  _renderThinking(st) {
    if (!st.thinking) return;
    st.thinkingWrap.innerHTML =
      '<details class="thinking"><summary>Thought process</summary>' +
      '<div class="thinking-body">' + esc(st.thinking) + '</div></details>';
  }

  _addToolCard(st, toolUse) {
    // Live, these two get a purpose-built interactive card of their own (the
    // question options, the plan to approve) — a JSON dump of the same input
    // would just be noise. Replaying a saved chat there is nothing to answer,
    // so fall through and show a read-only record of what was asked.
    if (toolUse.name === 'AskUserQuestion' || toolUse.name === 'ExitPlanMode') {
      if (!this.replaying) return;
    }

    const info = toolSummary(toolUse.name, toolUse.input);
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.status = 'running';

    const diff = this._buildDiffSection(toolUse.name, toolUse.input);
    const todos = toolUse.name === 'TodoWrite' && toolUse.input && Array.isArray(toolUse.input.todos)
      ? todoListHtml(toolUse.input.todos)
      : null;

    const record = this._recordSection(toolUse);

    let inputSection;
    if (record) {
      inputSection = record;
    } else if (todos) {
      info.label = 'Task list';
      info.detail = todos.active || todos.done + ' of ' + todos.total + ' done';
      inputSection = '<div class="tool-section">' + todos.html + '</div>';
    } else if (diff) {
      inputSection =
        '<div class="tool-section"><div class="tool-section-h">Changes ' + diff.stat +
        '</div>' + diff.html + '</div>';
    } else {
      inputSection = inputSectionHtml(toolUse.name, toolUse.input);
    }

    const isAgent = toolUse.name === 'Task' || toolUse.name === 'Agent';
    const filePath = toolUse.input && toolUse.input.file_path;
    const previewable = diff && filePath && artifactKind(filePath) ? filePath : '';

    // Edits, the task list and replayed questions are worth seeing at a glance.
    if (diff || todos || record) card.classList.add('open');
    // Only the newest task list stays expanded — older ones fold away.
    if (todos) {
      if (this.lastTodoCard && this.lastTodoCard.isConnected) {
        this.lastTodoCard.classList.remove('open');
      }
      this.lastTodoCard = card;
    }

    card.innerHTML =
      '<div class="tool-head">' +
      '  <span class="tool-dot"></span>' +
      '  <span class="tool-label">' + esc(info.label) + '</span>' +
      '  <span class="tool-detail-text">' + esc(info.detail) + '</span>' +
      (diff ? '  <span class="tool-diffstat">' + diff.stat + '</span>' : '') +
      (todos ? '  <span class="tool-diffstat">' + todos.done + '/' + todos.total + '</span>' : '') +
      (isAgent ? '  <span class="tool-diffstat tool-substat"></span>' : '') +
      (previewable ? '  <button class="tool-preview" title="Open in the Artifacts panel">▶ Preview</button>' : '') +
      '  <span class="tool-caret">▾</span>' +
      '</div>' +
      '<div class="tool-body">' + inputSection + '</div>';
    card.querySelector('.tool-head').addEventListener('click', () =>
      card.classList.toggle('open')
    );
    if (previewable) {
      card.querySelector('.tool-preview').addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.opts.onOpenArtifact) this.opts.onOpenArtifact({ path: previewable });
      });
      if (!this.artifacts.includes(previewable)) this.artifacts.push(previewable);
      if (this.opts.onArtifact) {
        this.opts.onArtifact({ path: previewable, live: !this.replaying });
      }
    }
    st.contentEl.appendChild(card);
    this.toolCards.set(toolUse.id, {
      card,
      body: card.querySelector('.tool-body'),
      tool: toolUse.name,
    });
  }

  /**
   * Read-only body for a question/plan replayed from a saved chat — the
   * questions that were asked, or the plan that was proposed.
   */
  _recordSection(toolUse) {
    const input = toolUse.input || {};
    if (toolUse.name === 'AskUserQuestion') {
      let html = '';
      for (const q of input.questions || []) {
        if (!q) continue;
        const options = Array.isArray(q.options) ? q.options : [];
        html +=
          '<div class="ask-q">' +
          (q.header ? '<div class="ask-chip">' + esc(q.header) + '</div>' : '') +
          '<div class="ask-question">' + esc(q.question) + '</div>' +
          (options.length
            ? '<div class="ask-note">' +
              options.map((o) => esc(o && o.label)).join(' · ') + '</div>'
            : '') +
          '</div>';
      }
      return html ? '<div class="tool-section">' + html + '</div>' : null;
    }
    if (toolUse.name === 'ExitPlanMode' && typeof input.plan === 'string' && input.plan) {
      return '<div class="tool-section"><div class="plan-body">' +
        md.render(input.plan) + '</div></div>';
    }
    return null;
  }

  /** Build a red/green diff for edit-like tools; null for everything else. */
  _buildDiffSection(name, input) {
    input = input || {};
    try {
      if (name === 'Edit') {
        if (input.old_string == null && input.new_string == null) return null;
        return renderDiffHtml(input.old_string || '', input.new_string || '');
      }
      if (name === 'MultiEdit' && Array.isArray(input.edits)) {
        let html = '';
        let added = 0;
        let removed = 0;
        input.edits.forEach((e, idx) => {
          const d = renderDiffHtml(e.old_string || '', e.new_string || '');
          const nums = d.stat.match(/\d+/g) || [];
          added += Number(nums[0] || 0);
          removed += Number(nums[1] || 0);
          html += (idx ? '<div class="diff-sep">edit ' + (idx + 1) + '</div>' : '') + d.html;
        });
        const stat = '<span class="diff-add">+' + added + '</span> <span class="diff-del">−' + removed + '</span>';
        return { html, stat };
      }
      if (name === 'Write' && typeof input.content === 'string') {
        // A write is an all-new file: render every line as an addition.
        return renderDiffHtml('', input.content);
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  _updateToolCard(toolUseId, result) {
    const t = this.toolCards.get(toolUseId);
    if (!t) return;
    const isErr = !!result.is_error;
    t.card.dataset.status = isErr ? 'error' : 'done';
    // The task list already shows its own state — its "ok" result adds nothing.
    if (t.tool === 'TodoWrite' && !isErr) return;
    let text = resultText(result.content);
    // A replayed question: show what was answered, not the raw JSON payload.
    if (t.tool === 'AskUserQuestion' && !isErr) {
      const answered = answersHtml(text);
      if (answered) {
        t.body.insertAdjacentHTML('beforeend', answered);
        return;
      }
    }
    if (text.length > 4000) text = text.slice(0, 4000) + '\n… (truncated)';
    const sec = document.createElement('div');
    sec.className = 'tool-section';
    sec.innerHTML =
      '<div class="tool-section-h">' +
      (isErr ? 'Error' : 'Result') +
      '</div><pre>' +
      esc(text || '(no output)') +
      '</pre>';
    t.body.appendChild(sec);
  }

  // -- interactive cards: questions, plans, permissions ------------------

  /** Put a standalone card into the conversation flow. */
  _appendCard(node) {
    this._hideEmpty();
    this._removeTyping(); // we're waiting on the user now, not on Claude
    this._setActivity('Waiting for you…');
    // Prompts slide up in a dock pinned above the composer so they can't
    // scroll out of sight; once answered they settle into the conversation.
    this.dockEl.appendChild(node);
    this.dockEl.style.display = '';
    this.container.classList.add('has-prompt');
    if (!this.pendingCard || !this.pendingCard.isConnected ||
        this.pendingCard.classList.contains('answered')) {
      this.pendingCard = node;
      node.focus();
    }
    this._autoscroll(true);
    return node;
  }

  /** Move an answered card out of the dock, into the conversation record. */
  _settleCard(card) {
    card.classList.add('answered');
    if (card.parentNode === this.dockEl) this.scrollEl.appendChild(card);
    const next = this.dockEl.querySelector('.ask-card:not(.answered)');
    this.pendingCard = next || null;
    if (next) {
      next.focus();
    } else {
      this.dockEl.style.display = 'none';
      this.container.classList.remove('has-prompt');
      this.input.focus();
    }
    if (this.busy) { this._showTyping(); this._setActivity('Working…'); }
    this._autoscroll(true);
  }

  /**
   * Route a request from the main process to the right inline card.
   * `respond` takes { allow, remember, updatedInput, message }.
   */
  handlePermission(req, respond) {
    if (this.speakTurn && !this.replaying) {
      this.speaker.flush();
      this.speaker.say(req && req.kind === 'question' ? 'I have a question for you. It\'s on screen.'
        : req && req.kind === 'plan' ? 'Here\'s my plan. Have a look.'
          : 'I need your permission to continue.');
    }
    if (req && req.kind === 'question') return this.addQuestionCard(req, respond);
    if (req && req.kind === 'plan') return this.addPlanCard(req, respond);
    return this.addPermissionCard(req, respond);
  }

  _questionBlockHtml(q, qi) {
    const options = Array.isArray(q.options) ? q.options : [];
    let html = '<div class="ask-q" data-qi="' + qi + '">';
    if (q.header) html += '<div class="ask-chip">' + esc(q.header) + '</div>';
    html += '<div class="ask-question">' + esc(q.question || '') + '</div>';
    if (q.multiSelect) html += '<div class="ask-note">Pick any that apply</div>';
    html += '<div class="ask-options">';
    options.forEach((o, oi) => {
      html +=
        '<button class="ask-opt" data-qi="' + qi + '" data-oi="' + oi + '">' +
        '<span class="ask-key">' + (oi + 1) + '</span>' +
        '<span class="ask-opt-main">' +
        '<span class="ask-opt-label">' + esc(o && o.label) + '</span>' +
        (o && o.description
          ? '<span class="ask-opt-desc">' + esc(o.description) + '</span>' : '') +
        '</span>' +
        (o && o.preview ? '<span class="ask-opt-eye" title="Has a preview">👁</span>' : '') +
        '<span class="ask-tick">✓</span></button>';
    });
    // "Other" is always offered — the model is told not to add one itself.
    html +=
      '<button class="ask-opt ask-opt-other" data-qi="' + qi + '" data-oi="other">' +
      '<span class="ask-key">' + (options.length + 1) + '</span>' +
      '<span class="ask-opt-main">' +
      '<span class="ask-opt-label">Something else…</span>' +
      '<span class="ask-opt-desc">Type your own answer</span></span>' +
      '<span class="ask-tick">✓</span></button>';
    html += '</div>';
    html += '<input class="ask-other-input" data-qi="' + qi +
      '" placeholder="Your answer…" style="display:none" />';
    html += '<div class="ask-preview" data-qi="' + qi + '" style="display:none"></div>';
    html += '</div>';
    return html;
  }

  /**
   * Render an AskUserQuestion prompt as selectable options inside the
   * conversation. Answers are handed back as the tool's `answers` map
   * (question text -> answer; multi-select answers comma-separated).
   */
  addQuestionCard(req, respond) {
    const questions = (((req.input || {}).questions) || []).filter(Boolean);
    if (!questions.length) {
      respond({ allow: true });
      return null;
    }

    const card = document.createElement('div');
    card.className = 'ask-card';
    card.tabIndex = -1;
    let html =
      '<div class="ask-head"><span class="ask-icon">✳</span>' +
      '<span class="ask-title">Claude needs your input</span>' +
      '<span class="ask-step"></span></div>';
    // Several questions are shown one at a time, as slides with step tabs.
    const multi = questions.length > 1;
    let cur = 0;
    if (multi) {
      card.classList.add('ask-slides');
      html += '<div class="ask-tabs">';
      questions.forEach((q, qi) => {
        html += '<button class="ask-tab" data-qi="' + qi + '">' +
          '<span class="ask-tab-n">' + (qi + 1) + '</span>' +
          '<span class="ask-tab-t">' + esc(q.header || 'Question ' + (qi + 1)) + '</span></button>';
      });
      html += '</div>';
    }
    html += '<div class="ask-stage">';
    questions.forEach((q, qi) => { html += this._questionBlockHtml(q, qi); });
    html += '</div>';
    html +=
      '<div class="ask-actions">' +
      '<span class="ask-hint">' + (multi
        ? '1–9 to choose · ←/→ or Enter to move · Esc to skip'
        : '1–9 to choose · Enter to submit · Esc to skip') + '</span>' +
      '<button class="ask-btn ghost ask-skip">Skip</button>' +
      (multi ? '<button class="ask-btn ghost ask-back">← Back</button>' +
        '<button class="ask-btn primary ask-next">Next →</button>' : '') +
      '<button class="ask-btn primary ask-submit" disabled>Submit</button>' +
      '</div>';
    card.innerHTML = html;

    const submitBtn = card.querySelector('.ask-submit');
    const sel = questions.map(() => ({ picked: new Set(), other: '' }));
    let settled = false;

    const optionsFor = (qi) =>
      (Array.isArray(questions[qi].options) ? questions[qi].options : []);

    // Current answer for one question: display text + any preview to show.
    const answerFor = (qi) => {
      const labels = [];
      let preview = '';
      for (const oi of sel[qi].picked) {
        if (oi === 'other') {
          const typed = sel[qi].other.trim();
          if (typed) labels.push(typed);
        } else {
          const o = optionsFor(qi)[oi];
          if (!o) continue;
          if (o.label) labels.push(o.label);
          if (o.preview && !preview) preview = o.preview;
        }
      }
      return { text: labels.join(', '), preview };
    };
    const complete = () => questions.every((_q, qi) => !!answerFor(qi).text);

    const refresh = () => {
      card.querySelectorAll('.ask-opt').forEach((b) => {
        const qi = Number(b.dataset.qi);
        const oi = b.dataset.oi === 'other' ? 'other' : Number(b.dataset.oi);
        b.classList.toggle('picked', sel[qi].picked.has(oi));
      });
      questions.forEach((_q, qi) => {
        const otherInput = card.querySelector('.ask-other-input[data-qi="' + qi + '"]');
        if (otherInput) otherInput.style.display = sel[qi].picked.has('other') ? '' : 'none';
        const prev = card.querySelector('.ask-preview[data-qi="' + qi + '"]');
        if (prev) {
          const p = answerFor(qi).preview;
          prev.innerHTML = p
            ? '<div class="ask-preview-h">Preview</div><pre>' + esc(p) + '</pre>' : '';
          prev.style.display = p ? '' : 'none';
        }
      });
      submitBtn.disabled = !complete();
      if (multi) {
        const last = cur === questions.length - 1;
        card.querySelectorAll('.ask-q').forEach((qEl) => {
          qEl.classList.toggle('current', Number(qEl.dataset.qi) === cur);
        });
        card.querySelectorAll('.ask-tab').forEach((t) => {
          const qi = Number(t.dataset.qi);
          t.classList.toggle('current', qi === cur);
          t.classList.toggle('done', !!answerFor(qi).text);
        });
        card.querySelector('.ask-step').textContent = (cur + 1) + ' of ' + questions.length;
        card.querySelector('.ask-back').disabled = cur === 0;
        card.querySelector('.ask-next').style.display = last ? 'none' : '';
        card.querySelector('.ask-next').disabled = !answerFor(cur).text;
        submitBtn.style.display = last ? '' : 'none';
      }
    };

    const go = (qi, dir) => {
      if (!multi || settled) return;
      const next = Math.max(0, Math.min(questions.length - 1, qi));
      if (next === cur) return;
      card.dataset.dir = dir || (next > cur ? 'fwd' : 'back');
      cur = next;
      refresh();
      card.focus();
    };

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      respond(payload);
      this._settleCard(card);
    };

    const submit = () => {
      if (settled || !complete()) return;
      const answers = {};
      const annotations = {};
      questions.forEach((q, qi) => {
        const a = answerFor(qi);
        answers[q.question] = a.text;
        if (a.preview) annotations[q.question] = { preview: a.preview };
      });
      const updatedInput = Object.assign({}, req.input, { answers });
      if (Object.keys(annotations).length) updatedInput.annotations = annotations;
      let summary = '';
      questions.forEach((q) => {
        summary +=
          '<div class="ask-answered"><span class="ask-answered-ico">✓</span>' +
          '<span class="ask-answered-q">' + esc(q.header || q.question) + '</span>' +
          '<span class="ask-answered-a">' + esc(answers[q.question]) + '</span></div>';
      });
      finish({ allow: true, updatedInput });
      card.innerHTML = summary;
    };

    const skip = () => {
      if (settled) return;
      finish({
        allow: false,
        message:
          'The user skipped the question. Continue with a reasonable default, ' +
          'or ask again in the chat.',
      });
      card.innerHTML =
        '<div class="ask-answered skipped"><span class="ask-answered-ico">–</span>' +
        '<span class="ask-answered-q">Question skipped</span></div>';
    };

    card.querySelectorAll('.ask-opt').forEach((b) => {
      b.addEventListener('click', () => {
        if (settled) return;
        const qi = Number(b.dataset.qi);
        const oi = b.dataset.oi === 'other' ? 'other' : Number(b.dataset.oi);
        const st = sel[qi];
        if (questions[qi].multiSelect) {
          if (st.picked.has(oi)) st.picked.delete(oi);
          else st.picked.add(oi);
        } else {
          st.picked.clear();
          st.picked.add(oi);
        }
        refresh();
        if (st.picked.has('other')) {
          const otherInput = card.querySelector('.ask-other-input[data-qi="' + qi + '"]');
          if (otherInput) otherInput.focus();
        } else if (!questions[qi].multiSelect && questions.length === 1) {
          submit(); // one question, one choice — no extra confirmation step
        } else if (!questions[qi].multiSelect && multi && qi < questions.length - 1) {
          setTimeout(() => { if (cur === qi) go(qi + 1); }, 180); // slide on
        }
      });
    });

    card.querySelectorAll('.ask-other-input').forEach((input) => {
      input.addEventListener('input', () => {
        sel[Number(input.dataset.qi)].other = input.value;
        refresh();
      });
      input.addEventListener('keydown', (e) => {
        e.stopPropagation(); // digits are shortcuts on the card, not here
        if (e.key === 'Enter') {
          e.preventDefault();
          advance();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          card.focus();
        }
      });
    });

    // Enter moves to the next slide, and submits from the last one.
    const advance = () => {
      if (multi && cur < questions.length - 1) {
        if (answerFor(cur).text) go(cur + 1);
        return;
      }
      if (multi && !complete()) {
        return go(questions.findIndex((_q, qi) => !answerFor(qi).text));
      }
      submit();
    };

    card.querySelector('.ask-submit').addEventListener('click', submit);
    card.querySelector('.ask-skip').addEventListener('click', skip);
    if (multi) {
      card.querySelector('.ask-back').addEventListener('click', () => go(cur - 1));
      card.querySelector('.ask-next').addEventListener('click', () => go(cur + 1));
      card.querySelectorAll('.ask-tab').forEach((t) => {
        t.addEventListener('click', () => go(Number(t.dataset.qi)));
      });
    }

    card.addEventListener('keydown', (e) => {
      if (settled) return;
      if (e.key === 'Escape') { e.preventDefault(); return skip(); }
      if (e.key === 'Enter') { e.preventDefault(); return advance(); }
      if (multi && e.key === 'ArrowRight') { e.preventDefault(); return go(cur + 1); }
      if (multi && e.key === 'ArrowLeft') { e.preventDefault(); return go(cur - 1); }
      if (!/^[1-9]$/.test(e.key)) return;
      // Digits apply to the slide on screen, or else to the first question
      // still waiting for an answer.
      let target = multi ? cur : questions.findIndex((_q, qi) => !answerFor(qi).text);
      if (target === -1) target = questions.length - 1;
      const btns = card.querySelectorAll('.ask-q[data-qi="' + target + '"] .ask-opt');
      const hit = btns[Number(e.key) - 1];
      if (hit) { e.preventDefault(); hit.click(); }
    });

    this._appendCard(card);
    refresh();
    return card;
  }

  /** Render an ExitPlanMode request: the plan, plus how to proceed. */
  addPlanCard(req, respond) {
    const input = req.input || {};
    const plan = typeof input.plan === 'string' ? input.plan : '';
    const card = document.createElement('div');
    card.className = 'ask-card plan-card';
    card.tabIndex = -1;
    card.innerHTML =
      '<div class="ask-head"><span class="ask-icon">📋</span>' +
      '<span class="ask-title">Claude finished planning</span></div>' +
      (plan ? '<div class="plan-body">' + md.render(plan) + '</div>' : '') +
      '<div class="ask-options">' +
      '<button class="ask-opt" data-act="go"><span class="ask-key">1</span>' +
      '<span class="ask-opt-main"><span class="ask-opt-label">Yes, start building</span>' +
      '<span class="ask-opt-desc">Claude asks before each file change or command</span>' +
      '</span><span class="ask-tick">✓</span></button>' +
      '<button class="ask-opt" data-act="auto"><span class="ask-key">2</span>' +
      '<span class="ask-opt-main"><span class="ask-opt-label">Yes, and auto-accept edits</span>' +
      '<span class="ask-opt-desc">File edits apply without asking — commands still ask</span>' +
      '</span><span class="ask-tick">✓</span></button>' +
      '<button class="ask-opt" data-act="no"><span class="ask-key">3</span>' +
      '<span class="ask-opt-main"><span class="ask-opt-label">No, keep planning</span>' +
      '<span class="ask-opt-desc">Stay in plan mode and refine the approach</span>' +
      '</span><span class="ask-tick">✓</span></button>' +
      '</div>' +
      '<div class="ask-hint">1–3 to choose · Esc to keep planning</div>';

    const planBody = card.querySelector('.plan-body');
    if (planBody) this._decorateCode(planBody);

    let settled = false;
    const close = (statusHtml) => {
      const opts = card.querySelector('.ask-options');
      if (opts) opts.remove();
      const hint = card.querySelector('.ask-hint');
      if (hint) hint.remove();
      const status = document.createElement('div');
      status.className = 'ask-answered';
      status.innerHTML = statusHtml;
      card.appendChild(status);
      this._settleCard(card);
    };

    const decide = (act) => {
      if (settled) return;
      settled = true;
      if (act === 'no') {
        respond({
          allow: false,
          message:
            'The user wants to keep planning. Revise the plan based on their ' +
            'feedback and propose it again.',
        });
        close('<span class="ask-answered-ico">–</span>' +
          '<span class="ask-answered-q">Still planning</span>');
        return;
      }
      respond({ allow: true });
      const mode = act === 'auto' ? 'acceptEdits' : 'default';
      this.setPermissionMode(mode);
      if (this.opts.onSetPermissionMode) this.opts.onSetPermissionMode(mode);
      close('<span class="ask-answered-ico">✓</span>' +
        '<span class="ask-answered-q">Plan approved</span>' +
        '<span class="ask-answered-a">' +
        (act === 'auto' ? 'auto-accepting edits' : 'asking before each action') +
        '</span>');
    };

    card.querySelectorAll('.ask-opt').forEach((b) => {
      b.addEventListener('click', () => decide(b.dataset.act));
    });
    card.addEventListener('keydown', (e) => {
      if (settled) return;
      if (e.key === 'Escape') { e.preventDefault(); return decide('no'); }
      const map = { 1: 'go', 2: 'auto', 3: 'no' };
      if (map[e.key]) { e.preventDefault(); decide(map[e.key]); }
    });

    this._appendCard(card);
    return card;
  }

  /** Render a tool permission prompt inline, with a diff when it's an edit. */
  addPermissionCard(req, respond) {
    const friendly = permFriendly(req.toolName);
    const diff = this._buildDiffSection(req.toolName, req.input);
    const detail = diff ? '' : permInputText(req);
    const toolLabel = req.displayName || req.toolName || 'this tool';

    const card = document.createElement('div');
    card.className = 'ask-card perm-inline';
    card.tabIndex = -1;
    card.innerHTML =
      '<div class="ask-head"><span class="ask-icon">🔐</span>' +
      '<span class="ask-title">' + esc(req.title || friendly.title) + '</span>' +
      (diff ? '<span class="tool-diffstat">' + diff.stat + '</span>' : '') +
      '</div>' +
      '<div class="ask-desc">' + esc(req.description || friendly.desc) + '</div>' +
      (diff ? '<div class="perm-detail">' + diff.html + '</div>' : '') +
      (detail ? '<div class="perm-detail"><pre>' + esc(detail) + '</pre></div>' : '') +
      '<div class="ask-options">' +
      '<button class="ask-opt" data-act="allow"><span class="ask-key">1</span>' +
      '<span class="ask-opt-main"><span class="ask-opt-label">Yes</span>' +
      '<span class="ask-opt-desc">Allow this one action</span></span>' +
      '<span class="ask-tick">✓</span></button>' +
      '<button class="ask-opt" data-act="always"><span class="ask-key">2</span>' +
      '<span class="ask-opt-main"><span class="ask-opt-label">Yes, and don\'t ask again</span>' +
      '<span class="ask-opt-desc">Allow ' + esc(toolLabel) + ' for the rest of this chat</span>' +
      '</span><span class="ask-tick">✓</span></button>' +
      '<button class="ask-opt" data-act="deny"><span class="ask-key">3</span>' +
      '<span class="ask-opt-main"><span class="ask-opt-label">No</span>' +
      '<span class="ask-opt-desc">Decline, and optionally say what to do instead</span>' +
      '</span><span class="ask-tick">✓</span></button>' +
      '</div>' +
      '<textarea class="perm-feedback" rows="2" style="display:none" ' +
      'placeholder="What should Claude do instead? (optional — Enter to send)"></textarea>' +
      '<div class="ask-hint">1–3 to choose · Esc to decline</div>';

    let settled = false;
    const close = (ok, note) => {
      const opts = card.querySelector('.ask-options');
      if (opts) opts.remove();
      const hint = card.querySelector('.ask-hint');
      if (hint) hint.remove();
      const fb = card.querySelector('.perm-feedback');
      if (fb) fb.remove();
      const status = document.createElement('div');
      status.className = 'ask-answered' + (ok ? '' : ' skipped');
      status.innerHTML =
        '<span class="ask-answered-ico">' + (ok ? '✓' : '✕') + '</span>' +
        '<span class="ask-answered-q">' + (ok ? 'Allowed' : 'Declined') + '</span>' +
        (note ? '<span class="ask-answered-a">' + esc(note) + '</span>' : '');
      card.appendChild(status);
      // The diff/command stays readable in the record, but folded away.
      card.querySelectorAll('.perm-detail').forEach((d) => d.classList.add('settled'));
      this._settleCard(card);
    };

    const allow = (remember) => {
      if (settled) return;
      settled = true;
      respond({ allow: true, remember: !!remember });
      close(true, remember ? 'always allow ' + toolLabel + ' in this chat' : '');
    };
    const deny = (message) => {
      if (settled) return;
      settled = true;
      respond({
        allow: false,
        message: message || 'The user declined this action.',
      });
      close(false, message || '');
    };

    const feedback = card.querySelector('.perm-feedback');
    card.querySelectorAll('.ask-opt').forEach((b) => {
      b.addEventListener('click', () => {
        const act = b.dataset.act;
        if (act === 'allow') return allow(false);
        if (act === 'always') return allow(true);
        // "No" first offers a chance to redirect Claude; Esc or empty = plain deny.
        feedback.style.display = '';
        feedback.focus();
      });
    });
    feedback.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const txt = feedback.value.trim();
        deny(txt ? 'The user declined and said: ' + txt : '');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        deny('');
      }
    });
    card.addEventListener('keydown', (e) => {
      if (settled) return;
      if (e.key === 'Escape') { e.preventDefault(); return deny(''); }
      if (e.key === '1') { e.preventDefault(); return allow(false); }
      if (e.key === '2') { e.preventDefault(); return allow(true); }
      if (e.key === '3') {
        e.preventDefault();
        feedback.style.display = '';
        feedback.focus();
      }
    });

    this._appendCard(card);
    return card;
  }

  _addNotice(text, isError) {
    const el = document.createElement('div');
    el.className = 'chat-notice' + (isError ? ' error' : '');
    el.textContent = text;
    this.scrollEl.appendChild(el);
    this._autoscroll(true);
  }

  _showTyping() {
    if (this.typingEl) return;
    this._hideEmpty();
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML =
      '<div class="avatar">✳</div>' +
      '<div class="typing"><span></span><span></span><span></span></div>';
    this.scrollEl.appendChild(el);
    this.typingEl = el;
    this._autoscroll(true);
  }

  _removeTyping() {
    if (this.typingEl) {
      this.typingEl.remove();
      this.typingEl = null;
    }
  }

  _autoscroll(force) {
    const el = this.scrollEl;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    if (force || nearBottom) el.scrollTop = el.scrollHeight;
    this._updateJump();
  }

  _updateJump() {
    if (!this.jumpBtn) return;
    const el = this.scrollEl;
    const away = el.scrollHeight - el.scrollTop - el.clientHeight > 220;
    this.jumpBtn.style.display = away ? '' : 'none';
  }

  /** Add a hover "Copy" button to every code block in a rendered body. */
  _decorateCode(bodyEl) {
    bodyEl.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.code-copy')) return;
      const lang = (pre.dataset.lang || '').toLowerCase();
      if (lang) {
        const tag = document.createElement('span');
        tag.className = 'code-lang';
        tag.textContent = lang;
        pre.appendChild(tag);
      }
      if ((lang === 'html' || lang === 'svg') && this.opts.onOpenArtifact) {
        const pv = document.createElement('button');
        pv.className = 'code-copy code-preview';
        pv.textContent = '▶ Preview';
        pv.addEventListener('click', (e) => {
          e.stopPropagation();
          const code = pre.querySelector('code');
          this.opts.onOpenArtifact({
            inline: { kind: lang, code: code ? code.textContent : '' },
          });
        });
        pre.appendChild(pv);
      }
      const btn = document.createElement('button');
      btn.className = 'code-copy';
      btn.textContent = 'Copy';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const code = pre.querySelector('code');
        copyToClipboard(code ? code.textContent : pre.textContent);
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
      });
      pre.appendChild(btn);
    });
  }
}

module.exports = { ChatView, permFriendly, permInputText, artifactKind, md, highlightCode };
