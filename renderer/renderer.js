'use strict';

const { ipcRenderer, clipboard } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { ChatView } = require('./chatview.js');

// ---------------------------------------------------------------------------
// Terminal theme
// ---------------------------------------------------------------------------

const TERM_THEME = {
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
};

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
  tabStrip: $('#tabStrip'),
  settingsBtn: $('#settingsBtn'),
  settingsModal: $('#settingsModal'),
  settingsClose: $('#settingsClose'),
  setTheme: $('#setTheme'),
  setModel: $('#setModel'),
  setMode: $('#setMode'),
  setDataDir: $('#setDataDir'),
  setAuthLabel: $('#setAuthLabel'),
  setSignOut: $('#setSignOut'),
  trashModal: $('#trashModal'),
  trashList: $('#trashList'),
  trashClose: $('#trashClose'),
  panes: $('#panes'),
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
  for (const s of items) {
    const activeEntry = state.open.get(state.activeId);
    const isActive =
      activeEntry &&
      (activeEntry.sessionId === s.id || activeEntry.clientId === s.id);
    const card = document.createElement('div');
    card.className = 'session-card' + (isActive ? ' active' : '');
    const when = s.fresh ? 'live now' : relTime(s.mtime);
    const msgs = s.messages ? ' · ' + s.messages + ' msgs' : '';
    const shownTitle = displayTitle(s.id, s.title);
    card.innerHTML =
      '<div class="sc-main">' +
      '<div class="sc-title">' +
      (s.live ? '<span class="live-dot"></span>' : '') +
      '<span class="sc-title-text">' + escapeHtml(shownTitle) + '</span>' +
      '</div><div class="sc-meta">' +
      escapeHtml(s.project || 'folder') + ' · ' + when + msgs +
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
    el.list.appendChild(card);
  }
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
  entry.term = null;
  entry.fit = null;
  entry.chatView = new ChatView(entry.pane, {
    onSend: (text) => ipcRenderer.send('chat:send', { clientId: entry.clientId, text }),
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
      entry.permissionMode = mode;
      localStorage.setItem('ccs.permissionMode', mode);
      await ipcRenderer.invoke('chat:setPermissionMode', { clientId: entry.clientId, mode });
    },
  });
  // Restore the last-used permission mode for this pane.
  const savedMode = entry.permissionMode || localStorage.getItem('ccs.permissionMode') || 'default';
  entry.permissionMode = savedMode;
  entry.chatView.setPermissionMode(savedMode);
}

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

async function openSession(meta) {
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
  setActive(entry.clientId);
  await startChat(entry, 'resume');
  if (entry.chatView) entry.chatView.focusInput();
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
    theme: TERM_THEME,
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
  el.panes.style.display = 'block';
  el.topbar.style.display = 'flex';
  for (const [id, entry] of state.open) {
    // Use '' (not 'block') so the active pane falls back to its stylesheet
    // display — `.chat-view` is `display:flex`, which the composer relies on to
    // stay pinned to the bottom while messages scroll internally.
    entry.pane.style.display = id === clientId ? '' : 'none';
  }
  const entry = state.open.get(clientId);
  if (entry) {
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
    tab.className = 'tab' + (entry.clientId === state.activeId ? ' active' : '');
    const icon = entry.mode === 'terminal' ? '❯_' : '💬';
    const title = displayTitle(entry.sessionId || entry.clientId, entry.title || 'New chat');
    tab.innerHTML =
      '<span class="tab-icon">' + icon + '</span>' +
      '<span class="tab-name">' + escapeHtml(title) + '</span>' +
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
  el.topbar.style.display = 'none';
  el.panes.style.display = 'none';
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
  entry.pane.remove();
  state.open.delete(clientId);
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
    }
    if (msg.model) entry.activeModel = msg.model;
    if (!entry.modelsLoaded) {
      entry.modelsLoaded = true;
      loadModels(entry);
    }
  }
  if (entry.chatView) entry.chatView.handleSdkMessage(msg);
});

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
});

ipcRenderer.on('chat:ended', (_e, { clientId }) => {
  const entry = state.open.get(clientId);
  if (entry && entry.chatView && !entry.ended) {
    entry.chatView.setBusy(false);
  }
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

ipcRenderer.on('permission:request', (_e, req) => {
  permQueue.push(req);
  processPerm();
});

function processPerm() {
  if (permActive || !permQueue.length) return;
  permActive = true;
  showPermModal(permQueue.shift());
}

function permInputText(req) {
  const i = req.input || {};
  if (req.toolName === 'Bash' && i.command) return i.command;
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
    case 'KillShell':
      return { title: 'Stop a running command?', desc: 'Claude wants to stop a background command.' };
    default:
      return {
        title: 'Allow this action?',
        desc: 'Claude wants to use the ' + (toolName || 'unknown') + ' tool.',
      };
  }
}

function showPermModal(req) {
  const friendly = permFriendly(req.toolName);
  el.permTitle.textContent = req.title || friendly.title;
  el.permDesc.textContent = req.description || friendly.desc;
  const inputTxt = permInputText(req);
  el.permInput.textContent = inputTxt;
  el.permInput.style.display = inputTxt ? '' : 'none';
  el.permModal.style.display = 'flex';

  const done = (allow) => {
    el.permModal.style.display = 'none';
    el.permAllow.onclick = null;
    el.permDeny.onclick = null;
    ipcRenderer.send('permission:response', { permId: req.permId, allow });
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
  document.body.classList.remove('theme-light', 'theme-contrast');
  if (theme === 'light') document.body.classList.add('theme-light');
  else if (theme === 'contrast') document.body.classList.add('theme-contrast');
  settings.theme = theme;
  localStorage.setItem('ccs.theme', theme);
}

async function openSettings() {
  el.setTheme.value = settings.theme;
  el.setModel.value = settings.model;
  el.setMode.value = localStorage.getItem('ccs.permissionMode') || 'default';
  el.setDataDir.textContent = state.defaultDir || '(unknown)';
  const auth = state.auth || (await checkAuth());
  el.setAuthLabel.textContent = (auth && auth.label) || 'Not signed in';
  el.setSignOut.style.display = auth && auth.source === 'apikey' ? '' : 'none';
  el.settingsModal.style.display = 'flex';
}

function wireSettings() {
  el.settingsBtn.onclick = () => openSettings();
  el.settingsClose.onclick = () => { el.settingsModal.style.display = 'none'; };
  el.settingsModal.onclick = (e) => {
    if (e.target === el.settingsModal) el.settingsModal.style.display = 'none';
  };
  el.setTheme.onchange = () => applyTheme(el.setTheme.value);
  el.setModel.onchange = () => {
    settings.model = el.setModel.value;
    localStorage.setItem('ccs.defaultModel', settings.model);
    toast('New chats will use ' + (el.setModel.options[el.setModel.selectedIndex].text));
  };
  el.setMode.onchange = () => {
    localStorage.setItem('ccs.permissionMode', el.setMode.value);
    toast('Default permission mode saved.');
  };
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
    { icon: '🎨', label: 'Cycle theme (dark / light / contrast)', hint: settings.theme, run: () => {
        const order = ['dark', 'light', 'contrast'];
        applyTheme(order[(order.indexOf(settings.theme) + 1) % order.length]);
        toast('Theme: ' + settings.theme);
      } },
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
  el.panes.style.display = 'none';
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
  showWelcome();
  setInterval(loadSessions, 12000);
}

init();
