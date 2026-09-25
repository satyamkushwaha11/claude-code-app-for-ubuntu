# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Claude Code Studio is an Electron desktop GUI for Claude Code on Linux. It wraps two distinct ways of talking to Claude behind a ChatGPT-style interface:

- **Chat view** — uses the `@anthropic-ai/claude-agent-sdk` (ESM) to stream a conversation as chat bubbles.
- **Terminal view** — spawns the real `claude` CLI inside a `node-pty` pseudo-terminal rendered by xterm.js, for slash commands, plan mode, and other terminal-only features.

Both views read and write the same session files Claude Code stores under `~/.claude/projects/`, so history is shared with the regular CLI.

## Commands

```bash
npm install          # install dependencies
npm run rebuild      # rebuild node-pty native module against Electron's ABI (required after install / Electron upgrade)
npm start            # launch via electron .
./run.sh             # launch (preferred — passes --no-sandbox, checks deps)
./install.sh         # add a .desktop entry to the Ubuntu app menu
```

There is no build step, bundler, test suite, or linter (`node --check <file>` is the quickest sanity check). Renderer code is plain CommonJS loaded directly by Electron with `nodeIntegration` enabled.

## Architecture

Three source files do most of the work (voice adds `renderer/voice.js` and `stt-worker.js`, the MCP panel `renderer/mcp.js`). There is no preload/bridge — the renderer has full Node integration and talks to main over `ipcRenderer`/`ipcMain` directly.

### `main.js` — Electron main process

Owns all OS-facing state and brokers two parallel session systems keyed by a renderer-generated `clientId`:

- **`chats` Map** (Agent SDK): each entry holds an async input queue, an `AbortController`, and the live `query()` async iterator. User messages are pushed into `createInputQueue()` (a hand-rolled async iterator) which is passed as the streaming `prompt` to `query()`. SDK output messages are forwarded to the renderer over the `chat:message` channel.
- **`ptys` Map** (node-pty): each entry is a spawned `claude` CLI process; raw bytes flow both ways over `pty:data` / `pty:input`.

Other responsibilities:
- **Session history** (`listSessions` / `parseSession`): scans `~/.claude/projects/*/*.jsonl`, parsing each line as JSON to extract title, cwd, and message counts for the sidebar. Large files (>3 MB) are partially read from the head only.
- **Permissions** (`makeCanUseTool`): read-only tools in `AUTO_ALLOW_TOOLS` are auto-approved; everything else is routed to the renderer as a `permission:request` and blocks on a Promise stored in `pendingPerms` until the user answers via `permission:response`.
- **`resolveClaude()`**: locates the `claude` binary across common install paths, falling back to `claude` on `PATH`.

### `renderer/renderer.js` — UI shell

Manages the sidebar, the welcome screen, tabbed panes, and mode switching. Central `state.open` Map (clientId → entry) tracks every open session; each entry carries either a `ChatView` instance or an xterm `Terminal`. Switching modes (`switchMode`) tears down one and builds the other, then resumes the same `sessionId` so the conversation continues across views. All IPC listeners for `chat:*`, `pty:*`, and `permission:request` live here.

### `renderer/chatview.js` — chat rendering (`ChatView` class)

UI-only; the host wires sending/interrupting via callbacks. Translates SDK message types into DOM:
- `stream_event` deltas append to a live streaming assistant message (text and thinking rendered separately; markdown via `markdown-it` with raw HTML disabled).
- `tool_use` blocks become collapsible tool cards tracked in `toolCards` (tool_use_id → card); the later `tool_result` (arriving on a `user` message) updates the matching card with output or error. `TodoWrite` renders as a checklist, edit-like tools as a diff.
- `renderHistory()` replays a saved session array into the same rendering path, with `replaying` set so questions/plans render read-only instead of asking again.
- `handlePermission(req, respond)` renders prompts *in the conversation* rather than as a modal — `addQuestionCard` (AskUserQuestion), `addPlanCard` (ExitPlanMode) and `addPermissionCard` (everything else). Each is keyboard-driven (number keys pick, Esc declines) and calls `respond` exactly once.

**Prompt dock**: live cards are not appended to the scroll area — `_appendCard` puts them in `.prompt-dock`, pinned above the composer so a prompt can't scroll out of sight, and `_settleCard` moves the answered card into the conversation as the record. Every card must finish through `_settleCard`. An AskUserQuestion with several questions renders as *slides* (`.ask-slides`): one question on screen, step tabs, ←/→/Enter to move, single-select picks auto-advance, Submit only on the last slide.

**Other ChatView behaviour worth knowing**:
- Messages typed while busy are held in `this.queued` (renderer-side, not pushed to the SDK) and dispatched one per `result`, so busy state stays deterministic.
- Messages carrying `parent_tool_use_id` are sub-agent traffic: `_onSubagentMessage` lists their tool calls inside the launching `Task`/`Agent` card instead of the main conversation.
- Streaming text renders at most once per animation frame (`_scheduleRender`); code is highlighted by highlight.js through markdown-it's `highlight` hook (hljs escapes its input — still never inject unescaped model text).
- The context meter uses the latest assistant `usage` over `result.modelUsage[*].contextWindow`.
- **Composer controls**: permission modes are `default` (shown as Manual), `acceptEdits`, `plan`, `auto` and `bypassPermissions`. `chat:start` always passes `allowDangerouslySkipPermissions` so Bypass can be picked mid-session; Bypass is never saved as the default and Shift+Tab skips it. Auto mode only works on some models: `setPermissionMode` rejects it (main returns `{ rejected: true }`, the dropdown reverts and greys it out), and a session *started* in Auto quietly falls back to Manual, which the per-turn `system/init` `permissionMode` reveals. Effort goes in as `options.effort` at start and changes mid-session via `query.applyFlagSettings({ effortLevel })` (`null` = model default; `max` works there too).
- **Auto model** (`pickModelForTask`): a local regex read of each message picks `haiku`/`sonnet`/`opus` and `_dispatch` awaits `onSetModel` before sending. It skips slash commands, Auto permission mode and contexts over 150k tokens. Picking a model by hand turns it off.
- **Attachments** accept any file type: API image types ≤ 5 MB go inline as base64; PDFs of ≤ 30 pages and ≤ 10 MB go inline as `document` blocks (titled with the file name) so Claude sees the pages' text and images; everything else — including longer PDFs and ones `pdfPageCount` can't read — is an `@path` reference that Claude opens with its Read tool. The cap is deliberately low: each page costs ~1.5–3k tokens and stays in context, and a PDF the API rejects fails every later turn too. `pdfPageCount` needs no library; it also inflates compressed object streams and can overcount but never undercounts. Pasted/dropped data with no path on disk is written to `os.tmpdir()/ccs-attachments/` first.

**Answering AskUserQuestion**: the tool is answered by *rewriting its input*, not by allow/deny. The card returns `{ allow: true, updatedInput: { ...input, answers } }`, where `answers` maps question text → answer string (multi-select answers comma-separated), which main.js passes through as `PermissionResult.updatedInput`. Denying instead leaves Claude with no answer, so only "Skip" does that.

### Artifacts panel (renderer.js + `artifact:*` IPC in main.js)

Local stand-in for claude.ai Artifacts: a resizable right-hand panel (`#artifactPanel` inside `#workArea`, next to `#panes`) that previews what Claude writes to disk — HTML/SVG in a `<webview>` loaded from `file://` (so relative CSS/JS/images work), Markdown via markdown-it, images as data URLs, plus a highlighted Code view and desktop/tablet/phone widths. ChatView reports previewable `Write`/`Edit` targets through `onArtifact` and offers ▶ Preview on tool cards and on ```html/```svg code blocks (`onOpenArtifact`; snippets are parked in the temp dir by `artifact:writeInline`). `artifact:watch` watches the file's *folder*, so editing a linked stylesheet live-reloads the page. `artifacts:scan` lists every previewable file in the project for the panel's dropdown.

**Previews are untrusted content.** The window enables `webviewTag`, and `will-attach-webview` in main.js force-disables Node integration/preload and enables sandbox + context isolation for every webview. Never preview generated HTML in an `<iframe>` or by injecting it into the renderer DOM — the renderer has full Node access.

### Voice (mic input + read-aloud)

- **Speech-to-text** runs locally. The renderer records with `MicRecorder` (`renderer/voice.js`: MediaRecorder, then `decodeAudioData` into a 16 kHz mono `Float32Array`; a noise-floor level check ends the take after a pause). It sends the audio over `voice:transcribe`. main forks `stt-worker.js` as an Electron `utilityProcess` on first use, which runs Whisper through `@huggingface/transformers` (q8, `onnx-community/whisper-base` or `-small`). Models cache in `~/.cache/claude-code-studio/models`; download progress arrives as `voice:progress`. The worker patches `dns.lookup` to try IPv4 first because some routers stall ~15 s on AAAA lookups, and Node's fetch gives up after 10 s. transformers.js v4 defaults to English, so the spoken language is a setting.
- **Read-aloud** uses `speechSynthesis`, which on Linux only reaches speech-dispatcher because main adds the `enable-speech-dispatcher` switch. `Speaker` is fed streaming `text_delta`s, speaks sentence by sentence, and skips code fences and tables. espeak-ng lists ~13k voices and its default is Afrikaans, so `pickVoice` chooses a base voice from the text's script (US English for Latin text). A turn is read aloud when it was spoken (`speakTurn`) or when Settings says "Always".
- The mic is granted only to the main window (`setPermissionRequestHandler`); artifact webviews never get it.

### MCP servers & privacy (`renderer/mcp.js` + `mcp:*` / `privacy:*` IPC in main.js)

A panel (sidebar 🔌, Settings, command palette) for MCP servers that live on *this* computer, for people sharing one Claude login.
- **Local MCP only** (on unless `privacy.json` in userData says `localMcpOnly: false`): `applyPrivacy()` sets `ENABLE_CLAUDEAI_MCP_SERVERS=false` on main's `process.env`, which every SDK session, pty and `claude mcp` call inherits — so claude.ai account connectors (shared by everyone on the login) never load. It runs at startup before tabs restore; already-open sessions keep their servers until reopened.
- **Listing** starts a throwaway `query()` (`persistSession: false`, no prompt, no tokens) and polls `mcpServerStatus()` until nothing is `pending` (30 s cap — a stdio server that never answers stays pending), pushing each changed snapshot as `mcp:status` so rows appear at once and update live. A remote server can sit in `pending` for 15 s+ on networks whose router stalls on AAAA lookups. Only name/scope/status/url-or-command/tool count reach the renderer; headers and env can hold keys. Note: project `.mcp.json` servers connect in SDK sessions without an approval prompt.
- **Add/remove/logout** shell out to `claude mcp add-json|remove|logout` via `execFile` (no shell; names are validated so none starts with `-`). An own OAuth client goes in the JSON as `oauth: { clientId, callbackPort }`, and the secret goes through `--client-secret` + `MCP_CLIENT_SECRET` into `~/.claude/.credentials.json`. Google's MCP endpoints refuse dynamic client registration, so Gmail/Calendar/Drive need one (redirect URI `http://localhost:<port>/callback`).
- **Sign in**: `claude mcp login` refuses to run without a TTY, so it runs in a hidden node-pty. It opens the browser itself and exits after the OAuth callback; the first URL it prints is forwarded as `mcp:loginUrl`.
- **Privacy check**: `~/.claude` / `~/.claude.json` permissions (Make private → 700/600), plus `remoteControlAtStartup` and `autoUploadSessions` ("mirror local sessions to claude.ai"). The CLI reads those from settings before `~/.claude.json`, so Turn off writes `false` to `~/.claude/settings.json`.

### Shell state (renderer.js)

Sidebar chats group into collapsible per-project sections (`state.grouped`, toggle ▤; search always shows a flat list). Open chat tabs persist in `localStorage['ccs.openTabs']` and are restored *lazily* on launch — `openSession(meta, { lazy: true })` builds the pane, and `setActive` starts the SDK session only when the tab is first viewed, so restoring eight tabs doesn't spawn eight `claude` processes. Composer drafts persist per session (`ccs.draft.*`). Toggle visibility of the working area via `el.workArea`, not `el.panes`, or the hidden-panes wrapper still takes half the height from the welcome screen.

## Conventions

- **Launching from a VS Code terminal**: VS Code exports `ELECTRON_RUN_AS_NODE=1`, which makes `electron .` run as plain Node and crash at `app.commandLine`. `run.sh` unsets it; with `npm start` do `env -u ELECTRON_RUN_AS_NODE npm start`.

- **Native module ABI**: `node-pty` is compiled for Electron, not system Node. After any `npm install` or Electron version bump, run `npm run rebuild` or the terminal view silently fails (`ptyError` surfaces in `app:status`).
- **Untrusted content**: model/tool output is always escaped (`esc` in chatview.js, `escapeHtml` in renderer.js); markdown-it runs with `html: false`. Preserve this when adding rendering paths.
- **Theming**: three themes (`dark`/`light`/`contrast`) are plain CSS-variable blocks on `body` in style.css. Style with the variables — including `--code-bg` for code surfaces — never a hardcoded colour, or light mode breaks. `applyTheme()` also repaints open xterm terminals from `TERM_THEMES`; the sidebar ☀/🌙 button and Ctrl+Shift+L toggle light/dark.
- **clientId vs sessionId**: `clientId` is a renderer-side UUID identifying an open tab/pane for the lifetime of the window; `sessionId` is Claude Code's persistent session id (assigned by the SDK `system/init` message or supplied when resuming). Keep them distinct.
- The Agent SDK is ESM and loaded lazily via dynamic `import()` in `loadSdk()`; node-pty is CommonJS `require`d at startup inside a try/catch. Both degrade gracefully when missing.

## Runtime requirements

Node.js + npm, and the `claude` CLI installed and logged in (`claude` must work standalone in a terminal). The app launches with `--no-sandbox` because the Chromium SUID sandbox helper is frequently absent on Linux; this is intentional since only local trusted content is loaded.
