'use strict';

// ChatView renders a ChatGPT-style conversation: user bubbles, streaming
// assistant messages with markdown, collapsible thinking, and tool-use cards.
// It is UI-only — the host wires sending/interrupting via callbacks.

const MarkdownIt = require('markdown-it');
const { clipboard } = require('electron');

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

const md = new MarkdownIt({
  html: false, // raw HTML in model output is escaped, not rendered
  linkify: true,
  breaks: true,
});

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
      return { label: 'Ran a sub-agent', detail: input.description || '' };
    case 'TodoWrite':
      return { label: 'Updated the task list', detail: '' };
    case 'KillShell':
      return { label: 'Stopped a command', detail: '' };
    default:
      return { label: name || 'Tool', detail: '' };
  }
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
      '  </div>' +
      '</div>' +
      '<button class="jump-bottom" title="Jump to latest" style="display:none">↓</button>' +
      '<div class="composer">' +
      '  <div class="composer-toolbar">' +
      '    <label class="cc-model" title="Model in use">' +
      '      <span class="cc-model-dot"></span>' +
      '      <select class="cc-model-select"><option value="">default model</option></select>' +
      '    </label>' +
      '    <label class="cc-mode" title="How Claude asks before editing files or running commands">' +
      '      <span class="cc-mode-dot"></span>' +
      '      <select class="cc-mode-select">' +
      '        <option value="default">Ask each time</option>' +
      '        <option value="acceptEdits">Auto-accept edits</option>' +
      '        <option value="plan">Plan mode</option>' +
      '      </select>' +
      '    </label>' +
      '    <button class="cc-tool-btn cc-skills-btn" title="Skills & slash commands">⚡ Skills</button>' +
      '    <button class="cc-tool-btn cc-files-btn" title="Attach a file">📎 File</button>' +
      '    <button class="cc-tool-btn cc-caps-btn" title="Available tools & capabilities">ⓘ Capabilities</button>' +
      '    <span class="cc-usage" title="Tokens and estimated cost this session" style="display:none"></span>' +
      '    <div class="cc-popover" style="display:none"></div>' +
      '  </div>' +
      '  <div class="cc-ac" style="display:none"></div>' +
      '  <div class="composer-inner">' +
      '    <textarea class="composer-input" rows="1" placeholder="Message Claude…"></textarea>' +
      '    <button class="composer-btn" title="Send">▲</button>' +
      '  </div>' +
      '  <div class="composer-hint">Enter to send · Shift+Enter for a new line</div>' +
      '</div>';

    this.scrollEl = container.querySelector('.chat-scroll');
    this.emptyEl = container.querySelector('.chat-empty');
    this.jumpBtn = container.querySelector('.jump-bottom');
    this.jumpBtn.addEventListener('click', () => {
      this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
      this._updateJump();
    });
    this.scrollEl.addEventListener('scroll', () => this._updateJump());
    this.input = container.querySelector('.composer-input');
    this.sendBtn = container.querySelector('.composer-btn');
    this.modelSelect = container.querySelector('.cc-model-select');
    this.modeSelect = container.querySelector('.cc-mode-select');
    this.skillsBtn = container.querySelector('.cc-skills-btn');
    this.filesBtn = container.querySelector('.cc-files-btn');
    this.capsBtn = container.querySelector('.cc-caps-btn');
    this.acEl = container.querySelector('.cc-ac');
    this.ac = { open: false, items: [], active: 0, kind: '', start: 0, end: 0, token: '' };
    this.usageEl = container.querySelector('.cc-usage');
    this.popover = container.querySelector('.cc-popover');
    this.usage = { costUsd: 0, inTokens: 0, outTokens: 0, cacheReadTokens: 0, turns: 0 };

    this.modelSelect.addEventListener('change', () => {
      if (this.opts.onSetModel) this.opts.onSetModel(this.modelSelect.value);
      this._hidePopover();
    });
    this.modeSelect.addEventListener('change', () => {
      const mode = this.modeSelect.value;
      this._reflectMode(mode);
      if (this.opts.onSetPermissionMode) this.opts.onSetPermissionMode(mode);
      this._hidePopover();
    });
    this.skillsBtn.addEventListener('click', () => this._toggleSkills());
    this.capsBtn.addEventListener('click', () => this._toggleCaps());
    this.filesBtn.addEventListener('click', async () => {
      this._hidePopover();
      if (!this.opts.onPickFiles) return;
      const paths = await this.opts.onPickFiles();
      if (paths && paths.length) this._insertFiles(paths);
    });
    document.addEventListener('click', (e) => {
      if (!this.popover.contains(e.target) &&
          e.target !== this.skillsBtn && e.target !== this.capsBtn) {
        this._hidePopover();
      }
    });

    this.sendBtn.addEventListener('click', () => this._onButton());
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
      }
    });
    this.input.addEventListener('input', () => {
      this._growInput();
      this._updateAutocomplete();
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
    if (this.busy) {
      if (this.opts.onInterrupt) this.opts.onInterrupt();
    } else {
      this._send();
    }
  }

  _send() {
    if (this.busy) return;
    const text = this.input.value.trim();
    if (!text) return;
    this.addUserBubble(text);
    this.input.value = '';
    this._growInput();
    this.setBusy(true);
    if (this.opts.onSend) this.opts.onSend(text);
  }

  focusInput() {
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
  setPermissionMode(mode) {
    if (!mode || !this.modeSelect) return;
    const known = [...this.modeSelect.options].some((o) => o.value === mode);
    if (known) this.modeSelect.value = mode;
    this._reflectMode(this.modeSelect.value);
  }

  /** Update the mode indicator colour + a one-line notice when it changes. */
  _reflectMode(mode) {
    if (this.meta.permissionMode === mode) return;
    const first = this.meta.permissionMode === undefined;
    this.meta.permissionMode = mode;
    if (this.modeSelect) this.modeSelect.dataset.mode = mode;
    if (first) return; // don't announce the initial state
    if (mode === 'plan') {
      this._addNotice('Plan mode on — Claude will propose a plan without changing files.');
    } else if (mode === 'acceptEdits') {
      this._addNotice('Auto-accept edits on — file edits apply without asking (commands still ask).');
    } else {
      this._addNotice('Back to asking before each action.');
    }
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

  _insertFiles(paths) {
    const refs = paths.map((p) => '@' + p).join(' ');
    const cur = this.input.value;
    this.input.value = cur && !cur.endsWith(' ') ? cur + ' ' + refs + ' ' : cur + refs + ' ';
    this._growInput();
    this.focusInput();
  }

  setBusy(busy) {
    this.busy = busy;
    this.sendBtn.classList.toggle('busy', busy);
    this.sendBtn.innerHTML = busy ? '■' : '▲';
    this.sendBtn.title = busy ? 'Stop' : 'Send';
    if (busy) this._showTyping();
    else this._removeTyping();
  }

  // -- incoming SDK messages -------------------------------------------

  handleSdkMessage(msg) {
    if (!msg || !msg.type) return;
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
    } else if (msg.type === 'system' && msg.subtype === 'permission_denied') {
      this._addNotice('Action declined: ' + (msg.message || ''), true);
    }
  }

  /** Render a previously saved conversation (array of SessionMessage). */
  renderHistory(messages) {
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
          if (txt.trim() && !results.length) this.addUserBubble(txt);
          for (const r of results) this._updateToolCard(r.tool_use_id, r);
        }
      } else if (m.type === 'assistant') {
        this._onAssistant({ message: inner });
      }
    }
    this._autoscroll(true);
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
        this._renderText(this.streaming);
      } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
        this.streaming.thinking += d.thinking;
        this._renderThinking(this.streaming);
      }
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
      if (b.type === 'tool_use') this._addToolCard(st, b);
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
    this._autoscroll();
  }

  _onResult(msg) {
    this.setBusy(false);
    this.streaming = null;
    this._accrueUsage(msg);
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

  // -- rendering --------------------------------------------------------

  _hideEmpty() {
    if (this.emptyEl) this.emptyEl.style.display = 'none';
  }

  addUserBubble(text) {
    this._hideEmpty();
    const el = document.createElement('div');
    el.className = 'msg user';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
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
    const info = toolSummary(toolUse.name, toolUse.input);
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.dataset.status = 'running';

    const diff = this._buildDiffSection(toolUse.name, toolUse.input);

    let inputSection;
    if (diff) {
      inputSection =
        '<div class="tool-section"><div class="tool-section-h">Changes ' + diff.stat +
        '</div>' + diff.html + '</div>';
    } else {
      const inputStr =
        toolUse.input && typeof toolUse.input === 'object'
          ? JSON.stringify(toolUse.input, null, 2)
          : String(toolUse.input == null ? '' : toolUse.input);
      inputSection =
        '<div class="tool-section"><div class="tool-section-h">Input</div><pre>' +
        esc(inputStr) + '</pre></div>';
    }

    // Edits are worth seeing without a click — open the card by default.
    if (diff) card.classList.add('open');

    card.innerHTML =
      '<div class="tool-head">' +
      '  <span class="tool-dot"></span>' +
      '  <span class="tool-label">' + esc(info.label) + '</span>' +
      '  <span class="tool-detail-text">' + esc(info.detail) + '</span>' +
      (diff ? '  <span class="tool-diffstat">' + diff.stat + '</span>' : '') +
      '  <span class="tool-caret">▾</span>' +
      '</div>' +
      '<div class="tool-body">' + inputSection + '</div>';
    card.querySelector('.tool-head').addEventListener('click', () =>
      card.classList.toggle('open')
    );
    st.contentEl.appendChild(card);
    this.toolCards.set(toolUse.id, { card, body: card.querySelector('.tool-body') });
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
    let text = resultText(result.content);
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

module.exports = { ChatView };
