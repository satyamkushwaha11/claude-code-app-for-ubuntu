# Claude Code Studio

A desktop app for **Claude Code** on Ubuntu/Linux with a ChatGPT-style chat
interface — message bubbles, streaming replies, saved history, and a sidebar to
switch between conversations.

## How it works

- **Chat view** (default) uses the **Claude Agent SDK** to talk to Claude and
  renders the conversation as chat bubbles: your messages, streaming assistant
  replies with markdown, collapsible thinking, and cards for every file edit or
  command Claude runs.
- **Terminal view** (toggle in the top bar) runs the real `claude` CLI in an
  embedded terminal — for slash commands, plan mode, and other terminal-only
  features.
- Conversations are the same ones Claude Code saves under
  `~/.claude/projects/`, so history is shared with the regular CLI.

## Features

- **Chat bubbles** — ChatGPT-style conversation, streaming responses, markdown.
- **Quick chat** — start a chat instantly in the default folder (`~/ClaudeChats`),
  no folder picking needed. Or pick any project folder.
- **Chat history** — every past conversation in the sidebar; search and switch.
  Toggle the whole panel with the switch.
- **Artifacts, locally** — when Claude builds a page, design, SVG diagram,
  Markdown doc or image, it opens in a side panel rendered straight from your
  disk (no server, nothing uploaded). Live-reloads as Claude edits, with
  desktop / tablet / phone widths, a Code view, "open in browser" and "show in
  folder". Any ```html / ```svg block in a reply has a ▶ Preview button too.
- **Projects** — the sidebar groups chats by project folder; ＋ starts a new
  chat in that project. Your open tabs and unsent drafts come back on restart.
- **Questions as slides** — when Claude asks several questions they appear one
  at a time in a panel pinned above the message box: number keys to pick,
  ←/→/Enter to move, Esc to skip. Permission and plan prompts use the same
  panel (with a diff for edits), so they never scroll out of sight.
- **Talk to Claude** — 🎙 mic button (or Ctrl+M) next to Send. Speech is
  transcribed on your computer by Whisper (a ~75 MB model downloaded on first
  use); it sends when you pause. Replies to spoken messages are read aloud with
  the system voice (skipping code). Language, voice and speed are in Settings.
- **Model, mode and effort in the composer** — pick the model, or turn on
  ✦ Auto model to send each message to Haiku, Sonnet or Opus by how hard it
  looks. Permission modes: Manual, Accept edits, Plan, Auto (a safety check
  approves actions; supported models only) and Bypass. Effort: low → max.
- **Private MCP servers** — 🔌 in the sidebar lists your MCP servers with live
  status. Add Figma, Notion, Gmail and others for just you, sign in with your
  own account in the browser, and sign out or remove them again. The token
  stays on your computer. By default the app ignores connectors saved in the
  claude.ai account, so people sharing one Claude login don't share each
  other's apps. It also checks that your chats are readable only by you and
  aren't being uploaded to claude.ai.
- **Attach anything** — 📎, drag & drop, or paste any file type. Images and PDFs
  of up to 30 pages go straight to Claude, which sees the text and the page
  images. Everything else, including longer PDFs, is attached by path for Claude
  to open.
- **Keep typing while Claude works** — follow-ups queue and send automatically.
  A status line shows what Claude is doing and for how long; Esc stops it.
- **Code & tools** — syntax-highlighted code, readable tool cards, sub-agent
  activity nested inside its card, a context-window meter, token/cost HUD.
- **Keyboard first** — Ctrl+K palette, Ctrl+Tab / Ctrl+1–9 tabs, Ctrl+B
  sidebar, Ctrl+Shift+A artifacts, Shift+Tab permission mode, Ctrl+M talk,
  Ctrl+/ for the full list.
- **Terminal toggle** — switch any chat to the full terminal interface.

## Setup

```bash
cd claude-code-studio
npm install
npm run rebuild   # compiles the terminal engine (node-pty) for Electron
```

## Run

```bash
./run.sh
```

## Add to the Ubuntu app menu (optional)

```bash
./install.sh
```

Then search for **Claude Code Studio** in the Activities overview.

## Requirements

- Node.js + npm
- The `claude` CLI installed and logged in (`claude` works in your terminal)
# claude-code-app-for-ubuntu
