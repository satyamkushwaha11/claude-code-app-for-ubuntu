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

There is no build step, bundler, test suite, or linter. Renderer code is plain CommonJS loaded directly by Electron with `nodeIntegration` enabled.

## Architecture

Three source files do all the work. There is no preload/bridge — the renderer has full Node integration and talks to main over `ipcRenderer`/`ipcMain` directly.

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
- `tool_use` blocks become collapsible tool cards tracked in `toolCards` (tool_use_id → card); the later `tool_result` (arriving on a `user` message) updates the matching card with output or error.
- `renderHistory()` replays a saved session array into the same rendering path.

## Conventions

- **Native module ABI**: `node-pty` is compiled for Electron, not system Node. After any `npm install` or Electron version bump, run `npm run rebuild` or the terminal view silently fails (`ptyError` surfaces in `app:status`).
- **Untrusted content**: model/tool output is always escaped (`esc` in chatview.js, `escapeHtml` in renderer.js); markdown-it runs with `html: false`. Preserve this when adding rendering paths.
- **clientId vs sessionId**: `clientId` is a renderer-side UUID identifying an open tab/pane for the lifetime of the window; `sessionId` is Claude Code's persistent session id (assigned by the SDK `system/init` message or supplied when resuming). Keep them distinct.
- The Agent SDK is ESM and loaded lazily via dynamic `import()` in `loadSdk()`; node-pty is CommonJS `require`d at startup inside a try/catch. Both degrade gracefully when missing.

## Runtime requirements

Node.js + npm, and the `claude` CLI installed and logged in (`claude` must work standalone in a terminal). The app launches with `--no-sandbox` because the Chromium SUID sandbox helper is frequently absent on Linux; this is intentional since only local trusted content is loaded.
