'use strict';

const { ipcRenderer, clipboard } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { pathToFileURL } = require('url');
const nodePath = require('path');
const { ChatView, permFriendly, permInputText, artifactKind, md, highlightCode } = require('./chatview.js');
const { Speaker, allVoices } = require('./voice.js');
const { McpPanel } = require('./mcp.js');

// ---------------------------------------------------------------------------
// Terminal theme
// ---------------------------------------------------------------------------

// One palette per app theme, so the terminal doesn't stay dark in light mode.
const TERM_THEMES = {
  dark: {
    background: '#1c1a17',
    foreground: '#ece8e1',
    cursor: '#d97757',
    cursorAccent: '#1c1a17',
    selectionBackground: 'rgba(217, 119, 87, 0.32)',
    black: '#1c1a17', red: '#e86f6f', green: '#7fb069', yellow: '#e0b341',
    blue: '#6c9bd1', magenta: '#c98bdb', cyan: '#5fb3b3', white: '#ece8e1',
    brightBlack: '#6b645a', brightRed: '#ff8a8a', brightGreen: '#9bd17f',
    brightYellow: '#f0c860', brightBlue: '#8fb8e8', brightMagenta: '#dba6e8',
    brightCyan: '#7fd1d1', brightWhite: '#ffffff',
  },
  light: {
    background: '#faf9f7',
    foreground: '#26231f',
    cursor: '#c4633f',
    cursorAccent: '#faf9f7',
    selectionBackground: 'rgba(196, 99, 63, 0.24)',
    black: '#26231f', red: '#c04141', green: '#4f8a3a', yellow: '#9a6b0e',
    blue: '#3c6fa8', magenta: '#8e4bab', cyan: '#2f7f7f', white: '#3f3a34',
    brightBlack: '#6b645a', brightRed: '#d95757', brightGreen: '#5fa347',
    brightYellow: '#b6821a', brightBlue: '#4f87c4', brightMagenta: '#a35fc0',
    brightCyan: '#3f9c9c', brightWhite: '#26231f',
  },
  contrast: {
    background: '#000000',
    foreground: '#ffffff',
    cursor: '#ff9a6a',
    cursorAccent: '#000000',
    selectionBackground: 'rgba(255, 154, 106, 0.4)',
    black: '#000000', red: '#ff8a8a', green: '#8fe07a', yellow: '#ffd75f',
    blue: '#8fb8e8', magenta: '#e0a6ff', cyan: '#7fe0e0', white: '#ffffff',
    brightBlack: '#9a938a', brightRed: '#ffb3b3', brightGreen: '#b6ff9e',
    brightYellow: '#ffe98a', brightBlue: '#b3d4ff', brightMagenta: '#f0c6ff',
    brightCyan: '#adffff', brightWhite: '#ffffff',
  },
};

function termTheme() {
  return TERM_THEMES[settings.theme] || TERM_THEMES.dark;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  sessions: [],
  open: new Map(), // clientId -> entry
  activeId: null,
  historyOn: localStorage.getItem('ccs.historyOn') !== 'false',
  search: '',
  defaultDir: '',
  sdkOk: true,
  grouped: localStorage.getItem('ccs.grouped') !== 'false',
  collapsed: new Set(JSON.parse(localStorage.getItem('ccs.collapsedProjects') || '[]')),
  sidebarHidden: localStorage.getItem('ccs.sidebarHidden') === 'true',
};

const $ = (s) => document.querySelector(s);
const el = {
  newChat: $('#newChatBtn'),
  historyToggle: $('#historyToggle'),
  histBody: $('#histBody'),
  search: $('#searchInput'),
  list: $('#sessionList'),
  refresh: $('#refreshBtn'),
  trashBtn: $('#trashBtn'),
  groupBtn: $('#groupBtn'),
  sidebar: $('#sidebar'),
  artifactsBtn: $('#artifactsBtn'),
  artifactsCount: $('#artifactsCount'),
  artifactPanel: $('#artifactPanel'),
  artifactResizer: $('#artifactResizer'),
  apSelect: $('#apSelect'),
  apView: $('#apView'),
  apDevice: $('#apDevice'),
  apReload: $('#apReload'),
  apBrowser: $('#apBrowser'),
  apReveal: $('#apReveal'),
  apClose: $('#apClose'),
  apBody: $('#apBody'),
  apFoot: $('#apFoot'),
  tabStrip: $('#tabStrip'),
  themeBtn: $('#themeBtn'),
  settingsBtn: $('#settingsBtn'),
  mcpBtn: $('#mcpBtn'),
  setMcp: $('#setMcp'),
  settingsModal: $('#settingsModal'),
  settingsClose: $('#settingsClose'),
  setTheme: $('#setTheme'),
  setNotify: $('#setNotify'),
  setModel: $('#setModel'),
  setMode: $('#setMode'),
  setEffort: $('#setEffort'),
  setVoiceSend: $('#setVoiceSend'),
  setVoiceLang: $('#setVoiceLang'),
  setVoiceModel: $('#setVoiceModel'),
  setVoiceRead: $('#setVoiceRead'),
  setVoiceName: $('#setVoiceName'),
  setVoiceRate: $('#setVoiceRate'),
  setVoiceTest: $('#setVoiceTest'),
  setArtifactAuto: $('#setArtifactAuto'),
  setDataDir: $('#setDataDir'),
  setAuthLabel: $('#setAuthLabel'),
  setSignOut: $('#setSignOut'),
  diagModal: $('#diagModal'),
  diagClose: $('#diagClose'),
  diagBody: $('#diagBody'),
  trashModal: $('#trashModal'),
  trashList: $('#trashList'),
  trashClose: $('#trashClose'),
  panes: $('#panes'),
  workArea: $('#workArea'),
  welcome: $('#welcome'),
  quickChat: $('#quickChatBtn'),
  quickChatPath: $('#quickChatPath'),
  recentFolders: $('#recentFolders'),
  browse: $('#browseBtn'),
  topbar: $('#topbar'),
  tabTitle: $('#tabTitle'),
  tabMeta: $('#tabMeta'),
  modeChat: $('#modeChat'),
  modeTerminal: $('#modeTerminal'),
  closeTab: $('#closeTab'),
  onboarding: $('#onboarding'),
  onboardStatus: $('#onboardStatus'),
  apiKeyInput: $('#apiKeyInput'),
  apiKeyErr: $('#apiKeyErr'),
  apiKeySave: $('#apiKeySave'),
  cliLoginBtn: $('#cliLoginBtn'),
  recheckBtn: $('#recheckBtn'),
  onboardFoot: $('#onboardFoot'),
  permModal: $('#permModal'),
  permTitle: $('#permTitle'),
  permDesc: $('#permDesc'),
  permInput: $('#permInput'),
  permRemember: $('#permRemember'),
  permRememberLabel: $('#permRememberLabel'),
  permAllow: $('#permAllow'),
  permDeny: $('#permDeny'),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c]));
}
function basename(p) {
  if (!p) return '';
  return p.replace(/\/+$/, '').split('/').pop() || p;
}
function relTime(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 604800) return Math.floor(s / 86400) + 'd ago';
  return new Date(ms).toLocaleDateString();
}
function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// ---------------------------------------------------------------------------
// Toasts + confirm (replace native alert/confirm)
// ---------------------------------------------------------------------------

let toastHost = null;
function toast(message, type) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    document.body.appendChild(toastHost);
  }
  const t = document.createElement('div');
  t.className = 'toast' + (type ? ' ' + type : '');
  t.textContent = message;
  toastHost.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 250);
  }, 3600);
}

/** In-app replacement for confirm(); resolves true/false. */
function confirmDialog(message, { danger } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.display = 'flex';
    overlay.innerHTML =
      '<div class="confirm-card">' +
      '  <div class="confirm-msg"></div>' +
      '  <div class="confirm-actions">' +
      '    <button class="perm-btn ghost confirm-no">Cancel</button>' +
      '    <button class="perm-btn ' + (danger ? 'danger' : 'primary') + ' confirm-yes">Confirm</button>' +
      '  </div>' +
      '</div>';
    overlay.querySelector('.confirm-msg').textContent = message;
    document.body.appendChild(overlay);
    const close = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('.confirm-yes').onclick = () => close(true);
    overlay.querySelector('.confirm-no').onclick = () => close(false);
    overlay.onclick = (e) => { if (e.target === overlay) close(false); };
    setTimeout(() => overlay.querySelector('.confirm-yes').focus(), 0);
  });
}

// ---------------------------------------------------------------------------
// Custom chat titles (stored locally; overrides the parsed/AI title)
// ---------------------------------------------------------------------------

function loadTitleOverrides() {
  try { return JSON.parse(localStorage.getItem('ccs.titles') || '{}'); }
  catch (_) { return {}; }
}
function saveTitleOverride(id, title) {
  if (!id) return;
  const map = loadTitleOverrides();
  if (title) map[id] = title; else delete map[id];
  localStorage.setItem('ccs.titles', JSON.stringify(map));
  state.titleOverrides = map;
}
function displayTitle(idOrEntry, fallback) {
  const id = typeof idOrEntry === 'string' ? idOrEntry : (idOrEntry && idOrEntry.id);
  const map = state.titleOverrides || (state.titleOverrides = loadTitleOverrides());
  return (id && map[id]) || fallback || 'Untitled chat';
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

async function loadSessions() {
  const res = await ipcRenderer.invoke('sessions:list');
  if (res && res.ok) state.sessions = res.sessions;
  renderSidebar();
  if (!state.activeId) renderWelcome();
}

function renderSidebar() {
  el.historyToggle.checked = state.historyOn;
  el.histBody.style.display = state.historyOn ? 'flex' : 'none';
  if (!state.historyOn) return;

  const byId = new Map();
  for (const s of state.sessions) {
    byId.set(s.id, Object.assign({}, s, { live: false }));
  }
  for (const entry of state.open.values()) {
    const id = entry.sessionId;
    if (id && byId.has(id)) {
      byId.get(id).live = true;
    } else if (!id || !byId.has(id)) {
      const key = id || entry.clientId;
      byId.set(key, {
        id: key,
        title: entry.title || 'New chat',
        project: entry.project || basename(entry.cwd),
        cwd: entry.cwd,
        messages: 0,
        mtime: Date.now(),
        live: true,
        fresh: true,
      });
    }
  }

  let items = [...byId.values()];
  const q = state.search.trim().toLowerCase();
  if (q) {
    items = items.filter((s) =>
      (s.title + ' ' + s.project + ' ' + (s.preview || '')).toLowerCase().includes(q)
    );
  }
  items.sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || b.mtime - a.mtime);

  el.list.innerHTML = '';
  if (!items.length) {
    el.list.innerHTML =
      '<div class="empty-hint">No saved chats yet.<br>Start a new chat to begin.</div>';
    return;
  }
  el.groupBtn.classList.toggle('on', state.grouped);
  if (state.grouped && !q) {
    // Projects view: one collapsible section per folder, newest project first.
    const groups = new Map();
    for (const s of items) {
      const key = s.cwd || s.project || 'unknown';
      if (!groups.has(key)) groups.set(key, { key, name: s.project || basename(key) || 'folder', cwd: s.cwd, items: [] });
      groups.get(key).items.push(s);
    }
    for (const g of groups.values()) {
      const closed = state.collapsed.has(g.key);
      const head = document.createElement('div');
      head.className = 'proj-head' + (closed ? ' closed' : '');
      head.title = g.cwd || '';
      head.innerHTML =
        '<span class="proj-caret">▾</span>' +
        '<span class="proj-name">📁 ' + escapeHtml(g.name) + '</span>' +
        '<span class="proj-count">' + g.items.length + '</span>' +
        (g.cwd ? '<button class="proj-new" title="New chat in this project">＋</button>' : '');
      head.onclick = () => {
        if (closed) state.collapsed.delete(g.key); else state.collapsed.add(g.key);
        localStorage.setItem('ccs.collapsedProjects', JSON.stringify([...state.collapsed]));
        renderSidebar();
      };
      const add = head.querySelector('.proj-new');
      if (add) add.onclick = (e) => { e.stopPropagation(); newChat(g.cwd); };
      el.list.appendChild(head);
      if (!closed) for (const s of g.items) el.list.appendChild(sessionCard(s, true));
    }
    return;
  }
  for (const s of items) el.list.appendChild(sessionCard(s, false));
}

function sessionCard(s, inGroup) {
  const activeEntry = state.open.get(state.activeId);
  const isActive =
    activeEntry &&
    (activeEntry.sessionId === s.id || activeEntry.clientId === s.id);
  const card = document.createElement('div');
  card.className = 'session-card' + (isActive ? ' active' : '') + (inGroup ? ' in-group' : '');
  const when = s.fresh ? 'live now' : relTime(s.mtime);
  const msgs = s.messages ? ' · ' + s.messages + ' msgs' : '';
  const shownTitle = displayTitle(s.id, s.title);
  card.innerHTML =
    '<div class="sc-main">' +
    '<div class="sc-title">' +
    (s.live ? '<span class="live-dot"></span>' : '') +
    '<span class="sc-title-text">' + escapeHtml(shownTitle) + '</span>' +
    '</div><div class="sc-meta">' +
    (inGroup ? '' : escapeHtml(s.project || 'folder') + ' · ') + when + msgs +
    '</div></div>' +
    '<button class="sc-rename" title="Rename chat">✎</button>' +
    (s.file ? '<button class="sc-del" title="Delete chat (kept 30 days in Trash)">🗑</button>' : '');
  card.title = s.cwd || '';
  card.querySelector('.sc-main').onclick = () => openSession(s);
  card.querySelector('.sc-rename').onclick = (e) => {
    e.stopPropagation();
    startRename(card, s, shownTitle);
  };
  const delBtn = card.querySelector('.sc-del');
  if (delBtn) {
    delBtn.onclick = (e) => {
      e.stopPropagation();
      deleteSession(s);
    };
  }
  return card;
}

function startRename(card, s, current) {
  const titleEl = card.querySelector('.sc-title-text');
  if (!titleEl) return;
  const input = document.createElement('input');
  input.className = 'sc-rename-input';
  input.value = current;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    if (save) {
      const val = input.value.trim();
      saveTitleOverride(s.id, val && val !== s.title ? val : '');
      // Reflect in any open tab + topbar.
      for (const entry of state.open.values()) {
        if (entry.sessionId === s.id || entry.clientId === s.id) {
          entry.title = val || s.title;
        }
      }
      if (state.activeId) {
        const active = state.open.get(state.activeId);
        if (active && (active.sessionId === s.id || active.clientId === s.id)) {
          el.tabTitle.textContent = displayTitle(s.id, active.title);
        }
      }
    }
    renderTabs();
    renderSidebar();
  };
  input.onclick = (e) => e.stopPropagation();
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  };
  input.onblur = () => commit(true);
}

function renderWelcome() {
  el.quickChatPath.textContent = state.defaultDir
    ? 'in ' + state.defaultDir
    : '';
  const seen = new Set();
  const folders = [];
  for (const s of state.sessions) {
    if (s.cwd && !seen.has(s.cwd) && s.cwd !== state.defaultDir) {
      seen.add(s.cwd);
      folders.push(s.cwd);
    }
    if (folders.length >= 6) break;
  }
  el.recentFolders.innerHTML = '';
  if (!folders.length) {
    el.recentFolders.innerHTML =
      '<div class="empty-hint">No other folders yet.</div>';
  }
  for (const f of folders) {
    const b = document.createElement('button');
    b.className = 'folder-card';
    b.innerHTML =
      '<span class="fc-name">' + escapeHtml(basename(f)) + '</span>' +
      '<span class="fc-path">' + escapeHtml(f) + '</span>';
    b.onclick = () => newChat(f);
    el.recentFolders.appendChild(b);
  }
}

// ---------------------------------------------------------------------------
// Session entries
// ---------------------------------------------------------------------------

function createEntry(opts) {
  const clientId =
    (window.crypto && window.crypto.randomUUID && window.crypto.randomUUID()) ||
    'c' + Date.now() + Math.random();
  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.style.display = 'none';
  el.panes.appendChild(pane);
  const entry = {
    clientId,
    sessionId: opts.sessionId || null,
    cwd: opts.cwd || state.defaultDir,
    title: opts.title || 'New chat',
    project: opts.project || basename(opts.cwd || state.defaultDir),
    mode: 'chat',
    pane,
    chatView: null,
    term: null,
    fit: null,
    ended: false,
  };
  state.open.set(clientId, entry);
  return entry;
}

function buildChatPane(entry) {
  entry.pane.innerHTML = '';
  if (entry.term) {
    try { entry.term.dispose(); } catch (_) { /* ignore */ }
  }
  if (entry.chatView) entry.chatView.dispose();
  entry.term = null;
  entry.fit = null;
  entry.artifacts = [];
  entry.chatView = new ChatView(entry.pane, {
    onSend: (text, attachments) => {
      entry.busy = true;
      renderTabs();
      ipcRenderer.send('chat:send', { clientId: entry.clientId, text, attachments });
    },
    onDraft: (text) => saveDraft(entry, text),
    onOpenArtifact: (ref) => openArtifact(entry, ref),
    onArtifact: ({ path: p, live }) => {
      const full = nodePath.isAbsolute(p) ? p : nodePath.resolve(entry.cwd || '', p);
      if (!entry.artifacts.includes(full)) entry.artifacts.push(full);
      if (entry.clientId === state.activeId) updateArtifactsBadge(entry);
      if (live && entry.clientId === state.activeId &&
          localStorage.getItem('ccs.artifactAuto') !== 'off') {
        openArtifact(entry, { path: full });
      }
    },
    onInterrupt: () => ipcRenderer.invoke('chat:interrupt', { clientId: entry.clientId }),
    onOpenLink: (url) => ipcRenderer.send('open:external', url),
    onPickFiles: async () => {
      const r = await ipcRenderer.invoke('dialog:pickFiles', { cwd: entry.cwd });
      return r && r.paths ? r.paths : [];
    },
    onListFiles: async (query) => {
      const r = await ipcRenderer.invoke('files:search', { cwd: entry.cwd, query });
      return r && r.files ? r.files : [];
    },
    onSetModel: async (model) => {
      entry.model = model;
      await ipcRenderer.invoke('chat:setModel', { clientId: entry.clientId, model });
    },
    onSetPermissionMode: async (mode) => {
      const r = await ipcRenderer.invoke('chat:setPermissionMode', { clientId: entry.clientId, mode });
      if (r && r.rejected) return r;
      entry.permissionMode = mode;
      // Bypass stays with this chat — it never becomes the default for new ones.
      if (mode !== 'bypassPermissions') localStorage.setItem('ccs.permissionMode', mode);
      return r;
    },
    onSetEffort: async (effort) => {
      const r = await ipcRenderer.invoke('chat:setEffort', { clientId: entry.clientId, effort });
      if (r && r.rejected) return r;
      entry.effort = effort;
      localStorage.setItem('ccs.effort', effort);
      return r;
    },
    onSetAutoModel: (on) => {
      entry.autoModel = on;
      localStorage.setItem('ccs.autoModel', on ? 'on' : 'off');
    },
    voicePrefs,
    onTranscribe: (audio) => {
      const p = voicePrefs();
      return ipcRenderer.invoke('voice:transcribe', { audio, model: p.model, language: p.language });
    },
  });
  // Restore the last-used permission mode, effort and Auto model for this pane.
  const savedMode = entry.permissionMode || localStorage.getItem('ccs.permissionMode') || 'default';
  entry.permissionMode = savedMode;
  entry.chatView.setPermissionMode(savedMode);
  if (entry.effort == null) entry.effort = localStorage.getItem('ccs.effort') || '';
  entry.chatView.setEffort(entry.effort);
  if (entry.autoModel == null) entry.autoModel = localStorage.getItem('ccs.autoModel') === 'on';
  entry.chatView.setAutoModel(entry.autoModel);
  entry.chatView.setDraft(loadDraft(entry));
}

// Voice settings, read fresh each time so Settings changes apply immediately.
function voicePrefs() {
  return {
    autoSend: localStorage.getItem('ccs.voice.send') !== 'review',
    read: localStorage.getItem('ccs.voice.read') || 'mic',
    voice: localStorage.getItem('ccs.voice.name') || '',
    rate: Number(localStorage.getItem('ccs.voice.rate')) || 1,
    language: localStorage.getItem('ccs.voice.lang') || 'english',
    model: localStorage.getItem('ccs.voice.model') || 'onnx-community/whisper-base',
  };
}

// First mic use downloads the speech model — the pane that's waiting shows progress.
ipcRenderer.on('voice:progress', (_e, { loaded, total }) => {
  for (const e of state.open.values()) if (e.chatView) e.chatView.voiceProgress(loaded, total);
});

// Unsent composer text survives tab switches, mode switches and restarts.
function draftKey(entry) { return 'ccs.draft.' + (entry.sessionId || 'new:' + entry.cwd); }
function saveDraft(entry, text) {
  if (text) localStorage.setItem(draftKey(entry), text);
  else localStorage.removeItem(draftKey(entry));
}
function loadDraft(entry) { return localStorage.getItem(draftKey(entry)) || ''; }

async function loadModels(entry) {
  if (!entry.chatView) return;
  const r = await ipcRenderer.invoke('chat:models', { clientId: entry.clientId });
  if (r && r.ok && r.models && r.models.length) {
    entry.chatView.setModels(r.models, entry.model || entry.activeModel);
  }
}

async function startChat(entry, mode) {
  if (mode === 'resume' && entry.sessionId) {
    const h = await ipcRenderer.invoke('chat:history', {
      sessionId: entry.sessionId,
      cwd: entry.cwd,
    });
    if (h && h.ok && entry.chatView) entry.chatView.renderHistory(h.messages);
  }
  const res = await ipcRenderer.invoke('chat:start', {
    clientId: entry.clientId,
    mode,
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    model: entry.model,
    permissionMode: entry.permissionMode,
    effort: entry.effort,
  });
  if (res && !res.ok && entry.chatView) {
    entry.chatView._addNotice('Could not start Claude: ' + res.error, true);
  }
}

async function newChat(folder) {
  const entry = createEntry({ cwd: folder || state.defaultDir, title: 'New chat' });
  if (settings.model) entry.model = settings.model;
  buildChatPane(entry);
  setActive(entry.clientId);
  await startChat(entry, 'new');
  if (entry.chatView) entry.chatView.focusInput();
  setTimeout(loadSessions, 2500);
}

async function openSession(meta, { lazy } = {}) {
  for (const e of state.open.values()) {
    if (meta.id && e.sessionId === meta.id) {
      setActive(e.clientId);
      return;
    }
    if (e.clientId === meta.id) {
      setActive(e.clientId);
      return;
    }
  }
  const entry = createEntry({
    sessionId: meta.id,
    cwd: meta.cwd,
    title: meta.title,
    project: meta.project,
  });
  buildChatPane(entry);
  if (lazy) {
    // Restored tab: don't spawn Claude until the user actually looks at it.
    entry.lazy = true;
    renderTabs();
    return entry;
  }
  setActive(entry.clientId);
  await startChat(entry, 'resume');
  if (entry.chatView) entry.chatView.focusInput();
  return entry;
}

// Remember which chats were open so the next launch picks up where you left off.
function persistTabs() {
  const tabs = [];
  for (const e of state.open.values()) {
    if (e.sessionId && e.mode === 'chat') {
      tabs.push({ id: e.sessionId, cwd: e.cwd, title: e.title, project: e.project, active: e.clientId === state.activeId });
    }
  }
  localStorage.setItem('ccs.openTabs', JSON.stringify(tabs.slice(0, 8)));
}

async function restoreTabs() {
  let tabs = [];
  try { tabs = JSON.parse(localStorage.getItem('ccs.openTabs') || '[]'); } catch (_) { tabs = []; }
  const known = new Set(state.sessions.map((s) => s.id));
  tabs = tabs.filter((t) => t && t.id && known.has(t.id));
  if (!tabs.length) return false;
  let active = null;
  for (const t of tabs) {
    const entry = await openSession(t, { lazy: true });
    if (t.active && entry) active = entry;
  }
  const first = active || [...state.open.values()][0];
  if (first) setActive(first.clientId);
  return !!first;
}

// ---------------------------------------------------------------------------
// Terminal mode
// ---------------------------------------------------------------------------

function buildTerminalPane(entry) {
  entry.pane.innerHTML = '';
  entry.pane.classList.remove('chat-view');
  entry.chatView = null;
  const wrap = document.createElement('div');
  wrap.className = 'term-wrap';
  entry.pane.appendChild(wrap);

  const term = new Terminal({
    fontFamily:
      '"Cascadia Code", "JetBrains Mono", "Ubuntu Mono", "DejaVu Sans Mono", monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    theme: termTheme(),
    scrollback: 12000,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(wrap);
  term.onData((d) => ipcRenderer.send('pty:input', { clientId: entry.clientId, data: d }));
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC') {
      const sel = term.getSelection();
      if (sel) { clipboard.writeText(sel); return false; }
    }
    if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyV') {
      const t = clipboard.readText();
      if (t) ipcRenderer.send('pty:input', { clientId: entry.clientId, data: t });
      return false;
    }
    return true;
  });
  entry.term = term;
  entry.fit = fit;

  ipcRenderer
    .invoke('pty:create', {
      clientId: entry.clientId,
      mode: entry.sessionId ? 'resume' : 'new',
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      cols: 100,
      rows: 30,
    })
    .then((res) => {
      if (res && !res.ok) term.write('\r\n[ Could not start Claude: ' + res.error + ' ]\r\n');
    });

  requestAnimationFrame(() => {
    try { fit.fit(); } catch (_) { /* ignore */ }
    ipcRenderer.send('pty:resize', {
      clientId: entry.clientId,
      cols: term.cols,
      rows: term.rows,
    });
  });
}

// ---------------------------------------------------------------------------
// Mode switching, activation
// ---------------------------------------------------------------------------

async function switchMode(entry, newMode) {
  if (!entry || entry.mode === newMode) return;
  if (entry.mode === 'chat') {
    ipcRenderer.send('chat:stop', { clientId: entry.clientId });
  } else {
    ipcRenderer.send('pty:kill', { clientId: entry.clientId });
  }
  entry.mode = newMode;
  entry.ended = false;
  if (newMode === 'chat') {
    buildChatPane(entry);
    setActive(entry.clientId);
    await startChat(entry, entry.sessionId ? 'resume' : 'new');
    if (entry.chatView) entry.chatView.focusInput();
  } else {
    buildTerminalPane(entry);
    setActive(entry.clientId);
  }
}

function setActive(clientId) {
  state.activeId = clientId;
  el.welcome.style.display = 'none';
  el.workArea.style.display = 'flex';
  el.topbar.style.display = 'flex';
  for (const [id, entry] of state.open) {
    // Use '' (not 'block') so the active pane falls back to its stylesheet
    // display — `.chat-view` is `display:flex`, which the composer relies on to
    // stay pinned to the bottom while messages scroll internally.
    entry.pane.style.display = id === clientId ? '' : 'none';
  }
  const entry = state.open.get(clientId);
  if (entry && entry.lazy) {
    entry.lazy = false;
    startChat(entry, 'resume');
  }
  if (entry) {
    updateArtifactsBadge(entry);
    persistTabs();
    if (art.open && art.entry !== entry) {
      // The panel follows the tab you're looking at.
      art.entry = entry;
      art.current = null;
      const latest = entry.artifacts && entry.artifacts[entry.artifacts.length - 1];
      if (latest) openArtifact(entry, { path: latest });
      else refreshArtifactList(entry).then(renderArtifactEmpty);
    }
    entry.needsInput = false; // you're looking at it now
    el.tabTitle.textContent = displayTitle(entry.sessionId || entry.clientId, entry.title || 'Chat');
    el.tabMeta.textContent = entry.cwd || '';
    el.modeChat.classList.toggle('active', entry.mode === 'chat');
    el.modeTerminal.classList.toggle('active', entry.mode === 'terminal');
    if (entry.mode === 'terminal' && entry.fit) {
      requestAnimationFrame(() => {
        try { entry.fit.fit(); } catch (_) { /* ignore */ }
        ipcRenderer.send('pty:resize', {
          clientId,
          cols: entry.term.cols,
          rows: entry.term.rows,
        });
        if (entry.term) entry.term.focus();
      });
    } else if (entry.chatView) {
      entry.chatView.focusInput();
    }
  }
  renderTabs();
  renderSidebar();
}

function renderTabs() {
  const entries = [...state.open.values()];
  if (!entries.length) {
    el.tabStrip.style.display = 'none';
    el.tabStrip.innerHTML = '';
    return;
  }
  el.tabStrip.style.display = 'flex';
  el.tabStrip.innerHTML = '';
  for (const entry of entries) {
    const tab = document.createElement('div');
    tab.className =
      'tab' +
      (entry.clientId === state.activeId ? ' active' : '') +
      (entry.needsInput ? ' needs-input' : '') +
      (entry.busy ? ' busy' : '');
    const icon = entry.mode === 'terminal' ? '❯_' : entry.busy ? '✳' : '💬';
    const title = displayTitle(entry.sessionId || entry.clientId, entry.title || 'New chat');
    if (entry.needsInput) tab.title = 'Claude is waiting for your answer';
    tab.innerHTML =
      '<span class="tab-icon">' + icon + '</span>' +
      '<span class="tab-name">' + escapeHtml(title) + '</span>' +
      (entry.needsInput ? '<span class="tab-alert" title="Waiting for you">●</span>' : '') +
      '<button class="tab-close" title="Close">✕</button>';
    tab.querySelector('.tab-name').onclick = () => setActive(entry.clientId);
    tab.querySelector('.tab-icon').onclick = () => setActive(entry.clientId);
    tab.querySelector('.tab-close').onclick = (e) => {
      e.stopPropagation();
      closeSession(entry.clientId);
    };
    el.tabStrip.appendChild(tab);
  }
  const add = document.createElement('button');
  add.className = 'tab-add';
  add.textContent = '＋';
  add.title = 'New chat';
  add.onclick = () => showWelcome();
  el.tabStrip.appendChild(add);
}

function showWelcome() {
  state.activeId = null;
  if (art.open) setArtifactPanel(false);
  el.topbar.style.display = 'none';
  el.workArea.style.display = 'none';
  el.welcome.style.display = 'flex';
  for (const entry of state.open.values()) entry.pane.style.display = 'none';
  renderTabs();
  renderSidebar();
  renderWelcome();
}

function closeSession(clientId) {
  const entry = state.open.get(clientId);
  if (!entry) return;
  if (entry.mode === 'chat') {
    ipcRenderer.send('chat:stop', { clientId });
  } else {
    ipcRenderer.send('pty:kill', { clientId });
  }
  if (entry.term) {
    try { entry.term.dispose(); } catch (_) { /* ignore */ }
  }
  if (entry.chatView) entry.chatView.dispose();
  entry.pane.remove();
  state.open.delete(clientId);
  persistTabs();
  if (state.activeId === clientId) {
    const next = state.open.keys().next().value;
    if (next) setActive(next);
    else showWelcome();
  } else {
    renderSidebar();
  }
  setTimeout(loadSessions, 600);
}

// ---------------------------------------------------------------------------
// Delete / Trash
// ---------------------------------------------------------------------------

async function deleteSession(meta) {
  // Close it if it's open.
  for (const [id, entry] of state.open) {
    if (entry.sessionId === meta.id || entry.clientId === meta.id) {
      closeSession(id);
      break;
    }
  }
  const res = await ipcRenderer.invoke('sessions:delete', meta);
  if (!res || !res.ok) {
    toast('Could not delete chat: ' + (res && res.error ? res.error : 'unknown'), 'error');
    return;
  }
  toast('Chat moved to Trash — kept 30 days.');
  await loadSessions();
}

async function openTrash() {
  const res = await ipcRenderer.invoke('trash:list');
  const items = (res && res.items) || [];
  renderTrash(items);
  el.trashModal.style.display = 'flex';
}

function renderTrash(items) {
  el.trashList.innerHTML = '';
  if (!items.length) {
    el.trashList.innerHTML =
      '<div class="empty-hint">Trash is empty.<br>Deleted chats are kept here for 30 days.</div>';
    return;
  }
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'trash-row';
    row.innerHTML =
      '<div class="trash-info">' +
      '<div class="trash-title">' + escapeHtml(it.title || 'Untitled chat') + '</div>' +
      '<div class="trash-meta">' + escapeHtml(it.project || 'folder') +
      ' · ' + it.daysLeft + ' day' + (it.daysLeft === 1 ? '' : 's') + ' left</div>' +
      '</div>' +
      '<div class="trash-actions">' +
      '<button class="trash-btn restore">Restore</button>' +
      '<button class="trash-btn forever" title="Delete permanently">✕</button>' +
      '</div>';
    row.querySelector('.restore').onclick = async () => {
      await ipcRenderer.invoke('trash:restore', { id: it.id });
      await openTrash();
      loadSessions();
    };
    row.querySelector('.forever').onclick = async () => {
      const ok = await confirmDialog('Permanently delete this chat? This cannot be undone.', { danger: true });
      if (!ok) return;
      await ipcRenderer.invoke('trash:deleteForever', { id: it.id });
      toast('Chat permanently deleted.');
      await openTrash();
    };
    el.trashList.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Export conversation to Markdown
// ---------------------------------------------------------------------------

function messagesToMarkdown(messages, title) {
  const lines = ['# ' + (title || 'Claude chat'), ''];
  for (const m of messages || []) {
    const inner = m && m.message;
    if (!inner) continue;
    const content = inner.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n\n');
    }
    if (!text.trim()) continue;
    if (m.type === 'user') lines.push('## 🧑 You', '', text, '');
    else if (m.type === 'assistant') lines.push('## ✳ Claude', '', text, '');
  }
  return lines.join('\n');
}

async function exportChat(entry) {
  if (!entry || !entry.sessionId) {
    toast('Start or open a chat before exporting.', 'error');
    return;
  }
  const h = await ipcRenderer.invoke('chat:history', {
    sessionId: entry.sessionId,
    cwd: entry.cwd,
  });
  if (!h || !h.ok) {
    toast('Could not read this chat to export.', 'error');
    return;
  }
  const title = displayTitle(entry.sessionId || entry.clientId, entry.title);
  const md = messagesToMarkdown(h.messages, title);
  const safe = (title || 'chat').replace(/[^a-z0-9-_ ]/gi, '').trim().slice(0, 60) || 'chat';
  const res = await ipcRenderer.invoke('dialog:saveText', {
    defaultName: safe + '.md',
    text: md,
  });
  if (res && res.ok) toast('Exported to ' + res.path);
  else if (res && !res.canceled) toast('Export failed: ' + (res.error || 'unknown'), 'error');
}

// ---------------------------------------------------------------------------
// IPC from main — chat
// ---------------------------------------------------------------------------

ipcRenderer.on('chat:message', (_e, { clientId, msg }) => {
  const entry = state.open.get(clientId);
  if (!entry) return;
  if (msg && msg.type === 'system' && msg.subtype === 'init') {
    if (!entry.sessionId && msg.session_id) {
      entry.sessionId = msg.session_id;
      renderSidebar();
      persistTabs();
    }
    if (msg.model) entry.activeModel = msg.model;
    if (!entry.modelsLoaded) {
      entry.modelsLoaded = true;
      loadModels(entry);
    }
  }
  if (msg && msg.type === 'result') {
    entry.busy = false;
    renderTabs();
    if (!document.hasFocus()) notifyDone(entry, msg);
    else if (entry.clientId !== state.activeId) {
      toast('✳ ' + displayTitle(entry.sessionId || entry.clientId, entry.title) + ' — Claude finished.');
    }
  }
  if (entry.chatView) entry.chatView.handleSdkMessage(msg);
});

// Notify when a response finishes while the window is in the background.
function notifyDone(entry, msg) {
  if (localStorage.getItem('ccs.notifications') === 'off') return;
  if (typeof Notification === 'undefined') return;
  const title = displayTitle(entry.sessionId || entry.clientId, entry.title || 'Claude');
  const ok = msg.subtype === 'success' && !msg.is_error;
  const body = ok ? 'Claude finished responding.' : 'The response needs your attention.';
  try {
    const n = new Notification('✳ ' + title, { body, silent: false });
    n.onclick = () => {
      ipcRenderer.send('win:focus');
      if (entry.clientId) setActive(entry.clientId);
    };
  } catch (_) { /* notifications unavailable */ }
}

ipcRenderer.on('chat:capabilities', (_e, { clientId, models, commands }) => {
  const entry = state.open.get(clientId);
  if (!entry || !entry.chatView) return;
  if (models && models.length) entry.chatView.setModels(models, entry.activeModel);
  if (commands && commands.length) entry.chatView.setCommands(commands);
});

ipcRenderer.on('chat:error', (_e, { clientId, error }) => {
  const entry = state.open.get(clientId);
  if (entry && entry.chatView) {
    entry.chatView._addNotice('Error: ' + error, true);
    entry.chatView.setBusy(false);
  }
  if (entry) { entry.busy = false; renderTabs(); }
});

ipcRenderer.on('chat:ended', (_e, { clientId }) => {
  const entry = state.open.get(clientId);
  if (entry && entry.chatView && !entry.ended) {
    entry.chatView.setBusy(false);
  }
  if (entry) { entry.busy = false; renderTabs(); }
});

// ---------------------------------------------------------------------------
// IPC from main — terminal
// ---------------------------------------------------------------------------

ipcRenderer.on('pty:data', (_e, { clientId, data }) => {
  const entry = state.open.get(clientId);
  if (entry && entry.term) entry.term.write(data);
});

ipcRenderer.on('pty:exit', (_e, { clientId }) => {
  const entry = state.open.get(clientId);
  if (entry && entry.term && !entry.ended) {
    entry.ended = true;
    entry.term.write('\r\n\x1b[2m[ Claude exited — switch to Chat or close this tab ]\x1b[0m\r\n');
  }
});

// ---------------------------------------------------------------------------
// IPC from main — permission prompts
// ---------------------------------------------------------------------------

const permQueue = [];
let permActive = false;

/** Send one answer back to the main process. */
function respondPerm(req, payload) {
  ipcRenderer.send(
    'permission:response',
    Object.assign({ permId: req.permId }, payload || {})
  );
}

ipcRenderer.on('permission:request', (_e, req) => {
  const entry = state.open.get(req.clientId);
  // A chat pane renders the prompt inline, in the conversation — questions get
  // clickable options, edits get a diff. Terminal panes (or a tab that's since
  // been closed) fall back to the modal.
  if (entry && entry.mode === 'chat' && entry.chatView) {
    entry.chatView.handlePermission(req, (payload) => {
      entry.needsInput = false;
      renderTabs();
      respondPerm(req, payload);
    });
    if (entry.clientId !== state.activeId) {
      entry.needsInput = true;
      renderTabs();
    }
    notifyNeedsInput(entry, req);
    return;
  }
  if (req.kind === 'question') {
    // Nowhere to render the options — don't leave Claude waiting on a modal
    // that can only say yes/no to a question that needs an actual answer.
    respondPerm(req, {
      allow: false,
      message: 'No chat window is open to answer that. Ask in the conversation instead.',
    });
    return;
  }
  permQueue.push(req);
  processPerm();
});

/** Nudge the user when Claude is waiting on them and the window isn't focused. */
function notifyNeedsInput(entry, req) {
  if (document.hasFocus()) return;
  if (localStorage.getItem('ccs.notifications') === 'off') return;
  if (typeof Notification === 'undefined') return;
  const title = displayTitle(entry.sessionId || entry.clientId, entry.title || 'Claude');
  const body = req.kind === 'question'
    ? 'Claude has a question for you.'
    : req.kind === 'plan'
      ? 'Claude finished a plan and needs your go-ahead.'
      : 'Claude needs permission to continue.';
  try {
    const n = new Notification('✳ ' + title, { body });
    n.onclick = () => {
      ipcRenderer.send('win:focus');
      setActive(entry.clientId);
    };
  } catch (_) { /* notifications unavailable */ }
}

function processPerm() {
  if (permActive || !permQueue.length) return;
  permActive = true;
  showPermModal(permQueue.shift());
}

function showPermModal(req) {
  const friendly = permFriendly(req.toolName);
  el.permTitle.textContent = req.title || friendly.title;
  el.permDesc.textContent = req.description || friendly.desc;
  const inputTxt = permInputText(req);
  el.permInput.textContent = inputTxt;
  el.permInput.style.display = inputTxt ? '' : 'none';
  el.permRemember.checked = false;
  el.permRememberLabel.textContent =
    'Always allow ' + (req.toolName || 'this') + ' for this chat';
  el.permModal.style.display = 'flex';

  const done = (allow) => {
    el.permModal.style.display = 'none';
    el.permAllow.onclick = null;
    el.permDeny.onclick = null;
    respondPerm(req, { allow, remember: allow && el.permRemember.checked });
    permActive = false;
    processPerm();
  };
  el.permAllow.onclick = () => done(true);
  el.permDeny.onclick = () => done(false);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && el.permModal.style.display === 'flex') {
    el.permDeny.click();
  }
});

// ---------------------------------------------------------------------------
// UI events
// ---------------------------------------------------------------------------

el.newChat.onclick = () => showWelcome();
el.quickChat.onclick = () => newChat(state.defaultDir);
el.browse.onclick = async () => {
  const r = await ipcRenderer.invoke('dialog:pickFolder');
  if (!r.canceled) newChat(r.path);
};
el.refresh.onclick = () => loadSessions();
el.trashBtn.onclick = () => openTrash();
el.trashClose.onclick = () => {
  el.trashModal.style.display = 'none';
};
el.trashModal.onclick = (e) => {
  if (e.target === el.trashModal) el.trashModal.style.display = 'none';
};
el.closeTab.onclick = () => {
  if (state.activeId) closeSession(state.activeId);
};
el.modeChat.onclick = () => {
  const entry = state.open.get(state.activeId);
  if (entry) switchMode(entry, 'chat');
};
el.modeTerminal.onclick = () => {
  const entry = state.open.get(state.activeId);
  if (entry) switchMode(entry, 'terminal');
};
el.historyToggle.onchange = () => {
  state.historyOn = el.historyToggle.checked;
  localStorage.setItem('ccs.historyOn', String(state.historyOn));
  renderSidebar();
};
el.search.oninput = () => {
  state.search = el.search.value;
  renderSidebar();
};

window.addEventListener(
  'resize',
  debounce(() => {
    const entry = state.open.get(state.activeId);
    if (entry && entry.mode === 'terminal' && entry.fit) {
      try { entry.fit.fit(); } catch (_) { /* ignore */ }
      ipcRenderer.send('pty:resize', {
        clientId: entry.clientId,
        cols: entry.term.cols,
        rows: entry.term.rows,
      });
    }
  }, 130)
);

// ---------------------------------------------------------------------------
// Settings + theme
// ---------------------------------------------------------------------------

const settings = {
  theme: localStorage.getItem('ccs.theme') || 'dark',
  model: localStorage.getItem('ccs.defaultModel') || '',
  mode: localStorage.getItem('ccs.permissionMode') || 'default',
};

function applyTheme(theme) {
  if (!TERM_THEMES[theme]) theme = 'dark';
  document.body.classList.remove('theme-light', 'theme-contrast');
  if (theme === 'light') document.body.classList.add('theme-light');
  else if (theme === 'contrast') document.body.classList.add('theme-contrast');
  settings.theme = theme;
  localStorage.setItem('ccs.theme', theme);

  // Keep the toggle, the Settings dropdown and any live terminal in sync.
  if (el.themeBtn) {
    const toLight = theme !== 'light';
    el.themeBtn.textContent = toLight ? '☀' : '🌙';
    el.themeBtn.title = toLight ? 'Switch to light theme' : 'Switch to dark theme';
  }
  if (el.setTheme) el.setTheme.value = theme;
  for (const entry of state.open.values()) {
    if (entry.term) {
      try { entry.term.options.theme = termTheme(); } catch (_) { /* ignore */ }
    }
  }
}

/** Toggle button: flip between light and dark (contrast counts as dark). */
function toggleTheme() {
  applyTheme(settings.theme === 'light' ? 'dark' : 'light');
}

async function openSettings() {
  el.setTheme.value = settings.theme;
  el.setNotify.value = localStorage.getItem('ccs.notifications') === 'off' ? 'off' : 'on';
  el.setModel.value = settings.model;
  el.setArtifactAuto.value = localStorage.getItem('ccs.artifactAuto') === 'off' ? 'off' : 'on';
  el.setMode.value = localStorage.getItem('ccs.permissionMode') || 'default';
  el.setEffort.value = localStorage.getItem('ccs.effort') || '';
  const vp = voicePrefs();
  el.setVoiceSend.value = vp.autoSend ? 'auto' : 'review';
  el.setVoiceLang.value = vp.language;
  el.setVoiceModel.value = vp.model;
  el.setVoiceRead.value = vp.read;
  el.setVoiceRate.value = String(vp.rate);
  fillVoices();
  el.setDataDir.textContent = state.defaultDir || '(unknown)';
  const auth = state.auth || (await checkAuth());
  el.setAuthLabel.textContent = (auth && auth.label) || 'Not signed in';
  el.setSignOut.style.display = auth && auth.source === 'apikey' ? '' : 'none';
  el.settingsModal.style.display = 'flex';
}

/** Voices from the system speech engine. espeak-ng lists every language ×
 *  ~100 "+Variant" timbres; offer each language's base voice plus the US
 *  English variants, English first. */
function fillVoices() {
  const voices = allVoices();
  const lang = (v) => String(v.lang || '').toLowerCase();
  const rank = (v) => (lang(v).startsWith('en') ? (v.name.includes('+') ? 1 : 0) : 2);
  el.setVoiceName.innerHTML = '';
  el.setVoiceName.add(new Option(voices.length
    ? 'Automatic — matches the language of the reply' : 'Automatic (no system voices found)', ''));
  voices
    .filter((v) => !v.name.includes('+') || lang(v) === 'en-us')
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .forEach((v) => el.setVoiceName.add(new Option(v.name.replace(/ espeak-ng$/, '') + ' — ' + v.lang, v.name)));
  el.setVoiceName.value = voicePrefs().voice;
  if (el.setVoiceName.selectedIndex < 0) el.setVoiceName.value = '';
}

let mcpPanel = null;
function openMcp() {
  if (!mcpPanel) {
    mcpPanel = new McpPanel({
      // Local/project-scope servers belong to the folder of the chat in front.
      getCwd: () => {
        const entry = state.open.get(state.activeId);
        return (entry && entry.cwd) || state.defaultDir;
      },
      toast,
      confirmDialog,
      escapeHtml,
    });
  }
  mcpPanel.open();
}

function wireSettings() {
  el.themeBtn.onclick = () => toggleTheme();
  el.settingsBtn.onclick = () => openSettings();
  el.mcpBtn.onclick = () => openMcp();
  el.setMcp.onclick = () => {
    el.settingsModal.style.display = 'none';
    openMcp();
  };
  el.settingsClose.onclick = () => { el.settingsModal.style.display = 'none'; };
  el.settingsModal.onclick = (e) => {
    if (e.target === el.settingsModal) el.settingsModal.style.display = 'none';
  };
  el.setTheme.onchange = () => applyTheme(el.setTheme.value);
  el.setNotify.onchange = () => {
    localStorage.setItem('ccs.notifications', el.setNotify.value);
    toast('Notifications ' + (el.setNotify.value === 'off' ? 'off' : 'on') + '.');
  };
  el.setModel.onchange = () => {
    settings.model = el.setModel.value;
    localStorage.setItem('ccs.defaultModel', settings.model);
    toast('New chats will use ' + (el.setModel.options[el.setModel.selectedIndex].text));
  };
  el.setArtifactAuto.onchange = () => {
    localStorage.setItem('ccs.artifactAuto', el.setArtifactAuto.value);
  };
  el.setMode.onchange = () => {
    localStorage.setItem('ccs.permissionMode', el.setMode.value);
    toast('Default permission mode saved.');
  };
  el.setEffort.onchange = () => {
    localStorage.setItem('ccs.effort', el.setEffort.value);
    toast('Default effort saved.');
  };
  el.setVoiceSend.onchange = () => localStorage.setItem('ccs.voice.send', el.setVoiceSend.value);
  el.setVoiceLang.onchange = () => localStorage.setItem('ccs.voice.lang', el.setVoiceLang.value);
  el.setVoiceModel.onchange = () => {
    localStorage.setItem('ccs.voice.model', el.setVoiceModel.value);
    toast('Downloads on your next mic use.');
  };
  el.setVoiceRead.onchange = () => localStorage.setItem('ccs.voice.read', el.setVoiceRead.value);
  el.setVoiceName.onchange = () => localStorage.setItem('ccs.voice.name', el.setVoiceName.value);
  el.setVoiceRate.onchange = () => localStorage.setItem('ccs.voice.rate', el.setVoiceRate.value);
  el.setVoiceTest.onclick = () => {
    const s = new Speaker({ prefs: voicePrefs });
    s.stop();
    s.say('Hi, I\'m Claude. This is how I\'ll sound when I read replies aloud.');
  };
  // The system voice list arrives asynchronously.
  if (typeof speechSynthesis !== 'undefined') {
    speechSynthesis.addEventListener('voiceschanged', () => {
      if (el.settingsModal.style.display !== 'none') fillVoices();
    });
  }
  el.setSignOut.onclick = async () => {
    const ok = await confirmDialog('Sign out and remove the saved API key from this computer?', { danger: true });
    if (!ok) return;
    await ipcRenderer.invoke('auth:clearApiKey');
    el.settingsModal.style.display = 'none';
    toast('Signed out.');
    const auth = await checkAuth();
    if (!auth || !auth.authed) showOnboarding(auth);
  };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

async function openDiagnostics() {
  const s = await ipcRenderer.invoke('app:status');
  const auth = state.auth || (await checkAuth());
  const rows = [
    ['Claude Agent SDK', s.sdkOk, s.sdkOk ? 'Loaded' : (s.sdkError || 'Not available')],
    ['Terminal (node-pty)', s.ptyOk, s.ptyOk ? 'Ready' : (s.ptyError || 'Not built — run npm run rebuild')],
    ['claude CLI', s.claudeFound, s.claudeBin || 'not found'],
    ['Account', !!(auth && auth.authed), (auth && auth.label) || 'Not signed in'],
    ['Chat data folder', true, s.defaultDir || '(unknown)'],
    ['Platform', true, s.platform || '(unknown)'],
    ['App version', true, s.appVersion || '(unknown)'],
    ['Electron / Node / Chrome', true,
      (s.versions ? s.versions.electron + ' / ' + s.versions.node + ' / ' + s.versions.chrome : '(unknown)')],
  ];
  let html = '';
  for (const [label, ok, detail] of rows) {
    html +=
      '<div class="diag-row">' +
      '<span class="diag-dot ' + (ok ? 'ok' : 'bad') + '"></span>' +
      '<span class="diag-label">' + escapeHtml(label) + '</span>' +
      '<span class="diag-detail">' + escapeHtml(detail) + '</span>' +
      '</div>';
  }
  el.diagModal.querySelector('.settings-title').textContent = '🩺 Diagnostics';
  el.diagBody.innerHTML = html;
  el.diagModal.style.display = 'flex';
}

el.diagClose.onclick = () => { el.diagModal.style.display = 'none'; };
el.diagModal.onclick = (e) => { if (e.target === el.diagModal) el.diagModal.style.display = 'none'; };

// ---------------------------------------------------------------------------
// Command palette (Ctrl/Cmd+K)
// ---------------------------------------------------------------------------

const palette = { root: null, input: null, list: null, items: [], active: 0, open: false };

function buildPalette() {
  const root = document.createElement('div');
  root.className = 'palette-overlay';
  root.style.display = 'none';
  root.innerHTML =
    '<div class="palette">' +
    '  <input class="palette-input" placeholder="Search chats or type a command…" />' +
    '  <div class="palette-list"></div>' +
    '  <div class="palette-foot">↑↓ to move · Enter to run · Esc to close</div>' +
    '</div>';
  document.body.appendChild(root);
  palette.root = root;
  palette.input = root.querySelector('.palette-input');
  palette.list = root.querySelector('.palette-list');
  root.addEventListener('click', (e) => { if (e.target === root) closePalette(); });
  palette.input.addEventListener('input', () => renderPalette());
  palette.input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); runPaletteActive(); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });
}

function paletteActions() {
  const hasTab = !!state.activeId;
  const entry = state.open.get(state.activeId);
  const acts = [
    { icon: '＋', label: 'New chat', hint: 'welcome screen', run: () => showWelcome() },
    { icon: '💬', label: 'Quick chat', hint: state.defaultDir, run: () => newChat(state.defaultDir) },
    { icon: '📁', label: 'Open a project folder…', hint: 'browse', run: async () => {
        const r = await ipcRenderer.invoke('dialog:pickFolder');
        if (!r.canceled) newChat(r.path);
      } },
    { icon: '⟳', label: 'Refresh chat list', hint: '', run: () => loadSessions() },
    { icon: '⚙', label: 'Open Settings', hint: 'theme, model, account', run: () => openSettings() },
    { icon: '🔌', label: 'MCP servers & privacy', hint: 'connect apps on this computer only', run: () => openMcp() },
    { icon: '🎨', label: 'Cycle theme (dark / light / contrast)', hint: settings.theme, run: () => {
        const order = ['dark', 'light', 'contrast'];
        applyTheme(order[(order.indexOf(settings.theme) + 1) % order.length]);
        toast('Theme: ' + settings.theme);
      } },
    { icon: '◧', label: 'Toggle Artifacts panel', hint: 'Ctrl+Shift+A', run: () => toggleArtifacts() },
    { icon: '▤', label: (state.grouped ? 'Ungroup chats' : 'Group chats by project'), hint: '', run: () => el.groupBtn.click() },
    { icon: '◀', label: (state.sidebarHidden ? 'Show' : 'Hide') + ' sidebar', hint: 'Ctrl+B', run: () => { state.sidebarHidden = !state.sidebarHidden; applySidebar(); } },
    { icon: '⌨', label: 'Keyboard shortcuts', hint: 'Ctrl+/', run: () => openShortcuts() },
    { icon: '🩺', label: 'Run Diagnostics', hint: 'SDK, terminal, CLI, account', run: () => openDiagnostics() },
    { icon: '🗑', label: 'Open Trash', hint: 'deleted chats', run: () => openTrash() },
    { icon: '👁', label: (state.historyOn ? 'Hide' : 'Show') + ' chat history', hint: '', run: () => {
        state.historyOn = !state.historyOn;
        el.historyToggle.checked = state.historyOn;
        localStorage.setItem('ccs.historyOn', String(state.historyOn));
        renderSidebar();
      } },
  ];
  if (hasTab && entry) {
    acts.push({ icon: '⬇', label: 'Export this chat to Markdown', hint: '', run: () => exportChat(entry) });
    acts.push({ icon: '💬', label: 'Switch this tab to Chat', hint: '', run: () => switchMode(entry, 'chat') });
    acts.push({ icon: '❯_', label: 'Switch this tab to Terminal', hint: '', run: () => switchMode(entry, 'terminal') });
    acts.push({ icon: '✕', label: 'Close current tab', hint: '', run: () => closeSession(state.activeId) });
  }
  return acts.map((a) => Object.assign({ kind: 'action' }, a));
}

function paletteSessions() {
  const seen = new Set();
  const out = [];
  for (const entry of state.open.values()) {
    const key = entry.sessionId || entry.clientId;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: 'session', icon: '●', label: entry.title || 'Open chat',
      hint: 'open · ' + basename(entry.cwd || ''),
      run: () => openSession({ id: entry.sessionId || entry.clientId, cwd: entry.cwd, title: entry.title, project: entry.project }),
    });
  }
  for (const s of state.sessions) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push({
      kind: 'session', icon: '○', label: s.title || 'Untitled chat',
      hint: (s.project || 'folder') + ' · ' + relTime(s.mtime),
      run: () => openSession(s),
    });
  }
  return out;
}

// Subsequence fuzzy match; returns true if all chars of q appear in order.
function fuzzy(q, text) {
  if (!q) return true;
  text = text.toLowerCase();
  let i = 0;
  for (const ch of q.toLowerCase()) {
    i = text.indexOf(ch, i);
    if (i === -1) return false;
    i++;
  }
  return true;
}

function openPalette() {
  if (!palette.root) buildPalette();
  palette.open = true;
  palette.root.style.display = 'flex';
  palette.input.value = '';
  renderPalette();
  setTimeout(() => palette.input.focus(), 0);
}

function closePalette() {
  palette.open = false;
  if (palette.root) palette.root.style.display = 'none';
}

function renderPalette() {
  const q = palette.input.value.trim();
  const all = [...paletteActions(), ...paletteSessions()];
  palette.items = all.filter((it) => fuzzy(q, it.label + ' ' + (it.hint || '')));
  palette.active = 0;
  palette.list.innerHTML = '';
  if (!palette.items.length) {
    palette.list.innerHTML = '<div class="palette-empty">No matches.</div>';
    return;
  }
  palette.items.forEach((it, idx) => {
    const row = document.createElement('div');
    row.className = 'palette-item' + (idx === 0 ? ' active' : '');
    row.innerHTML =
      '<span class="palette-icon">' + escapeHtml(it.icon || '') + '</span>' +
      '<span class="palette-label">' + escapeHtml(it.label) + '</span>' +
      (it.hint ? '<span class="palette-hint">' + escapeHtml(it.hint) + '</span>' : '');
    row.onmouseenter = () => { palette.active = idx; highlightPalette(); };
    row.onclick = () => { palette.active = idx; runPaletteActive(); };
    palette.list.appendChild(row);
  });
}

function highlightPalette() {
  [...palette.list.children].forEach((c, i) =>
    c.classList.toggle('active', i === palette.active)
  );
}

function movePalette(delta) {
  if (!palette.items.length) return;
  palette.active = (palette.active + delta + palette.items.length) % palette.items.length;
  highlightPalette();
  const row = palette.list.children[palette.active];
  if (row) row.scrollIntoView({ block: 'nearest' });
}

function runPaletteActive() {
  const it = palette.items[palette.active];
  if (!it) return;
  closePalette();
  try { it.run(); } catch (_) { /* ignore */ }
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    palette.open ? closePalette() : openPalette();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'N')) {
    e.preventDefault();
    showWelcome();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'w' || e.key === 'W')) {
    if (state.activeId) { e.preventDefault(); closeSession(state.activeId); }
  } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'l' || e.key === 'L')) {
    e.preventDefault();
    toggleTheme();
  } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'm' || e.key === 'M')) {
    // Talk to Claude. Terminal tabs have no chatView, so Ctrl+M still reaches the CLI there.
    const entry = state.open.get(state.activeId);
    if (entry && entry.chatView) {
      e.preventDefault();
      entry.chatView.toggleMic();
    }
  }
});

// ---------------------------------------------------------------------------
// Artifacts panel — local preview of what Claude builds (HTML, SVG, Markdown,
// images). Pages run in a sandboxed <webview> straight off the disk, so their
// relative CSS/JS/images work and nothing leaves this computer.
// ---------------------------------------------------------------------------

const art = {
  open: false,
  width: Number(localStorage.getItem('ccs.artifactWidth')) || 520,
  view: 'preview',
  deviceW: '',
  current: null, // { path, name, kind, ext, text, dataUrl }
  entry: null,
  webview: null,
  projectFiles: [],
};
const ART_WATCH_ID = 'artifact-panel';

function updateArtifactsBadge(entry) {
  const n = entry && entry.artifacts ? entry.artifacts.length : 0;
  el.artifactsCount.textContent = n ? String(n) : '';
  el.artifactsCount.style.display = n ? '' : 'none';
}

function setArtifactPanel(open) {
  art.open = open;
  el.artifactPanel.style.display = open ? 'flex' : 'none';
  el.artifactResizer.style.display = open ? '' : 'none';
  el.artifactPanel.style.width = art.width + 'px';
  el.artifactsBtn.classList.toggle('active', open);
  if (!open) ipcRenderer.send('artifact:unwatch', { watchId: ART_WATCH_ID });
  window.dispatchEvent(new Event('resize')); // refit a visible terminal
}

async function toggleArtifacts() {
  if (art.open) return setArtifactPanel(false);
  const entry = state.open.get(state.activeId);
  if (!entry) return;
  setArtifactPanel(true);
  art.entry = entry;
  await refreshArtifactList(entry);
  const first = (entry.artifacts && entry.artifacts[entry.artifacts.length - 1]) ||
    (art.projectFiles[0] && art.projectFiles[0].path);
  if (first) openArtifact(entry, { path: first });
  else renderArtifactEmpty();
}

async function refreshArtifactList(entry) {
  const r = await ipcRenderer.invoke('artifacts:scan', { cwd: entry.cwd });
  art.projectFiles = (r && r.files) || [];
  const mine = new Set(entry.artifacts || []);
  const sel = el.apSelect;
  sel.innerHTML = '';
  const addGroup = (label, files) => {
    if (!files.length) return;
    const g = document.createElement('optgroup');
    g.label = label;
    for (const f of files) {
      const o = document.createElement('option');
      o.value = f.path;
      o.textContent = f.rel;
      g.appendChild(o);
    }
    sel.appendChild(g);
  };
  const rel = (p) => (entry.cwd && p.startsWith(entry.cwd + '/') ? p.slice(entry.cwd.length + 1) : p);
  addGroup('Made in this chat', [...mine].reverse().map((p) => ({ path: p, rel: rel(p) })));
  addGroup('In this project', art.projectFiles.filter((f) => !mine.has(f.path)));
  if (art.current && art.current.inline) {
    const o = document.createElement('option');
    o.value = art.current.path;
    o.textContent = 'Snippet from chat';
    sel.insertBefore(o, sel.firstChild);
  }
  if (art.current) sel.value = art.current.path;
}

function renderArtifactEmpty() {
  art.current = null;
  art.webview = null;
  el.apBody.innerHTML =
    '<div class="ap-empty"><div class="ap-empty-mark">◧</div>' +
    '<div class="ap-empty-title">No artifacts yet</div>' +
    '<div class="ap-empty-sub">Ask Claude to build a page, a design, a diagram or a document. ' +
    'HTML, SVG, Markdown and images it writes show up here — rendered locally, live-reloading as it edits.</div></div>';
  el.apFoot.textContent = '';
}

/** ref: { path } for a file on disk, or { inline: { kind, code } } for a chat snippet. */
async function openArtifact(entry, ref) {
  if (!entry) return;
  let file = ref.path;
  let inline = false;
  if (ref.inline) {
    const w = await ipcRenderer.invoke('artifact:writeInline', ref.inline);
    if (!w || !w.ok) return toast('Could not preview that snippet.', 'error');
    file = w.path;
    inline = true;
  }
  const res = await ipcRenderer.invoke('artifact:read', { file, cwd: entry.cwd });
  if (!res || !res.ok) {
    toast('Could not open artifact: ' + ((res && res.error) || 'unknown'), 'error');
    return;
  }
  res.inline = inline;
  art.current = res;
  art.entry = entry;
  if (!art.open) setArtifactPanel(true);
  await refreshArtifactList(entry);
  renderArtifact();
  ipcRenderer.send('artifact:watch', { watchId: ART_WATCH_ID, file: res.path });
}

function renderArtifact() {
  const a = art.current;
  if (!a) return renderArtifactEmpty();
  const canPreview = a.kind !== 'code';
  const view = canPreview ? art.view : 'code';
  [...el.apView.children].forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
    b.disabled = b.dataset.view === 'preview' ? !canPreview : a.kind === 'image';
  });
  const isPage = a.kind === 'html' || a.kind === 'svg';
  el.apDevice.style.display = isPage && view === 'preview' ? '' : 'none';
  el.apBody.innerHTML = '';
  art.webview = null;

  if (view === 'code' && a.kind !== 'image') {
    const pre = document.createElement('pre');
    pre.className = 'ap-code';
    const code = document.createElement('code');
    const lang = { htm: 'html', svg: 'xml', md: 'markdown' }[a.ext] || a.ext;
    const html = highlightCode(a.text || '', lang);
    if (html) code.innerHTML = html; // hljs output is escaped
    else code.textContent = a.text || '';
    pre.appendChild(code);
    el.apBody.appendChild(pre);
  } else if (isPage) {
    const stage = document.createElement('div');
    stage.className = 'ap-stage' + (art.deviceW ? ' framed' : '');
    const wv = document.createElement('webview');
    wv.setAttribute('partition', 'ccs-artifacts');
    wv.setAttribute('src', pathToFileURL(a.path).href);
    if (art.deviceW) wv.style.maxWidth = art.deviceW + 'px';
    wv.addEventListener('console-message', (e) => {
      if (e.level >= 2) el.apFoot.textContent = '⚠ ' + String(e.message).slice(0, 160);
    });
    stage.appendChild(wv);
    el.apBody.appendChild(stage);
    art.webview = wv;
  } else if (a.kind === 'markdown') {
    const doc = document.createElement('div');
    doc.className = 'ap-doc msg-body';
    doc.innerHTML = md.render(a.text || ''); // markdown-it runs with html:false
    el.apBody.appendChild(doc);
  } else if (a.kind === 'image') {
    const wrap = document.createElement('div');
    wrap.className = 'ap-image';
    const img = document.createElement('img');
    img.src = a.dataUrl;
    img.alt = a.name;
    wrap.appendChild(img);
    el.apBody.appendChild(wrap);
  }
  const kb = a.size >= 1024 ? (a.size / 1024).toFixed(1) + ' KB' : a.size + ' B';
  el.apFoot.textContent = (a.inline ? 'Snippet from chat' : a.path) + ' · ' + kb + ' · local';
  el.apFoot.title = a.path;
}

async function reloadArtifact() {
  const a = art.current;
  if (!a || !art.entry) return;
  const res = await ipcRenderer.invoke('artifact:read', { file: a.path, cwd: art.entry.cwd });
  if (!res || !res.ok) return;
  res.inline = a.inline;
  art.current = res;
  // A page reloads in place (keeps scroll); everything else re-renders.
  if (art.webview && art.view === 'preview') {
    try { art.webview.reloadIgnoringCache(); return; } catch (_) { /* fall through */ }
  }
  renderArtifact();
}

ipcRenderer.on('artifact:changed', debounce(() => {
  if (art.open && art.current) reloadArtifact();
}, 200));

el.artifactsBtn.onclick = () => toggleArtifacts();
el.apClose.onclick = () => setArtifactPanel(false);
el.apReload.onclick = () => reloadArtifact();
el.apBrowser.onclick = () => { if (art.current) ipcRenderer.send('open:path', art.current.path); };
el.apReveal.onclick = () => { if (art.current) ipcRenderer.send('open:reveal', art.current.path); };
el.apSelect.onchange = () => {
  if (art.entry && el.apSelect.value) openArtifact(art.entry, { path: el.apSelect.value });
};
el.apView.onclick = (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  art.view = b.dataset.view;
  renderArtifact();
};
el.apDevice.onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  art.deviceW = b.dataset.w;
  [...el.apDevice.children].forEach((c) => c.classList.toggle('active', c === b));
  renderArtifact();
};

// Drag the divider to resize; the webview must not swallow the mouse meanwhile.
el.artifactResizer.addEventListener('mousedown', (e) => {
  e.preventDefault();
  document.body.classList.add('resizing');
  const move = (ev) => {
    const max = Math.max(320, el.artifactPanel.parentElement.clientWidth - 380);
    art.width = Math.min(max, Math.max(320, window.innerWidth - ev.clientX));
    el.artifactPanel.style.width = art.width + 'px';
  };
  const up = () => {
    document.body.classList.remove('resizing');
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    localStorage.setItem('ccs.artifactWidth', String(art.width));
    window.dispatchEvent(new Event('resize'));
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
});

// ---------------------------------------------------------------------------
// Sidebar layout + keyboard shortcuts
// ---------------------------------------------------------------------------

function applySidebar() {
  el.sidebar.style.display = state.sidebarHidden ? 'none' : '';
  localStorage.setItem('ccs.sidebarHidden', String(state.sidebarHidden));
  window.dispatchEvent(new Event('resize'));
}

el.groupBtn.onclick = () => {
  state.grouped = !state.grouped;
  localStorage.setItem('ccs.grouped', String(state.grouped));
  renderSidebar();
};

const SHORTCUTS = [
  ['Ctrl+K', 'Command palette — search chats and actions'],
  ['Ctrl+N', 'New chat'],
  ['Ctrl+W', 'Close the current tab'],
  ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous tab'],
  ['Ctrl+1 … 9', 'Jump to a tab'],
  ['Ctrl+B', 'Show or hide the sidebar'],
  ['Ctrl+Shift+A', 'Open or close the Artifacts panel'],
  ['Ctrl+Shift+L', 'Toggle light / dark'],
  ['Shift+Tab', 'Cycle permission mode (in the message box; never lands on Bypass)'],
  ['Ctrl+M', 'Talk to Claude — start / finish speaking'],
  ['Esc', 'Cancel the mic, stop reading aloud, then stop Claude (in the message box)'],
  ['↑', 'Recall your last message (empty message box)'],
  ['/  and  @', 'Slash commands and file mentions'],
  ['1 – 9 · ←/→ · Enter', 'Answer Claude\'s questions from the keyboard'],
];

function openShortcuts() {
  el.diagModal.querySelector('.settings-title').textContent = '⌨ Keyboard shortcuts';
  el.diagBody.innerHTML = SHORTCUTS.map(([k, d]) =>
    '<div class="diag-row"><span class="kbd">' + escapeHtml(k) + '</span>' +
    '<span class="diag-detail">' + escapeHtml(d) + '</span></div>').join('');
  el.diagModal.style.display = 'flex';
}

function cycleTab(delta) {
  const ids = [...state.open.keys()];
  if (ids.length < 2) return;
  const i = ids.indexOf(state.activeId);
  setActive(ids[(i + delta + ids.length) % ids.length]);
}

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  if (e.key === 'Tab') {
    e.preventDefault();
    cycleTab(e.shiftKey ? -1 : 1);
  } else if (/^[1-9]$/.test(e.key) && !e.shiftKey && !e.altKey) {
    const id = [...state.open.keys()][Number(e.key) - 1];
    if (id) { e.preventDefault(); setActive(id); }
  } else if ((e.key === 'b' || e.key === 'B') && !e.shiftKey) {
    e.preventDefault();
    state.sidebarHidden = !state.sidebarHidden;
    applySidebar();
  } else if (e.shiftKey && (e.key === 'a' || e.key === 'A')) {
    e.preventDefault();
    toggleArtifacts();
  } else if (e.key === '/') {
    e.preventDefault();
    openShortcuts();
  }
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Onboarding / auth
// ---------------------------------------------------------------------------

async function checkAuth() {
  const auth = await ipcRenderer.invoke('auth:status');
  state.auth = auth;
  return auth;
}

function showOnboarding(auth) {
  el.onboarding.style.display = 'flex';
  el.topbar.style.display = 'none';
  el.workArea.style.display = 'none';
  el.welcome.style.display = 'none';
  if (auth && auth.source && auth.source !== 'none') {
    el.onboardStatus.textContent =
      'Connected via ' + auth.label + ', but it isn\'t usable. Re-connect below.';
  }
}

function hideOnboarding() {
  el.onboarding.style.display = 'none';
}

async function onAuthed() {
  hideOnboarding();
  await loadSessions();
  showWelcome();
}

el.apiKeySave.onclick = async () => {
  el.apiKeyErr.textContent = '';
  const key = el.apiKeyInput.value.trim();
  if (!key) {
    el.apiKeyErr.textContent = 'Please paste your API key.';
    return;
  }
  el.apiKeySave.disabled = true;
  el.apiKeySave.textContent = 'Saving…';
  const res = await ipcRenderer.invoke('auth:saveApiKey', { key });
  el.apiKeySave.disabled = false;
  el.apiKeySave.textContent = 'Save & continue';
  if (res && res.ok && res.authed) {
    el.apiKeyInput.value = '';
    onAuthed();
  } else {
    el.apiKeyErr.textContent = (res && res.error) || 'Could not save the key.';
  }
};

el.cliLoginBtn.onclick = () => {
  // Open a terminal session running `claude`, which triggers the browser sign-in
  // when no account is present.
  hideOnboarding();
  const entry = createEntry({ cwd: state.defaultDir, title: 'Sign in to Claude' });
  entry.mode = 'terminal';
  buildTerminalPane(entry);
  setActive(entry.clientId);
  el.onboardFoot.textContent = '';
};

el.recheckBtn.onclick = async () => {
  el.recheckBtn.textContent = 'Checking…';
  const auth = await checkAuth();
  el.recheckBtn.textContent = "I've signed in — re-check";
  if (auth && auth.authed) onAuthed();
  else {
    el.onboardFoot.textContent =
      'Still not detecting an account. Finish the sign-in, or use an API key above.';
  }
};

async function init() {
  el.historyToggle.checked = state.historyOn;
  applyTheme(settings.theme);
  wireSettings();
  applySidebar();
  const status = await ipcRenderer.invoke('app:status');
  state.defaultDir = status.defaultDir || '';
  state.sdkOk = !!status.sdkOk;

  if (!status.sdkOk) {
    el.welcome.innerHTML =
      '<div class="welcome-inner">' +
      '<div class="welcome-mark">⚠</div>' +
      '<h1>Setup needed</h1>' +
      '<p class="welcome-sub err">The Claude Agent SDK could not load:</p>' +
      '<pre class="setup-error">' + escapeHtml(status.sdkError || 'unknown') + '</pre>' +
      '<p class="welcome-sub">Run <code>npm install</code> in the app folder, then reopen.</p>' +
      '</div>';
    showWelcome();
    return;
  }

  const auth = await checkAuth();
  if (!auth || !auth.authed) {
    await loadSessions(); // history may still exist from a prior login
    showOnboarding(auth);
    setInterval(loadSessions, 12000);
    return;
  }

  await loadSessions();
  if (!(await restoreTabs())) showWelcome();
  setInterval(loadSessions, 12000);
}

// A file dropped outside a chat pane would otherwise make Electron navigate
// to it, replacing the whole UI. ChatView handles drops on its own container.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

init();
