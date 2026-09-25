'use strict';

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, safeStorage, utilityProcess } = require('electron');

// This app only loads local, trusted content. The Chromium SUID sandbox needs a
// root-owned helper that is often absent on Linux; disabling it is safe here.
app.commandLine.appendSwitch('no-sandbox');
// Read-aloud replies use the system speech engine; on Linux Chromium only talks
// to speech-dispatcher when asked to.
app.commandLine.appendSwitch('enable-speech-dispatcher');

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

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
// Claude Code's own config dir; user- and local-scope MCP servers live in ~/.claude.json.
const CLAUDE_DIR = path.join(HOME, '.claude');
const CLAUDE_JSON = path.join(HOME, '.claude.json');
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
/** permId -> { finish, clientId, toolName } for a pending permission prompt */
const pendingPerms = new Map();
/** clientId -> Set(toolName) the user chose to always allow this session */
const alwaysAllow = new Map();
let permSeq = 0;
let win = null;

// Tools that only read/search — auto-approved, never prompt the user.
const AUTO_ALLOW_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite', 'BashOutput',
  'ListMcpResources', 'ReadMcpResource',
]);

// Tools that aren't really "permission" prompts — they ask the user for input.
// The renderer renders these as purpose-built cards inside the conversation
// instead of the generic Allow/Deny modal, and answers them by handing back an
// `updatedInput` the tool then reads (see PermissionResult.updatedInput).
const INTERACTIVE_TOOLS = new Map([
  ['AskUserQuestion', 'question'],
  ['ExitPlanMode', 'plan'],
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
    const kind = INTERACTIVE_TOOLS.get(toolName) || 'tool';
    if (kind === 'tool') {
      if (AUTO_ALLOW_TOOLS.has(toolName)) {
        return Promise.resolve({ behavior: 'allow' });
      }
      const remembered = alwaysAllow.get(clientId);
      if (remembered && remembered.has(toolName)) {
        return Promise.resolve({ behavior: 'allow' });
      }
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
      pendingPerms.set(permId, { finish, clientId, toolName });
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
          kind,
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

ipcMain.on('permission:response', (_e, { permId, allow, remember, updatedInput, message }) => {
  const pending = pendingPerms.get(permId);
  if (!pending) return;
  if (allow && remember && pending.clientId && pending.toolName) {
    let set = alwaysAllow.get(pending.clientId);
    if (!set) { set = new Set(); alwaysAllow.set(pending.clientId, set); }
    set.add(pending.toolName);
  }
  if (!allow) {
    pending.finish({
      behavior: 'deny',
      message: typeof message === 'string' && message
        ? message
        : 'The user declined this action.',
    });
    return;
  }
  // Interactive tools (AskUserQuestion) answer by rewriting the tool input.
  const isPlainObject =
    updatedInput && typeof updatedInput === 'object' && !Array.isArray(updatedInput);
  pending.finish(
    isPlainObject ? { behavior: 'allow', updatedInput } : { behavior: 'allow' }
  );
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
      webviewTag: true, // Artifacts panel previews run in an isolated <webview>
    },
  });
  // Artifact previews render files Claude generated — treat them as untrusted:
  // no Node, no preload, isolated context, regardless of what the tag asks for.
  win.webContents.on('will-attach-webview', (_e, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });
  // The mic is for the composer only — previews never get it. Everything else
  // keeps Electron's default of allowing the request.
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission !== 'media' || wc === (win && win.webContents));
  });
  win.webContents.on('did-attach-webview', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

function cleanupAll() {
  for (const w of artifactWatchers.values()) {
    try { w.close(); } catch (_) { /* ignore */ }
  }
  artifactWatchers.clear();
  for (const p of ptys.values()) {
    try {
      p.kill();
    } catch (_) {
      /* ignore */
    }
  }
  ptys.clear();
  for (const p of mcpLogins.values()) {
    try { p.kill(); } catch (_) { /* ignore */ }
  }
  mcpLogins.clear();
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
  if (sttProc) {
    try { sttProc.kill(); } catch (_) { /* ignore */ }
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  ensureDefaultDir();
  purgeOldTrash();
  authStatus(); // applies a saved API key to the environment for this session
  applyPrivacy(); // before any tab restores, so no claude process sees claude.ai connectors
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
  let claudeFound = false;
  try { fs.statSync(CLAUDE_BIN); claudeFound = true; } catch (_) { claudeFound = CLAUDE_BIN === 'claude'; }
  return {
    sdkOk: !!sdk,
    sdkError,
    ptyOk: !!pty,
    ptyError,
    defaultDir: ensureDefaultDir(),
    home: HOME,
    claudeBin: CLAUDE_BIN,
    claudeFound,
    platform: process.platform,
    versions: {
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
    },
    appVersion: app.getVersion(),
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
    filters: [
      { name: 'All files', extensions: ['*'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
    ],
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

ipcMain.on('win:focus', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

// ---------------------------------------------------------------------------
// MCP servers + privacy
// ---------------------------------------------------------------------------

// claude.ai connectors are stored on the claude.ai account, not this computer,
// so everyone signed in to the same account gets them. With "local MCP only"
// on (the default), every claude process the app starts (chat, terminal,
// `claude mcp`) inherits ENABLE_CLAUDEAI_MCP_SERVERS=false and skips them.
const LAUNCH_CLAUDEAI_MCP = process.env.ENABLE_CLAUDEAI_MCP_SERVERS;
const MCP_SCOPES = new Set(['user', 'local', 'project']);
const USER_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
// remoteControlAtStartup: "Enable Remote Control for all sessions";
// autoUploadSessions: "Mirror local sessions to claude.ai as view-only".
const SHARING_KEYS = ['remoteControlAtStartup', 'autoUploadSessions'];
// A stdio server that never answers stays "pending"; a remote one can take
// 15 s+ when the router stalls on IPv6 (AAAA) lookups. The panel shows each
// snapshot as it arrives, so the cap only bounds how long it keeps updating.
const MCP_PROBE_MS = 30000;
const MCP_LOGIN_MS = 5 * 60 * 1000;
const mcpLogins = new Map(); // server name -> hidden pty running `claude mcp login`
let mcpProbe = null; // { cwd, promise } — one status check at a time

function privacyFile() {
  return path.join(app.getPath('userData'), 'privacy.json');
}

function readPrivacy() {
  try {
    return JSON.parse(fs.readFileSync(privacyFile(), 'utf8')) || {};
  } catch (_) {
    return {};
  }
}

function localMcpOnly(prefs) {
  return prefs.localMcpOnly !== false;
}

function applyPrivacy(prefs = readPrivacy()) {
  if (localMcpOnly(prefs)) process.env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  else if (LAUNCH_CLAUDEAI_MCP === undefined) delete process.env.ENABLE_CLAUDEAI_MCP_SERVERS;
  else process.env.ENABLE_CLAUDEAI_MCP_SERVERS = LAUNCH_CLAUDEAI_MCP;
  return prefs;
}

function modeOf(p) {
  try {
    return fs.statSync(p).mode & 0o777;
  } catch (_) {
    return null;
  }
}

/** What another person on this computer (or on the same Claude login) could see. */
function privacyReport() {
  const files = [CLAUDE_DIR, CLAUDE_JSON].map((p) => {
    const m = modeOf(p);
    return {
      path: p.replace(HOME, '~'),
      mode: m == null ? null : m.toString(8),
      open: m != null && (m & 0o077) !== 0,
    };
  });
  // Both put sessions on claude.ai, where the whole account can see them. The
  // CLI reads settings first, then ~/.claude.json.
  const read = (f) => {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8')) || {};
    } catch (_) {
      return {};
    }
  };
  const settings = read(USER_SETTINGS);
  const config = read(CLAUDE_JSON);
  const on = (key) => (settings[key] != null ? settings[key] : config[key]) === true;
  return {
    localMcpOnly: localMcpOnly(readPrivacy()),
    files,
    remoteControl: on('remoteControlAtStartup'),
    mirrorSessions: on('autoUploadSessions'),
  };
}

function mcpCwd(cwd) {
  return cwd && fs.existsSync(cwd) ? cwd : ensureDefaultDir();
}

// Names reach the CLI as argv (no shell), but one starting with "-" would be
// read as a flag.
function validMcpName(name, strict) {
  if (typeof name !== 'string') return false;
  return strict ? /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name) : /^[^\s-][^\r\n]{0,99}$/.test(name);
}

function errText(err) {
  return String(err && err.message ? err.message : err);
}

/** Start a throwaway session (no prompt, nothing saved) and ask it which MCP
 *  servers it would load and how each one is doing. `onUpdate` gets every
 *  snapshot that differs from the last one. */
async function probeMcp(cwd, onUpdate) {
  const s = await loadSdk();
  if (!s) throw new Error(sdkError || 'SDK unavailable');
  const input = createInputQueue();
  const q = s.query({ prompt: input, options: { cwd, persistSession: false } });
  let timer;
  const deadline = Date.now() + MCP_PROBE_MS;
  const poll = (async () => {
    let last = '';
    for (;;) {
      const list = await q.mcpServerStatus();
      const key = JSON.stringify(list.map((x) => [x.name, x.status]));
      if (key !== last) {
        last = key;
        onUpdate(list);
      }
      if (!list.some((x) => x.status === 'pending') || Date.now() > deadline) return list;
      await new Promise((r) => setTimeout(r, 700));
    }
  })();
  poll.catch(() => {}); // may reject after close() if the timeout won
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Claude did not start in time.')), MCP_PROBE_MS + 10000);
  });
  try {
    return await Promise.race([poll, timeout]);
  } finally {
    clearTimeout(timer);
    input.close();
    try { q.close(); } catch (_) { /* already gone */ }
  }
}

// Only what the list shows: headers and env can hold API keys.
function mcpRow(x) {
  const c = x.config || {};
  return {
    name: x.name,
    status: x.status,
    scope: x.scope || '',
    type: c.type || (c.command ? 'stdio' : ''),
    target: c.url || [c.command].concat(c.args || []).filter(Boolean).join(' '),
    error: x.error || '',
    tools: Array.isArray(x.tools) ? x.tools.length : 0,
  };
}

function runClaude(args, cwd, env) {
  return new Promise((resolve) => {
    const opts = { cwd, timeout: 30000, env: Object.assign({}, process.env, env) };
    execFile(CLAUDE_BIN, args, opts, (err, stdout, stderr) => {
      const output = (String(stdout || '') + String(stderr || '')).trim();
      resolve({ ok: !err, output: output || (err ? errText(err) : '') });
    });
  });
}

// "Key: value" / "KEY=value", one per line.
function parsePairs(text, sep, keyRe, what) {
  const out = {};
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf(sep);
    const key = i > 0 ? line.slice(0, i).trim() : '';
    if (!keyRe.test(key)) throw new Error(`Couldn't read ${what} line "${line}".`);
    out[key] = line.slice(i + 1).trim();
  }
  return out;
}

function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(s || '')))) out.push(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]);
  return out;
}

function buildMcpConfig(c = {}) {
  if (c.type === 'http' || c.type === 'sse') {
    const url = String(c.url || '').trim();
    let u;
    try { u = new URL(url); } catch (_) { throw new Error('Enter a valid server URL.'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('The URL must start with https://');
    const cfg = { type: c.type, url };
    const headers = parsePairs(c.headers, ':', /^[A-Za-z0-9-]+$/, 'header');
    if (Object.keys(headers).length) cfg.headers = headers;
    // Your own OAuth app, for servers (e.g. Google) that won't register one
    // automatically. Redirect URI: http://localhost:<callbackPort>/callback.
    const clientId = String(c.clientId || '').trim();
    const port = String(c.callbackPort || '').trim();
    if (clientId || port) {
      cfg.oauth = {};
      if (clientId) {
        if (!/^[\w.:@/-]{1,300}$/.test(clientId)) throw new Error('That client ID has characters it shouldn\'t.');
        cfg.oauth.clientId = clientId;
      }
      if (port) {
        const n = Number(port);
        if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error('Callback port must be a number from 1024 to 65535.');
        cfg.oauth.callbackPort = n;
      }
    }
    return cfg;
  }
  if (c.type === 'stdio') {
    const command = String(c.command || '').trim();
    if (!command) throw new Error('Enter the command that starts the server.');
    const cfg = { type: 'stdio', command, args: splitArgs(c.args) };
    const env = parsePairs(c.env, '=', /^[A-Za-z_][A-Za-z0-9_]*$/, 'environment');
    if (Object.keys(env).length) cfg.env = env;
    return cfg;
  }
  throw new Error('Pick a server type.');
}

function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

ipcMain.handle('mcp:list', async (_e, { cwd } = {}) => {
  const dir = mcpCwd(cwd);
  if (!mcpProbe || mcpProbe.cwd !== dir) {
    const probe = {
      cwd: dir,
      promise: probeMcp(dir, (list) => {
        if (win) win.webContents.send('mcp:status', { cwd: dir, servers: list.map(mcpRow) });
      }),
    };
    mcpProbe = probe;
    probe.promise.catch(() => {}).then(() => { if (mcpProbe === probe) mcpProbe = null; });
  }
  try {
    const list = await mcpProbe.promise;
    return { ok: true, cwd: dir, servers: list.map(mcpRow) };
  } catch (err) {
    return { ok: false, cwd: dir, error: errText(err) };
  }
});

ipcMain.handle('mcp:add', async (_e, { name, scope, cwd, config } = {}) => {
  if (!validMcpName(name, true)) {
    return { ok: false, error: 'Use letters, numbers, dots, dashes or underscores for the name (no spaces).' };
  }
  if (!MCP_SCOPES.has(scope)) return { ok: false, error: 'Pick who can use this server.' };
  let cfg;
  try {
    cfg = buildMcpConfig(config);
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
  const args = ['mcp', 'add-json', name, JSON.stringify(cfg), '-s', scope];
  // The CLI keeps the secret in ~/.claude/.credentials.json, not the config.
  const secret = String((config && config.clientSecret) || '').trim();
  if (secret) args.push('--client-secret');
  const r = await runClaude(args, mcpCwd(cwd), secret ? { MCP_CLIENT_SECRET: secret } : {});
  mcpProbe = null;
  return r.ok ? r : { ok: false, error: r.output };
});

ipcMain.handle('mcp:remove', async (_e, { name, scope, cwd } = {}) => {
  if (!validMcpName(name) || !MCP_SCOPES.has(scope)) return { ok: false, error: 'Invalid server.' };
  const r = await runClaude(['mcp', 'remove', name, '-s', scope], mcpCwd(cwd));
  mcpProbe = null;
  return r.ok ? r : { ok: false, error: r.output };
});

ipcMain.handle('mcp:logout', async (_e, { name, cwd } = {}) => {
  if (!validMcpName(name)) return { ok: false, error: 'Invalid server.' };
  const r = await runClaude(['mcp', 'logout', name], mcpCwd(cwd));
  mcpProbe = null;
  return r.ok ? r : { ok: false, error: r.output };
});

// `claude mcp login` insists on a terminal, so it runs in a hidden pty. It
// opens the browser itself and exits once the OAuth callback lands; the first
// URL it prints is forwarded in case the browser didn't open.
ipcMain.handle('mcp:login', (_e, { name, cwd } = {}) => new Promise((resolve) => {
  if (!validMcpName(name)) return resolve({ ok: false, error: 'Invalid server.' });
  if (!pty) return resolve({ ok: false, error: 'Signing in needs the terminal module — run npm run rebuild.' });
  const prev = mcpLogins.get(name);
  if (prev) {
    try { prev.kill(); } catch (_) { /* ignore */ }
  }
  let proc;
  try {
    proc = pty.spawn(CLAUDE_BIN, ['mcp', 'login', name], {
      name: 'xterm-256color',
      cols: 400, // keep the authorize URL on one line
      rows: 30,
      cwd: mcpCwd(cwd),
      env: Object.assign({}, process.env, { TERM: 'xterm-256color' }),
    });
  } catch (err) {
    return resolve({ ok: false, error: errText(err) });
  }
  mcpLogins.set(name, proc);
  let out = '';
  let urlSent = false;
  const timer = setTimeout(() => {
    try { proc.kill(); } catch (_) { /* ignore */ }
  }, MCP_LOGIN_MS);
  proc.onData((d) => {
    out += d;
    if (urlSent) return;
    const m = stripAnsi(out).match(/https?:\/\/[^\s"'<>]+/);
    if (m && win) {
      urlSent = true;
      win.webContents.send('mcp:loginUrl', { name, url: m[0] });
    }
  });
  proc.onExit(({ exitCode }) => {
    clearTimeout(timer);
    if (mcpLogins.get(name) === proc) mcpLogins.delete(name);
    mcpProbe = null;
    const text = stripAnsi(out).trim();
    resolve(exitCode === 0 ? { ok: true, output: text } : { ok: false, error: text || 'Sign-in was cancelled.' });
  });
}));

ipcMain.on('mcp:loginCancel', (_e, { name } = {}) => {
  const p = mcpLogins.get(name);
  if (p) {
    try { p.kill(); } catch (_) { /* ignore */ }
  }
});

ipcMain.handle('privacy:get', () => privacyReport());

ipcMain.handle('privacy:set', (_e, { localMcpOnly } = {}) => {
  const prefs = Object.assign(readPrivacy(), { localMcpOnly: !!localMcpOnly });
  try {
    fs.writeFileSync(privacyFile(), JSON.stringify(prefs, null, 2), { mode: 0o600 });
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
  applyPrivacy(prefs);
  mcpProbe = null;
  return Object.assign({ ok: true }, privacyReport());
});

// Settings beat ~/.claude.json for these keys, so false here turns them off.
ipcMain.handle('privacy:stopSharing', () => {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(USER_SETTINGS, 'utf8')) || {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      return Object.assign(privacyReport(), { ok: false, error: 'Could not read ~/.claude/settings.json: ' + errText(err) });
    }
  }
  for (const key of SHARING_KEYS) cfg[key] = false;
  try {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(USER_SETTINGS, JSON.stringify(cfg, null, 2) + '\n');
  } catch (err) {
    return Object.assign(privacyReport(), { ok: false, error: errText(err) });
  }
  return Object.assign({ ok: true }, privacyReport());
});

// Only the owner may read Claude's config and chat transcripts.
ipcMain.handle('privacy:fixPerms', () => {
  const errors = [];
  for (const [p, mode] of [[CLAUDE_DIR, 0o700], [CLAUDE_JSON, 0o600], [CREDS_FILE, 0o600]]) {
    try {
      if (fs.existsSync(p)) fs.chmodSync(p, mode);
    } catch (err) {
      errors.push(errText(err));
    }
  }
  return Object.assign({ ok: !errors.length, error: errors.join('\n') }, privacyReport());
});

// ---------------------------------------------------------------------------
// Voice — local speech-to-text for the composer's mic button
// ---------------------------------------------------------------------------

const SPEECH_MODELS = new Set(['onnx-community/whisper-base', 'onnx-community/whisper-small']);
const SPEECH_CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'),
  'claude-code-studio', 'models');
let sttProc = null; // Whisper utility process, started on first use
const sttWaiters = new Map(); // request id -> resolve
let sttSeq = 0;

function sttWorker() {
  if (sttProc) return sttProc;
  sttProc = utilityProcess.fork(path.join(__dirname, 'stt-worker.js'), [], {
    serviceName: 'Claude Code Studio speech',
  });
  sttProc.on('message', (m) => {
    if (m && m.type === 'progress') {
      if (win) win.webContents.send('voice:progress', { loaded: m.loaded, total: m.total });
      return;
    }
    const done = m && sttWaiters.get(m.id);
    if (done) {
      sttWaiters.delete(m.id);
      done({ ok: !!m.ok, text: m.text || '', error: m.error });
    }
  });
  sttProc.on('exit', () => {
    sttProc = null;
    for (const done of sttWaiters.values()) {
      done({ ok: false, error: 'Speech recognition stopped unexpectedly.' });
    }
    sttWaiters.clear();
  });
  return sttProc;
}

// audio: 16 kHz mono Float32Array recorded by the renderer.
ipcMain.handle('voice:transcribe', (_e, { audio, model, language } = {}) => new Promise((resolve) => {
  const id = ++sttSeq;
  sttWaiters.set(id, resolve);
  sttWorker().postMessage({
    id,
    audio,
    model: SPEECH_MODELS.has(model) ? model : 'onnx-community/whisper-base',
    language: /^[a-z]{2,20}$/.test(language || '') ? language : 'english',
    cacheDir: SPEECH_CACHE,
  });
}));

// ---------------------------------------------------------------------------
// Artifacts — preview files Claude builds, entirely on this machine
// ---------------------------------------------------------------------------

const ARTIFACT_EXT = {
  html: 'html', htm: 'html', svg: 'svg', md: 'markdown', markdown: 'markdown',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
};
const ARTIFACT_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
/** watchId -> fs.FSWatcher */
const artifactWatchers = new Map();

function artifactExt(p) {
  return (path.extname(p || '').slice(1) || '').toLowerCase();
}

ipcMain.handle('artifact:read', (_e, { file, cwd } = {}) => {
  try {
    if (typeof file !== 'string' || !file) return { ok: false, error: 'No file given.' };
    const full = path.isAbsolute(file) ? file : path.resolve(cwd || HOME, file);
    const stat = fs.statSync(full);
    if (!stat.isFile()) return { ok: false, error: 'Not a file.' };
    if (stat.size > ARTIFACT_MAX_BYTES) return { ok: false, error: 'File is too large to preview.' };
    const ext = artifactExt(full);
    const kind = ARTIFACT_EXT[ext] || 'code';
    const out = { ok: true, path: full, name: path.basename(full), kind, ext, mtime: stat.mtimeMs, size: stat.size };
    if (kind === 'image') {
      out.dataUrl = 'data:' + ARTIFACT_MIME[ext] + ';base64,' + fs.readFileSync(full).toString('base64');
    } else {
      out.text = fs.readFileSync(full, 'utf8');
    }
    return out;
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

// A code block from the chat has no file yet — park it in the temp dir so the
// preview webview can load it like any other page.
ipcMain.handle('artifact:writeInline', (_e, { kind, code } = {}) => {
  try {
    const dir = path.join(app.getPath('temp'), 'ccs-artifacts');
    fs.mkdirSync(dir, { recursive: true });
    const ext = kind === 'svg' ? 'svg' : 'html';
    const hash = require('crypto').createHash('sha1').update(String(code || '')).digest('hex').slice(0, 12);
    const full = path.join(dir, 'snippet-' + hash + '.' + ext);
    fs.writeFileSync(full, String(code || ''), 'utf8');
    return { ok: true, path: full };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

// Live reload: watch the artifact's folder so edits to the page *or* its
// stylesheet/script refresh the preview.
ipcMain.on('artifact:watch', (_e, { watchId, file } = {}) => {
  if (!watchId || typeof file !== 'string') return;
  const prev = artifactWatchers.get(watchId);
  if (prev) { try { prev.close(); } catch (_) { /* ignore */ } }
  let timer = null;
  try {
    const w = fs.watch(path.dirname(file), () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (win) win.webContents.send('artifact:changed', { watchId, file });
      }, 250);
    });
    w.on('error', () => { /* folder went away */ });
    artifactWatchers.set(watchId, w);
  } catch (_) { /* unwatchable — preview still works, just no live reload */ }
});

ipcMain.on('artifact:unwatch', (_e, { watchId } = {}) => {
  const w = artifactWatchers.get(watchId);
  if (w) { try { w.close(); } catch (_) { /* ignore */ } }
  artifactWatchers.delete(watchId);
});

// Every previewable file in a project, newest first — the project's gallery.
ipcMain.handle('artifacts:scan', (_e, { cwd } = {}) => {
  const root = cwd && fs.existsSync(cwd) ? cwd : null;
  if (!root) return { ok: false, files: [] };
  const out = [];
  let visited = 0;
  const walk = (dir, depth) => {
    if (out.length >= 200 || visited >= 8000 || depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      if (out.length >= 200 || visited >= 8000) return;
      visited++;
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!FILE_SEARCH_SKIP.has(ent.name)) walk(full, depth + 1);
      } else if (ent.isFile()) {
        const kind = ARTIFACT_EXT[artifactExt(ent.name)];
        if (!kind) continue;
        try {
          out.push({ path: full, rel: path.relative(root, full), kind, mtime: fs.statSync(full).mtimeMs });
        } catch (_) { /* ignore */ }
      }
    }
  };
  try { walk(root, 0); } catch (_) { /* ignore */ }
  out.sort((a, b) => b.mtime - a.mtime);
  return { ok: true, files: out };
});

ipcMain.on('open:path', (_e, p) => {
  if (typeof p === 'string' && path.isAbsolute(p) && fs.existsSync(p)) shell.openPath(p);
});
ipcMain.on('open:reveal', (_e, p) => {
  if (typeof p === 'string' && path.isAbsolute(p) && fs.existsSync(p)) shell.showItemInFolder(p);
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

// 'default' is what the composer calls Manual (ask each time).
const PERM_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

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

  const permissionMode = PERM_MODES.has(opts.permissionMode) ? opts.permissionMode : 'default';
  entry.permissionMode = permissionMode;

  const options = {
    cwd,
    abortController: abort,
    includePartialMessages: true,
    permissionMode,
    // Only makes Bypass selectable mid-session; the chat still starts in the
    // mode picked above.
    allowDangerouslySkipPermissions: true,
    canUseTool: makeCanUseTool(clientId),
  };
  if (opts.model) options.model = opts.model;
  if (EFFORT_LEVELS.has(opts.effort)) options.effort = opts.effort;
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

// Turn composer text + attachments into API content. Images and small PDFs
// become base64 image/document blocks the model actually sees; other files
// become @path references in the text so Claude reads them with its own tools.
function buildUserContent(text, attachments) {
  const atts = Array.isArray(attachments) ? attachments : [];
  let t = String(text == null ? '' : text);
  if (!atts.length) return t;

  const blocks = [];
  const filePaths = [];
  for (const a of atts) {
    if (!a) continue;
    if (a.kind === 'image' && a.base64 && a.mediaType) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: a.mediaType, data: a.base64 },
      });
    } else if (a.kind === 'pdf' && a.base64) {
      // Native PDF input: Claude sees each page's text and image.
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: a.base64 },
        title: String(a.name || 'document.pdf'),
      });
    } else if (a.path) {
      filePaths.push(a.path);
    }
  }
  if (filePaths.length) {
    t += (t ? '\n\n' : '') +
      'Attached files:\n' + filePaths.map((p) => '@' + p).join('\n');
  }
  if (t) blocks.push({ type: 'text', text: t });
  if (!blocks.length) return String(text == null ? '' : text);
  return blocks;
}

ipcMain.on('chat:send', (_e, { clientId, text, attachments }) => {
  const entry = chats.get(clientId);
  if (!entry) return;
  entry.queue.push({
    type: 'user',
    message: { role: 'user', content: buildUserContent(text, attachments) },
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
    // e.g. "auto mode unavailable for this model" — the session refused it.
    return { ok: false, rejected: true, error: String(err && err.message ? err.message : err) };
  }
});

// Effort changes mid-session through the flag-settings layer; null clears it
// back to the model's default.
ipcMain.handle('chat:setEffort', async (_e, { clientId, effort }) => {
  if (effort && !EFFORT_LEVELS.has(effort)) return { ok: false, error: 'Unknown effort level.' };
  const entry = chats.get(clientId);
  if (!entry || !entry.query || typeof entry.query.applyFlagSettings !== 'function') {
    return { ok: false, error: 'No active chat.' };
  }
  try {
    await entry.query.applyFlagSettings({ effortLevel: effort || null });
    return { ok: true };
  } catch (err) {
    return { ok: false, rejected: true, error: String(err && err.message ? err.message : err) };
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
  alwaysAllow.delete(clientId);
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
