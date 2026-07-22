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
- **Permission prompts** — reading/searching happens automatically; before
  Claude edits a file or runs a command, a popup asks for approval.
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
