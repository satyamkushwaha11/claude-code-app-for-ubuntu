'use strict';

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage } = require('electron');

// This app only loads local, trusted content. The Chromium SUID sandbox needs a
// root-owned helper that is often absent on Linux; disabling it is safe here.
app.commandLine.appendSwitch('no-sandbox');

const path = require('path');
const os = require('os');
const fs = require('fs');

// --- node-pty: powers the optional terminal view (native module) ------------
let pty = null;
let ptyError = null;
try {
  pty = require('node-pty');
} catch (err) {
  ptyError = String(err && err.message ? err.message : err);
}

// --- Claude Agent SDK: powers the chat view (ESM, loaded lazily) -------------
let sdk = null;
let sdkError = null;
async function loadSdk() {
  if (sdk) return sdk;
  try {
    sdk = await import('@anthropic-ai/claude-agent-sdk');
  } catch (err) {
    sdkError = String(err && err.stack ? err.stack : err);
  }
  return sdk;
}

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const DEFAULT_CHAT_DIR = path.join(HOME, 'ClaudeChats');
// Deleted chats are moved here (not erased) and kept for 30 days so they can be
// restored. Each trashed chat is a <id>.jsonl plus a <id>.meta.json sidecar.
const TRASH_DIR = path.join(HOME, '.claude', 'projects-trash');
const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Subscription OAuth credentials written by the `claude` CLI when signed in.
const CREDS_FILE = path.join(HOME, '.claude', '.credentials.json');
const CLAUDE_BIN = resolveClaude();

// ---------------------------------------------------------------------------
// Auth — detect a usable Claude account and let the user set one up in-app
// ---------------------------------------------------------------------------

function apiKeyFile() {
  return path.join(app.getPath('userData'), 'api-key.bin');
}

/** Persist the API key encrypted with the OS keychain (falls back to 0600 file). */
function saveApiKey(key) {
  const file = apiKeyFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(file, safeStorage.encryptString(key));
  } else {
    // No OS keychain available — store with restrictive perms and a marker.
    fs.writeFileSync(file, 'plain:' + key, { mode: 0o600 });
  }
}

function getStoredApiKey() {
  const file = apiKeyFile();
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (_) {
    return null;
  }
  try {
    if (buf.slice(0, 6).toString() === 'plain:') return buf.slice(6).toString();
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(buf);
    }
  } catch (_) {
    /* corrupt / unreadable */
  }
  return null;
}

function clearApiKey() {
  try { fs.unlinkSync(apiKeyFile()); } catch (_) { /* ignore */ }
  delete process.env.ANTHROPIC_API_KEY;
}

/** Read subscription OAuth creds; returns { ok, subscriptionType, expired }. */
function detectSubscription() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
  } catch (_) {
    return { ok: false };
  }
  const o = data && data.claudeAiOauth;
  if (!o || !o.accessToken) return { ok: false };
  const expired =
    typeof o.expiresAt === 'number' ? o.expiresAt < Date.now() : false;
  // Even if the access token is expired, a refresh token lets the CLI renew it,
  // so we still treat the account as usable.
  return {
    ok: true,
    subscriptionType: o.subscriptionType || '',
    expired,
    renewable: !!o.refreshToken,
  };
}

/**
 * Determine how (if at all) we can talk to Claude. Also applies a stored API key
 * to the environment so the Agent SDK / API picks it up. Order: stored key →
 * env key → subscription creds → none.
 */
function authStatus() {
  const stored = getStoredApiKey();
  if (stored) {
    process.env.ANTHROPIC_API_KEY = stored;
    return { authed: true, source: 'apikey', label: 'API key (saved)' };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { authed: true, source: 'apikey-env', label: 'API key (environment)' };
  }
  const sub = detectSubscription();
  if (sub.ok) {
    return {
      authed: true,
      source: 'subscription',
      label: sub.subscriptionType
        ? 'Claude subscription (' + sub.subscriptionType + ')'
        : 'Claude subscription',
      expired: sub.expired,
    };
  }
  return { authed: false, source: 'none', label: 'Not signed in' };
}

/** clientId -> pty process (terminal view) */
const ptys = new Map();
/** clientId -> { queue, abort, query, sessionId } (chat view) */
const chats = new Map();
/** permId -> resolve fn for a pending permission prompt */
const pendingPerms = new Map();
let permSeq = 0;
let win = null;

// Tools that only read/search — auto-approved, never prompt the user.
const AUTO_ALLOW_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite', 'BashOutput',
  'ListMcpResources', 'ReadMcpResource',
]);

function resolveClaude() {
  const candidates = [
    path.join(HOME, '.local', 'bin', 'claude'),
    path.join(HOME, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  for (const c of candidates) {
    try {
      fs.statSync(c);
      return c;
    } catch (_) {
      /* keep looking */
    }
  }
  return 'claude';
}

function ensureDefaultDir() {
  try {
    fs.mkdirSync(DEFAULT_CHAT_DIR, { recursive: true });
  } catch (_) {
    /* ignore */
  }
  return DEFAULT_CHAT_DIR;
}

// ---------------------------------------------------------------------------
// Reading saved sessions for the history sidebar
// ---------------------------------------------------------------------------

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ')
      .trim();
  }
  return '';
}

function parseSession(filePath) {
  const id = path.basename(filePath, '.jsonl');
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    return null;
  }
  let content;
  try {
    if (stat.size > 3 * 1024 * 1024) {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      content = buf.slice(0, n).toString('utf8');
    } else {
      content = fs.readFileSync(filePath, 'utf8');
    }
  } catch (_) {
    return null;
  }

  let title = '';
  let cwd = '';
  let firstUser = '';
  let userCount = 0;
  let assistantCount = 0;

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (obj.isSidechain) continue;
    if (obj.type === 'ai-title' && obj.aiTitle) {
      title = obj.aiTitle;
    } else if (obj.type === 'user') {
      userCount++;
      if (!cwd && obj.cwd) cwd = obj.cwd;
      if (!firstUser && obj.message) firstUser = extractText(obj.message.content);
    } else if (obj.type === 'assistant') {
      assistantCount++;
    }
  }
  if (userCount === 0) return null;

  return {
    id,
    file: filePath,
    title: title || firstUser.slice(0, 64) || 'Untitled chat',
    preview: firstUser.slice(0, 140),
    cwd,
    project: cwd ? path.basename(cwd) : 'unknown',
    messages: userCount + assistantCount,
    mtime: stat.mtimeMs,
  };
}

function listSessions() {
  const out = [];
  let dirs;
  try {
    dirs = fs.readdirSync(PROJECTS_DIR);
  } catch (_) {
    return out;
  }
  for (const dir of dirs) {
    const full = path.join(PROJECTS_DIR, dir);
    let files;
    try {
      if (!fs.statSync(full).isDirectory()) continue;
      files = fs.readdirSync(full);
    } catch (_) {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const meta = parseSession(path.join(full, f));
      if (meta) out.push(meta);
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// ---------------------------------------------------------------------------
// Trash — soft-delete chats, keep 30 days, allow restore
// ---------------------------------------------------------------------------

function ensureTrashDir() {
  try {
    fs.mkdirSync(TRASH_DIR, { recursive: true });
  } catch (_) {
    /* ignore */
  }
  return TRASH_DIR;
}

/** Remove trashed chats whose deletion is older than the 30-day window. */
function purgeOldTrash() {
  ensureTrashDir();
  let files;
  try {
    files = fs.readdirSync(TRASH_DIR);
  } catch (_) {
    return;
  }
  const now = Date.now();
  for (const f of files) {
    if (!f.endsWith('.meta.json')) continue;
    const metaPath = path.join(TRASH_DIR, f);
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (_) {
      continue;
    }
    if (meta.deletedAt && now - meta.deletedAt > TRASH_TTL_MS) {
      const id = f.slice(0, -'.meta.json'.length);
      try { fs.unlinkSync(path.join(TRASH_DIR, id + '.jsonl')); } catch (_) { /* ignore */ }
      try { fs.unlinkSync(metaPath); } catch (_) { /* ignore */ }
    }
  }
}

/** Move a chat's .jsonl into the trash with a metadata sidecar. */
function trashSession(meta) {
  ensureTrashDir();
  const src = meta.file;
  if (!src || !fs.existsSync(src)) throw new Error('Chat file not found.');
  const id = meta.id || path.basename(src, '.jsonl');
  const dest = path.join(TRASH_DIR, id + '.jsonl');
  fs.renameSync(src, dest);
  const record = {
    id,
    origPath: src,
    deletedAt: Date.now(),
    title: meta.title || '',
    cwd: meta.cwd || '',
    project: meta.project || '',
    preview: meta.preview || '',
    messages: meta.messages || 0,
  };
  fs.writeFileSync(path.join(TRASH_DIR, id + '.meta.json'), JSON.stringify(record));
  return record;
}

function listTrash() {
  purgeOldTrash();
  const out = [];
  let files;
  try {
    files = fs.readdirSync(TRASH_DIR);
  } catch (_) {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith('.meta.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(TRASH_DIR, f), 'utf8'));
      const expiresAt = (meta.deletedAt || 0) + TRASH_TTL_MS;
      out.push(Object.assign({}, meta, {
        expiresAt,
        daysLeft: Math.max(0, Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000))),
      }));
    } catch (_) {
      /* ignore */
    }
  }
  out.sort((a, b) => b.deletedAt - a.deletedAt);
  return out;
}

function restoreTrash(id) {
  const jsonl = path.join(TRASH_DIR, id + '.jsonl');
  const metaPath = path.join(TRASH_DIR, id + '.meta.json');
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (_) {
    throw new Error('Trashed chat metadata missing.');
  }
  let dest = meta.origPath;
  // If the original folder is gone, fall back to its parent project dir.
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
  } catch (_) {
    /* ignore */
  }
  if (fs.existsSync(dest)) {
    // Avoid clobbering a same-id file that reappeared.
    dest = dest.replace(/\.jsonl$/, '.restored.jsonl');
  }
  fs.renameSync(jsonl, dest);
  try { fs.unlinkSync(metaPath); } catch (_) { /* ignore */ }
  return { id, restoredTo: dest };
}

function deleteTrashForever(id) {
  try { fs.unlinkSync(path.join(TRASH_DIR, id + '.jsonl')); } catch (_) { /* ignore */ }
  try { fs.unlinkSync(path.join(TRASH_DIR, id + '.meta.json')); } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Streaming input queue — feeds user messages into a long-lived SDK query
// ---------------------------------------------------------------------------

const QUEUE_CLOSED = Symbol('closed');

function createInputQueue() {
  const items = [];
  const waiters = [];
  let closed = false;
  return {
    push(msg) {
      if (closed) return;
      if (waiters.length) waiters.shift()(msg);
      else items.push(msg);
    },
    close() {
      closed = true;
      while (waiters.length) waiters.shift()(QUEUE_CLOSED);
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (items.length) return Promise.resolve({ value: items.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve)).then((v) =>
            v === QUEUE_CLOSED
              ? { value: undefined, done: true }
              : { value: v, done: false }
          );
        },
        return() {
          closed = true;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Permissions — route tool-use requests to the renderer for Allow/Deny
// ---------------------------------------------------------------------------

function makeCanUseTool(clientId) {
  return (toolName, input, opts) => {
    if (AUTO_ALLOW_TOOLS.has(toolName)) {
      return Promise.resolve({ behavior: 'allow' });
    }
    const permId = 'perm' + ++permSeq;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        pendingPerms.delete(permId);
        resolve(result);
      };
      pendingPerms.set(permId, finish);
      if (opts && opts.signal) {
        opts.signal.addEventListener('abort', () =>
          finish({ behavior: 'deny', message: 'Cancelled.' })
        );
      }
      if (win) {
        win.webContents.send('permission:request', {
          clientId,
          permId,
          toolName,
          input,
          title: opts && opts.title,
          displayName: opts && opts.displayName,
          description: opts && opts.description,
        });
      } else {
        finish({ behavior: 'deny', message: 'No window available.' });
      }
    });
  };
}

ipcMain.on('permission:response', (_e, { permId, allow }) => {
  const finish = pendingPerms.get(permId);
  if (finish) {
    finish(
      allow
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: 'The user declined this action.' }
    );
  }
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function iconPath() {
  const png = path.join(__dirname, 'build', 'icon.png');
  try {
    fs.statSync(png);
    return png;
  } catch (_) {
    return undefined;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 820,
    minHeight: 520,
    backgroundColor: '#1c1a17',
    title: 'Claude Code Studio',
    icon: iconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      spellcheck: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

function cleanupAll() {
  for (const p of ptys.values()) {
    try {
      p.kill();
    } catch (_) {
      /* ignore */
    }
  }
  ptys.clear();
  for (const c of chats.values()) {
    try {
      c.close();
    } catch (_) {
      /* ignore */
    }
    try {
      c.abort.abort();
    } catch (_) {
      /* ignore */
    }
  }
  chats.clear();
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  ensureDefaultDir();
  purgeOldTrash();
  authStatus(); // applies a saved API key to the environment for this session
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  cleanupAll();
  app.quit();
});
app.on('before-quit', cleanupAll);

// ---------------------------------------------------------------------------
// IPC — general
// ---------------------------------------------------------------------------

ipcMain.handle('app:status', async () => {
  await loadSdk();
  return {
    sdkOk: !!sdk,
    sdkError,
    ptyOk: !!pty,
    ptyError,
    defaultDir: ensureDefaultDir(),
    home: HOME,
  };
});

ipcMain.handle('auth:status', () => {
  try {
    return Object.assign({ ok: true }, authStatus());
  } catch (err) {
    return { ok: false, authed: false, error: String(err) };
  }
});

ipcMain.handle('auth:saveApiKey', (_e, { key }) => {
  const k = (key || '').trim();
  if (!/^sk-ant-/.test(k)) {
    return { ok: false, error: 'That does not look like an Anthropic API key (it should start with "sk-ant-").' };
  }
  try {
    saveApiKey(k);
    process.env.ANTHROPIC_API_KEY = k;
    return Object.assign({ ok: true }, authStatus());
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('auth:clearApiKey', () => {
  try {
    clearApiKey();
    return Object.assign({ ok: true }, authStatus());
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('sessions:list', () => {
  try {
    return { ok: true, sessions: listSessions() };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('sessions:delete', (_e, meta) => {
  try {
    return { ok: true, record: trashSession(meta) };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('trash:list', () => {
  try {
    return { ok: true, items: listTrash() };
  } catch (err) {
    return { ok: false, error: String(err), items: [] };
  }
});

ipcMain.handle('trash:restore', (_e, { id }) => {
  try {
    return { ok: true, result: restoreTrash(id) };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('trash:deleteForever', (_e, { id }) => {
  try {
    deleteTrashForever(id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('dialog:pickFolder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a project folder for this chat',
    defaultPath: HOME,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true };
  return { canceled: false, path: res.filePaths[0] };
});

ipcMain.handle('dialog:pickFiles', async (_e, { cwd } = {}) => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Attach files to this message',
    defaultPath: cwd && fs.existsSync(cwd) ? cwd : HOME,
    properties: ['openFile', 'multiSelections'],
  });
  if (res.canceled || !res.filePaths.length) return { canceled: true, paths: [] };
  return { canceled: false, paths: res.filePaths };
});

ipcMain.handle('dialog:saveText', async (_e, { defaultName, text } = {}) => {
  try {
    const res = await dialog.showSaveDialog(win, {
      title: 'Export chat',
      defaultPath: path.join(HOME, defaultName || 'chat.md'),
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(res.filePath, String(text == null ? '' : text), 'utf8');
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.on('open:external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});

// Bounded, fast file search under a chat's cwd for @-mention autocomplete.
const FILE_SEARCH_SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'venv', '__pycache__']);
ipcMain.handle('files:search', (_e, { cwd, query } = {}) => {
  const root = cwd && fs.existsSync(cwd) ? cwd : null;
  if (!root) return { ok: false, files: [] };
  const q = String(query || '').toLowerCase();
  const matchesSub = (name) => {
    if (!q) return true;
    const t = name.toLowerCase();
    let i = 0;
    for (const ch of q) { i = t.indexOf(ch, i); if (i === -1) return false; i++; }
    return true;
  };
  const out = [];
  const MAX = 40;
  const MAX_VISIT = 6000;
  let visited = 0;
  const walk = (dir, depth) => {
    if (out.length >= MAX || visited >= MAX_VISIT || depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      if (out.length >= MAX || visited >= MAX_VISIT) return;
      visited++;
      if (ent.name.startsWith('.') && ent.name !== '.env') continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (FILE_SEARCH_SKIP.has(ent.name)) continue;
        walk(full, depth + 1);
      } else if (ent.isFile()) {
        const rel = path.relative(root, full);
        if (matchesSub(ent.name) || matchesSub(rel)) out.push(rel);
      }
    }
  };
  try { walk(root, 0); } catch (_) { /* ignore */ }
  // Prefer shallower paths and shorter names.
  out.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
  return { ok: true, files: out.slice(0, MAX) };
});

// ---------------------------------------------------------------------------
// IPC — chat sessions (Agent SDK)
// ---------------------------------------------------------------------------

// Pull the real model and skill/command lists from the live session and push
// them to the renderer so the toolbar dropdowns show authoritative options.
// These are local capability queries (no network), but the query must be past
// init, so we retry a few times.
async function fetchCapabilities(clientId, entry) {
  for (let i = 0; i < 8; i++) {
    const q = entry.query;
    if (!q) return;
    let models = [];
    let commands = [];
    try {
      if (typeof q.supportedModels === 'function') models = await q.supportedModels();
    } catch (_) { /* not ready yet */ }
    try {
      if (typeof q.supportedCommands === 'function') commands = await q.supportedCommands();
    } catch (_) { /* not ready yet */ }
    if ((models && models.length) || (commands && commands.length)) {
      if (win) win.webContents.send('chat:capabilities', { clientId, models, commands });
      return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

ipcMain.handle('chat:history', async (_e, { sessionId, cwd }) => {
  const s = await loadSdk();
  if (!s) return { ok: false, error: sdkError || 'SDK unavailable' };
  try {
    const messages = await s.getSessionMessages(
      sessionId,
      cwd ? { dir: cwd } : {}
    );
    return { ok: true, messages };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('chat:start', async (_e, opts) => {
  const s = await loadSdk();
  if (!s) return { ok: false, error: sdkError || 'SDK unavailable' };

  const { clientId, mode } = opts;
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : ensureDefaultDir();

  if (chats.has(clientId)) return { ok: true, reused: true };

  const queue = createInputQueue();
  const abort = new AbortController();
  const entry = {
    queue,
    abort,
    query: null,
    sessionId: mode === 'resume' ? opts.sessionId : null,
    close: () => queue.close(),
  };
  chats.set(clientId, entry);

  const PERM_MODES = new Set(['default', 'plan', 'acceptEdits', 'bypassPermissions']);
  const permissionMode = PERM_MODES.has(opts.permissionMode) ? opts.permissionMode : 'default';
  entry.permissionMode = permissionMode;

  const options = {
    cwd,
    abortController: abort,
    includePartialMessages: true,
    permissionMode,
    canUseTool: makeCanUseTool(clientId),
  };
  if (opts.model) options.model = opts.model;
  if (mode === 'resume' && opts.sessionId) options.resume = opts.sessionId;

  let q;
  try {
    q = s.query({ prompt: queue, options });
  } catch (err) {
    chats.delete(clientId);
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
  entry.query = q;

  (async () => {
    try {
      for await (const msg of q) {
        if (msg && msg.type === 'system' && msg.subtype === 'init') {
          entry.sessionId = msg.session_id;
          if (!entry.capsFetched) {
            entry.capsFetched = true;
            fetchCapabilities(clientId, entry);
          }
        }
        if (win) win.webContents.send('chat:message', { clientId, msg });
      }
    } catch (err) {
      if (win) {
        win.webContents.send('chat:error', {
          clientId,
          error: String(err && err.message ? err.message : err),
        });
      }
    } finally {
      if (win) win.webContents.send('chat:ended', { clientId });
    }
  })();

  return { ok: true };
});

ipcMain.on('chat:send', (_e, { clientId, text }) => {
  const entry = chats.get(clientId);
  if (!entry) return;
  entry.queue.push({
    type: 'user',
    message: { role: 'user', content: String(text) },
    parent_tool_use_id: null,
  });
});

ipcMain.handle('chat:models', async (_e, { clientId }) => {
  const entry = chats.get(clientId);
  if (!entry || !entry.query || typeof entry.query.supportedModels !== 'function') {
    return { ok: false, models: [] };
  }
  try {
    const models = await entry.query.supportedModels();
    return { ok: true, models };
  } catch (err) {
    return { ok: false, models: [], error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('chat:setModel', async (_e, { clientId, model }) => {
  const entry = chats.get(clientId);
  if (!entry || !entry.query || typeof entry.query.setModel !== 'function') {
    return { ok: false };
  }
  try {
    await entry.query.setModel(model || undefined);
    entry.model = model;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('chat:setPermissionMode', async (_e, { clientId, mode }) => {
  const PERM_MODES = new Set(['default', 'plan', 'acceptEdits', 'bypassPermissions']);
  if (!PERM_MODES.has(mode)) return { ok: false, error: 'Unknown permission mode.' };
  const entry = chats.get(clientId);
  if (!entry || !entry.query || typeof entry.query.setPermissionMode !== 'function') {
    return { ok: false, error: 'No active chat.' };
  }
  try {
    await entry.query.setPermissionMode(mode);
    entry.permissionMode = mode;
    return { ok: true, mode };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('chat:interrupt', async (_e, { clientId }) => {
  const entry = chats.get(clientId);
  if (entry && entry.query && typeof entry.query.interrupt === 'function') {
    try {
      await entry.query.interrupt();
    } catch (_) {
      /* ignore */
    }
  }
  return { ok: true };
});

ipcMain.on('chat:stop', (_e, { clientId }) => {
  const entry = chats.get(clientId);
  if (!entry) return;
  try {
    entry.close();
  } catch (_) {
    /* ignore */
  }
  try {
    entry.abort.abort();
  } catch (_) {
    /* ignore */
  }
  chats.delete(clientId);
});

// ---------------------------------------------------------------------------
// IPC — terminal sessions (node-pty)
// ---------------------------------------------------------------------------

ipcMain.handle('pty:create', (_e, opts) => {
  if (!pty) return { ok: false, error: 'node-pty is not available' };
  const { clientId, mode, cols, rows } = opts;
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : HOME;

  if (ptys.has(clientId)) return { ok: true, reused: true };

  // Session ids come from the renderer / on-disk session files and are
  // interpolated into a shell command below, so they MUST be validated to
  // prevent command injection (e.g. a crafted id like "x; rm -rf ~").
  const sid = typeof opts.sessionId === 'string' ? opts.sessionId : '';
  const safeSid = /^[a-zA-Z0-9._-]{1,128}$/.test(sid) ? sid : '';
  if (sid && !safeSid) {
    return { ok: false, error: 'Invalid session id.' };
  }

  let claudeArgs;
  if (mode === 'resume' && safeSid) {
    claudeArgs = `--resume ${safeSid}`;
  } else if (safeSid) {
    claudeArgs = `--session-id ${safeSid}`;
  } else {
    claudeArgs = '';
  }

  const shell = process.env.SHELL || '/bin/bash';
  const env = Object.assign({}, process.env, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  });
  env.PATH = [path.join(HOME, '.local', 'bin'), '/usr/local/bin', env.PATH || ''].join(':');

  let proc;
  try {
    proc = pty.spawn(shell, ['-c', `exec '${CLAUDE_BIN}' ${claudeArgs}`], {
      name: 'xterm-256color',
      cols: cols || 100,
      rows: rows || 30,
      cwd,
      env,
    });
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }

  ptys.set(clientId, proc);
  proc.onData((data) => {
    if (win) win.webContents.send('pty:data', { clientId, data });
  });
  proc.onExit(({ exitCode }) => {
    ptys.delete(clientId);
    if (win) win.webContents.send('pty:exit', { clientId, exitCode });
  });
  return { ok: true };
});

ipcMain.on('pty:input', (_e, { clientId, data }) => {
  const p = ptys.get(clientId);
  if (p) {
    try {
      p.write(data);
    } catch (_) {
      /* ignore */
    }
  }
});

ipcMain.on('pty:resize', (_e, { clientId, cols, rows }) => {
  const p = ptys.get(clientId);
  if (p && cols > 0 && rows > 0) {
    try {
      p.resize(cols, rows);
    } catch (_) {
      /* ignore */
    }
  }
});

ipcMain.on('pty:kill', (_e, { clientId }) => {
  const p = ptys.get(clientId);
  if (p) {
    try {
      p.kill();
    } catch (_) {
      /* ignore */
    }
    ptys.delete(clientId);
  }
});
