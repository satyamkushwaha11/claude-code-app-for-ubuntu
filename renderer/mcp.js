'use strict';

// MCP servers & privacy panel. Lists the servers a new session would load (a
// throwaway session in main.js reports them), adds/removes them through
// `claude mcp`, runs OAuth sign-in, and owns the "local MCP only" switch that
// keeps claude.ai account connectors out of every session. Server names, URLs
// and errors come from config files and remote servers — always escape them.

const { ipcRenderer } = require('electron');

const SCOPES = [
  { key: 'user', label: 'Only me · every project', hint: 'Saved in ~/.claude.json on this computer.' },
  { key: 'local', label: 'Only me · this project', hint: 'Saved in ~/.claude.json, used only in this project folder.' },
  {
    key: 'project', label: 'Everyone with this project',
    hint: 'Written to .mcp.json in the project folder — anyone who gets the folder (e.g. through git) gets this server and any keys in it.',
  },
];

const GROUP_TITLES = {
  user: 'Only me · every project',
  local: 'Only me · this project',
  project: 'Everyone with this project (.mcp.json)',
  claudeai: 'claude.ai account — shared with everyone signed in to it',
};
const GROUP_ORDER = ['user', 'local', 'project', 'claudeai'];

// Hosted servers. Most sign in through the browser on their own; Google's
// refuse automatic client registration, so they need your own OAuth client.
const PRESETS = [
  { name: 'figma', label: 'Figma', type: 'http', url: 'https://mcp.figma.com/mcp' },
  { name: 'notion', label: 'Notion', type: 'http', url: 'https://mcp.notion.com/mcp' },
  { name: 'miro', label: 'Miro', type: 'http', url: 'https://mcp.miro.com' },
  { name: 'sentry', label: 'Sentry', type: 'http', url: 'https://mcp.sentry.dev/mcp' },
  { name: 'gmail', label: 'Gmail', type: 'http', url: 'https://gmailmcp.googleapis.com/mcp/v1', ownClient: true },
  { name: 'gcal', label: 'Google Calendar', type: 'http', url: 'https://calendarmcp.googleapis.com/mcp/v1', ownClient: true },
  { name: 'gdrive', label: 'Google Drive', type: 'http', url: 'https://drivemcp.googleapis.com/mcp/v1', ownClient: true },
];
const DEFAULT_CALLBACK_PORT = '53682';

const STATUS = {
  connected: { dot: 'ok', text: 'Connected' },
  'needs-auth': { dot: 'warn', text: 'Needs sign-in' },
  pending: { dot: 'warn', text: 'Connecting…' },
  failed: { dot: 'bad', text: 'Failed' },
  disabled: { dot: 'off', text: 'Disabled' },
};

const CONNECTORS_URL = 'https://claude.ai/settings/connectors';

function lastLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const l = lines.length ? lines[lines.length - 1] : '';
  return l.length > 220 ? l.slice(0, 220) + '…' : l;
}

function blankForm() {
  return {
    name: '', type: 'http', url: '', headers: '', command: '', args: '', env: '',
    clientId: '', clientSecret: '', callbackPort: '', ownClient: false, scope: 'user', error: '',
  };
}

class McpPanel {
  constructor({ getCwd, toast, confirmDialog, escapeHtml }) {
    this.getCwd = getCwd;
    this.toast = toast;
    this.confirm = confirmDialog;
    this.esc = escapeHtml;
    this.modal = document.getElementById('mcpModal');
    this.body = document.getElementById('mcpBody');
    this.servers = null; // null until the first status snapshot
    this.checking = false; // a status check is still running; rows may update
    this.error = '';
    this.report = null;
    this.cwd = '';
    this.form = null; // add-server form values while it is open
    this.busy = new Set(); // server names with an action running
    this.logins = new Map(); // server name -> sign-in URL ('' until main sees it)
    this.seq = 0;

    this.body.innerHTML =
      '<div class="mcp-privacy"></div><div class="mcp-servers"></div><div class="mcp-add"></div>' +
      '<div class="mcp-note mcp-foot">Changes apply to chats and terminals you open from now on. ' +
      'Ones already open keep their servers until you close and reopen them.</div>';
    this.elPrivacy = this.body.querySelector('.mcp-privacy');
    this.elServers = this.body.querySelector('.mcp-servers');
    this.elAdd = this.body.querySelector('.mcp-add');

    document.getElementById('mcpClose').onclick = () => this.close();
    this.modal.onclick = (e) => { if (e.target === this.modal) this.close(); };
    this.body.addEventListener('click', (e) => this._onClick(e));
    this.body.addEventListener('change', (e) => this._onChange(e));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen() && !document.querySelector('.confirm-card')) this.close();
    });
    // Live snapshots while a check runs — one slow server shouldn't hide the rest.
    ipcRenderer.on('mcp:status', (_e, { cwd, servers }) => {
      if (!this.checking || (this.cwd && cwd !== this.cwd)) return;
      this.servers = servers;
      this.renderServers();
    });
    ipcRenderer.on('mcp:loginUrl', (_e, { name, url }) => {
      if (!this.logins.has(name)) return;
      this.logins.set(name, url);
      this.renderServers();
    });
  }

  isOpen() {
    return this.modal.style.display !== 'none';
  }

  async open() {
    this.cwd = this.getCwd() || '';
    this.modal.style.display = 'flex';
    this.report = await ipcRenderer.invoke('privacy:get');
    this.renderPrivacy();
    this.renderForm();
    this.refresh();
  }

  close() {
    this.modal.style.display = 'none';
    this.form = null;
  }

  async refresh() {
    const seq = ++this.seq;
    this.servers = null;
    this.checking = true;
    this.error = '';
    this.renderServers();
    const r = await ipcRenderer.invoke('mcp:list', { cwd: this.cwd });
    if (seq !== this.seq) return;
    this.checking = false;
    this.servers = r.ok ? r.servers : [];
    this.error = r.ok ? '' : r.error || 'Could not check servers.';
    if (r.cwd) this.cwd = r.cwd;
    this.renderServers();
  }

  // ---- rendering ----------------------------------------------------------

  renderPrivacy() {
    const esc = this.esc;
    const rep = this.report || { files: [] };
    const open = rep.files.filter((f) => f.open);
    let html =
      '<div class="mcp-section">' +
      '<div class="mcp-toggle-row"><div>' +
      '<div class="settings-label">Use only MCP servers on this computer</div>' +
      '<div class="mcp-note">Connectors linked on claude.ai (Gmail, Drive, Figma…) are stored on the claude.ai ' +
      'account, so everyone signed in to that account can use them. Turn this on to ignore them — only servers ' +
      'saved here, under your Linux user, are loaded.</div>' +
      '</div><label class="switch" title="Use only MCP servers on this computer">' +
      '<input type="checkbox" data-act="local-only"' + (rep.localMcpOnly ? ' checked' : '') + ' />' +
      '<span class="slider"></span></label></div>';

    if (open.length) {
      html += '<div class="mcp-check warn"><span>⚠ ' +
        open.map((f) => '<code>' + esc(f.path) + '</code>').join(' and ') +
        ' can be opened by other users on this computer (permissions ' +
        open.map((f) => esc(f.mode)).join(', ') + '). This is where your chats and MCP settings live.</span>' +
        '<button class="settings-btn" data-act="fix-perms">Make private</button></div>';
    } else {
      html += '<div class="mcp-check ok">✓ Your chat history and MCP settings (<code>~/.claude</code>) are stored ' +
        'only on this computer and readable only by you.</div>';
    }
    const sharing = [rep.remoteControl && 'Remote Control', rep.mirrorSessions && 'session mirroring'].filter(Boolean);
    html += sharing.length
      ? '<div class="mcp-check warn"><span>⚠ ' + sharing.join(' and ') + (sharing.length > 1 ? ' are' : ' is') +
        ' on: your sessions show up on claude.ai for anyone signed in to this account.</span>' +
        '<button class="settings-btn" data-act="stop-sharing">Turn off</button></div>'
      : '<div class="mcp-check ok">✓ Remote Control and session mirroring are off — your sessions aren\'t ' +
        'uploaded to claude.ai.</div>';
    html += '</div>';
    this.elPrivacy.innerHTML = html;
  }

  renderServers() {
    const esc = this.esc;
    const project = this.cwd ? this.cwd.replace(/\/+$/, '').split('/').pop() : '';
    let html =
      '<div class="mcp-section"><div class="mcp-head">' +
      '<div class="settings-label">Servers</div>' +
      (project ? '<span class="mcp-project" title="' + esc(this.cwd) + '">Project: ' + esc(project) + '</span>' : '') +
      (this.checking && this.servers && this.servers.length ? '<span class="mcp-project">Checking…</span>' : '') +
      '<button class="settings-btn" data-act="refresh"' + (this.checking ? ' disabled' : '') + '>⟳ Refresh</button>' +
      '<button class="settings-btn primary" data-act="add">＋ Add server</button></div>';

    if (!this.servers || (this.checking && !this.servers.length)) {
      html += '<div class="mcp-empty">Checking servers…</div>';
    } else if (this.error) {
      html += '<div class="mcp-empty err">' + esc(this.error) + '</div>';
    } else if (!this.servers.length) {
      html += '<div class="mcp-empty">No MCP servers yet. Add one — it\'s saved only on this computer.' +
        (this.report && this.report.localMcpOnly ? ' claude.ai connectors are hidden.' : '') + '</div>';
    } else {
      const scopes = GROUP_ORDER.concat([...new Set(this.servers.map((s) => s.scope))]
        .filter((k) => !GROUP_ORDER.includes(k)));
      for (const scope of scopes) {
        const rows = this.servers.map((s, i) => [s, i]).filter(([s]) => s.scope === scope);
        if (!rows.length) continue;
        html += '<div class="mcp-group' + (scope === 'claudeai' ? ' shared' : '') + '">' +
          esc(GROUP_TITLES[scope] || scope || 'Other') + '</div>';
        for (const [s, i] of rows) html += this._row(s, i);
      }
    }
    html += '</div>';
    this.elServers.innerHTML = html;
  }

  _row(s, i) {
    const esc = this.esc;
    const remote = s.type === 'http' || s.type === 'sse';
    let st = STATUS[s.status] || { dot: 'off', text: s.status || 'Unknown' };
    if (s.status === 'pending' && !this.checking) {
      st = { dot: 'warn', text: remote ? 'Still connecting — slow to reach' : 'Still starting' };
    }
    const busy = this.busy.has(s.name) ? ' disabled' : '';
    const statusText = s.status === 'connected' && s.tools
      ? st.text + ' · ' + s.tools + ' tool' + (s.tools === 1 ? '' : 's') : st.text;
    const sub = [statusText, s.type === 'claudeai-proxy' ? '' : s.type, s.target].filter(Boolean);

    let actions = '';
    if (this.logins.has(s.name)) {
      actions = '<button class="settings-btn" data-act="login-cancel" data-i="' + i + '">Cancel</button>';
    } else if (s.scope === 'claudeai') {
      actions = '<button class="settings-btn" data-act="open-url" data-url="' + CONNECTORS_URL +
        '">Manage on claude.ai</button>';
    } else {
      if (remote && (s.status === 'needs-auth' || s.status === 'failed')) {
        actions += '<button class="settings-btn primary" data-act="login" data-i="' + i + '"' + busy + '>Sign in</button>';
      } else if (remote && s.status === 'connected') {
        actions += '<button class="settings-btn" data-act="logout" data-i="' + i + '"' + busy + '>Sign out</button>';
      }
      if (SCOPES.some((x) => x.key === s.scope)) {
        actions += '<button class="settings-btn ghost" data-act="remove" data-i="' + i + '"' + busy + '>Remove</button>';
      }
    }

    let extra = '';
    if (s.error) extra += '<div class="mcp-err">' + esc(lastLine(s.error)) + '</div>';
    if (this.logins.has(s.name)) {
      const url = this.logins.get(s.name);
      extra += '<div class="mcp-login">Finish signing in to your own account in the browser window that opened.' +
        (url ? ' <a href="#" data-act="open-url" data-url="' + esc(url) + '">Open the sign-in page again</a>' : '') +
        '</div>';
    }
    return '<div class="mcp-row"><span class="diag-dot ' + st.dot + '"></span>' +
      '<div class="mcp-row-main"><div class="mcp-name">' + esc(s.name) + '</div>' +
      '<div class="mcp-sub" title="' + esc(s.target) + '">' + esc(sub.join(' · ')) + '</div>' + extra + '</div>' +
      '<div class="mcp-actions">' + actions + '</div></div>';
  }

  renderForm() {
    const f = this.form;
    if (!f) {
      this.elAdd.innerHTML = '';
      return;
    }
    const esc = this.esc;
    const input = (field, placeholder) =>
      '<input class="mcp-input" data-f="' + field + '" value="' + esc(f[field]) + '" placeholder="' +
      esc(placeholder) + '" spellcheck="false" />';
    const area = (field, placeholder) =>
      '<textarea class="mcp-input" data-f="' + field + '" rows="2" placeholder="' + esc(placeholder) +
      '" spellcheck="false">' + esc(f[field]) + '</textarea>';
    const opt = (v, label) => '<option value="' + v + '"' + (f.type === v ? ' selected' : '') + '>' + label + '</option>';

    let html =
      '<div class="mcp-section mcp-form">' +
      '<div class="settings-label">Add a server</div>' +
      '<div class="mcp-presets"><span class="mcp-opt">Quick add:</span>' +
      PRESETS.map((p, i) => '<button class="mcp-chip" data-act="preset" data-i="' + i + '">' + esc(p.label) + '</button>').join('') +
      '</div>' +
      '<div class="mcp-grid">' +
      '<label class="mcp-field">Name' + input('name', 'e.g. figma') + '</label>' +
      '<label class="mcp-field">Type<select class="mcp-input" data-f="type">' +
      opt('http', 'Remote server (HTTP)') + opt('sse', 'Remote server (SSE)') + opt('stdio', 'Command on this computer') +
      '</select></label></div>';
    if (f.type === 'stdio') {
      html +=
        '<label class="mcp-field">Command' + input('command', 'e.g. npx') + '</label>' +
        '<label class="mcp-field">Arguments' + input('args', 'e.g. -y @modelcontextprotocol/server-filesystem ~/Documents') + '</label>' +
        '<label class="mcp-field">Environment <span class="mcp-opt">optional · one KEY=value per line</span>' +
        area('env', 'API_KEY=…') + '</label>';
    } else {
      const port = f.callbackPort || DEFAULT_CALLBACK_PORT;
      html +=
        '<label class="mcp-field">URL' + input('url', 'https://…') + '</label>' +
        '<label class="mcp-field">Headers <span class="mcp-opt">optional · one per line · leave empty for browser sign-in</span>' +
        area('headers', 'Authorization: Bearer …') + '</label>' +
        '<details class="mcp-details"' + (f.ownClient || f.clientId ? ' open' : '') + '>' +
        '<summary>Use my own sign-in app (OAuth client)' + (f.ownClient ? ' — required for Google' : '') + '</summary>' +
        '<div class="mcp-note">For servers that don\'t let Claude Code register itself, like Google\'s. ' +
        (f.ownClient
          ? 'In Google Cloud Console enable the API for this service, then under APIs &amp; Services → Credentials ' +
            'create an OAuth client ID (type: Web application) '
          : 'Create an OAuth app with the service ') +
        'and add this redirect URI: <code>http://localhost:' + esc(port) + '/callback</code>. ' +
        'You then sign in with your own account; the token stays on this computer.</div>' +
        '<div class="mcp-grid">' +
        '<label class="mcp-field">Client ID' + input('clientId', 'e.g. 1234….apps.googleusercontent.com') + '</label>' +
        '<label class="mcp-field">Client secret' +
        '<input class="mcp-input" type="password" data-f="clientSecret" value="' + esc(f.clientSecret) +
        '" autocomplete="off" spellcheck="false" /></label>' +
        '</div>' +
        '<label class="mcp-field">Callback port <span class="mcp-opt">must match the redirect URI</span>' +
        input('callbackPort', DEFAULT_CALLBACK_PORT) + '</label>' +
        '</details>';
    }
    html += '<div class="mcp-field">Who can use it';
    for (const s of SCOPES) {
      html += '<label class="mcp-radio' + (s.key === 'project' ? ' risky' : '') + '">' +
        '<input type="radio" name="mcpScope" data-f="scope" value="' + s.key + '"' + (f.scope === s.key ? ' checked' : '') + ' />' +
        '<span><b>' + esc(s.label) + (s.key === 'user' ? ' (recommended)' : '') + '</b><small>' + esc(s.hint) + '</small></span></label>';
    }
    html += '</div>';
    if (f.scope !== 'user' && this.cwd) {
      html += '<div class="mcp-note">Project folder: <code>' + esc(this.cwd) + '</code></div>';
    }
    html += '<div class="mcp-note">Keys and tokens you type here are saved as plain text in ' +
      (f.scope === 'project' ? '<code>.mcp.json</code> — don\'t put personal keys in a shared project.' :
        '<code>~/.claude.json</code>, which only you can read.') + ' Browser sign-ins and client secrets go to ' +
      '<code>~/.claude/.credentials.json</code>, also only readable by you.</div>';
    if (f.error) html += '<div class="mcp-err">' + esc(f.error) + '</div>';
    html += '<div class="mcp-form-actions">' +
      '<button class="settings-btn" data-act="form-cancel">Cancel</button>' +
      '<button class="settings-btn primary" data-act="form-save">Add server</button></div></div>';
    this.elAdd.innerHTML = html;
  }

  _readForm() {
    if (!this.form) return;
    for (const node of this.elAdd.querySelectorAll('[data-f]')) {
      if (node.type === 'radio') {
        if (node.checked) this.form.scope = node.value;
      } else {
        this.form[node.dataset.f] = node.value;
      }
    }
  }

  // ---- actions ------------------------------------------------------------

  _onChange(e) {
    const t = e.target;
    if (t.dataset.act === 'local-only') return this._setLocalOnly(t);
    if (t.dataset.f === 'type' || t.dataset.f === 'scope' || t.dataset.f === 'callbackPort') {
      this._readForm();
      this.renderForm();
    }
  }

  _onClick(e) {
    const t = e.target.closest('[data-act]');
    if (!t || t.tagName === 'INPUT') return;
    e.preventDefault();
    const s = this.servers && t.dataset.i != null ? this.servers[Number(t.dataset.i)] : null;
    switch (t.dataset.act) {
      case 'refresh': return this.refresh();
      case 'add':
        this.form = this.form || blankForm();
        this.renderForm();
        this.elAdd.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return this.elAdd.querySelector('[data-f="name"]').focus();
      case 'preset': {
        this._readForm();
        const p = PRESETS[Number(t.dataset.i)];
        Object.assign(this.form, {
          name: p.name, type: p.type, url: p.url, headers: '', error: '', ownClient: !!p.ownClient,
          callbackPort: p.ownClient ? this.form.callbackPort || DEFAULT_CALLBACK_PORT : this.form.callbackPort,
        });
        return this.renderForm();
      }
      case 'form-cancel':
        this.form = null;
        return this.renderForm();
      case 'form-save': return this._save(t);
      case 'login': return s && this._login(s);
      case 'login-cancel': return s && ipcRenderer.send('mcp:loginCancel', { name: s.name });
      case 'logout': return s && this._logout(s);
      case 'remove': return s && this._remove(s);
      case 'open-url': return ipcRenderer.send('open:external', t.dataset.url);
      case 'fix-perms': return this._fixPerms();
      case 'stop-sharing': return this._stopSharing();
    }
  }

  async _setLocalOnly(input) {
    const on = input.checked;
    const r = await ipcRenderer.invoke('privacy:set', { localMcpOnly: on });
    if (!r.ok) {
      input.checked = !on;
      return this.toast('Could not save: ' + (r.error || 'unknown'), 'error');
    }
    this.report = r;
    this.renderPrivacy();
    this.toast(on ? 'claude.ai connectors are off. New chats use only servers on this computer.'
      : 'claude.ai connectors are back on for new chats.');
    this.refresh();
  }

  async _save(btn) {
    this._readForm();
    const f = this.form;
    btn.disabled = true;
    btn.textContent = 'Adding…';
    const r = await ipcRenderer.invoke('mcp:add', {
      name: f.name.trim(),
      scope: f.scope,
      cwd: this.cwd,
      config: {
        type: f.type, url: f.url, headers: f.headers, command: f.command, args: f.args, env: f.env,
        clientId: f.clientId, clientSecret: f.clientSecret, callbackPort: f.callbackPort,
      },
    });
    if (!r.ok) {
      f.error = lastLine(r.error) || 'Could not add the server.';
      return this.renderForm();
    }
    const remote = f.type !== 'stdio' && !f.headers.trim();
    this.form = null;
    this.renderForm();
    this.toast('Added ' + f.name.trim() + '.' + (remote ? ' Click Sign in if it asks for an account.' : ''));
    this.refresh();
  }

  async _login(s) {
    this.logins.set(s.name, '');
    this.renderServers();
    const r = await ipcRenderer.invoke('mcp:login', { name: s.name, cwd: this.cwd });
    this.logins.delete(s.name);
    if (r.ok) this.toast('Signed in to ' + s.name + '.');
    else this.toast('Sign-in didn\'t finish: ' + (lastLine(r.error) || 'unknown'), 'error');
    if (this.isOpen()) this.refresh();
  }

  async _logout(s) {
    this.busy.add(s.name);
    this.renderServers();
    const r = await ipcRenderer.invoke('mcp:logout', { name: s.name, cwd: this.cwd });
    this.busy.delete(s.name);
    if (r.ok) this.toast('Signed out of ' + s.name + '. Its token was deleted from this computer.');
    else this.toast('Could not sign out: ' + (lastLine(r.error) || 'unknown'), 'error');
    this.refresh();
  }

  async _remove(s) {
    const msg = 'Remove the MCP server "' + s.name + '"?' +
      (s.scope === 'project' ? ' This edits .mcp.json in the project folder.' : '');
    if (!(await this.confirm(msg, { danger: true }))) return;
    this.busy.add(s.name);
    this.renderServers();
    const r = await ipcRenderer.invoke('mcp:remove', { name: s.name, scope: s.scope, cwd: this.cwd });
    this.busy.delete(s.name);
    if (r.ok) this.toast('Removed ' + s.name + '.');
    else this.toast('Could not remove: ' + (lastLine(r.error) || 'unknown'), 'error');
    this.refresh();
  }

  async _stopSharing() {
    const r = await ipcRenderer.invoke('privacy:stopSharing');
    this.report = r;
    this.renderPrivacy();
    if (r.ok) this.toast('Turned off. Sessions stay on this computer.');
    else this.toast('Could not change it: ' + lastLine(r.error), 'error');
  }

  async _fixPerms() {
    const r = await ipcRenderer.invoke('privacy:fixPerms');
    this.report = r;
    this.renderPrivacy();
    if (r.ok) this.toast('Only you can open ~/.claude now.');
    else this.toast('Could not change permissions: ' + lastLine(r.error), 'error');
  }
}

module.exports = { McpPanel };
