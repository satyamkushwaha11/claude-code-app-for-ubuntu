# Claude Code Studio — Production Roadmap

Goal: a **cross-platform** (Windows, macOS, Linux) desktop app a **non-technical
user** can install and use with **zero terminal steps**, backed by **either** a
Claude subscription (via the CLI) **or** a pasted Anthropic API key.

This document is the plan. It is intentionally honest about effort and risk.

---

## Where we are today (prototype)

A ~2,000-line Electron app: chat (Agent SDK) + optional embedded terminal, shared
history with the CLI, plus the recently added composer (model/skills/file pickers)
and chat delete/trash. It works, but:

- Linux-only in practice (`--no-sandbox` hardcoded, Linux binary paths, `.deb` only).
- **Requires** a pre-installed, already-logged-in `claude` CLI — a blocker for non-technical users.
- Insecure Electron config (`nodeIntegration:true`, `contextIsolation:false`).
- No signing, no auto-update, no tests/CI, many silent failures.

---

## Target architecture

```
┌──────────────┐   contextBridge    ┌───────────────┐
│  Renderer    │  (typed IPC only)  │  Main process │
│ (sandboxed)  │ <────────────────> │               │
│ no Node API  │                    │  ProviderAPI  │
└──────────────┘                    │   ├─ CliProvider  (Agent SDK + claude CLI)
                                     │   └─ ApiProvider  (Anthropic SDK + API key)
                                     │  AuthManager  (detect / login / store)
                                     │  SecretStore  (OS keychain via safeStorage)
                                     │  Updater      (electron-updater)
                                     └───────────────┘
```

Key idea: a **Provider abstraction** so the chat UI is identical whether the
backend is the subscription CLI or the raw API. `AuthManager` decides which
provider is available and drives onboarding.

---

## Milestones

Effort: S (≤1 day) · M (2–4 days) · L (1–2 weeks) · XL (3+ weeks). Order matters;
each builds on the last.

### M0 — Onboarding & auth detection  ◀ BUILDING NOW  (M)
The blocker for non-technical users. Deliverables:
- `AuthManager.status()` — detect, in order: stored API key → `ANTHROPIC_API_KEY`
  → CLI subscription creds (`~/.claude/.credentials.json` / keychain) → none.
- **Setup screen** when no account is found: "Sign in with Claude" (subscription)
  or "Use an API key" (paste + save to OS keychain), with a Re-check button.
- SDK/API wired to whichever credential is present.
- Risk: subscription OAuth login has no clean headless API — for now we drive it
  through the embedded terminal (`claude`) and re-detect; API-key path is the
  fully-GUI option.

### M1 — Security re-architecture  (M)
- `contextIsolation:true`, `sandbox:true`, a `preload.js` exposing a **typed,
  minimal IPC surface** via `contextBridge`; remove `nodeIntegration`.
- Strict CSP; keep all model/web output escaped (already done).
- Per-OS sandbox handling (drop hardcoded `--no-sandbox`).
- Risk: every `ipcRenderer.*` call in the renderer must move behind the bridge —
  mechanical but touches the whole renderer.

### M2 — Provider abstraction + dual backend  (L)
- Extract `ProviderInterface` (start, send, interrupt, history, models, commands).
- `CliProvider` = today's Agent SDK path. `ApiProvider` = Anthropic SDK with
  streaming, basic tool loop, and a clear "what API mode can/can't do" note
  (skills/agentic tools are richer on the CLI path).
- Settings UI to switch/seed the backend.

### M3 — Cross-platform builds + signing  (L)
- `electron-builder` targets: **Windows** (NSIS, EV/OV code-sign), **macOS**
  (dmg/zip, Apple Developer cert + **notarization**), **Linux** (deb + AppImage).
- Replace Linux-only binary path resolution; bundle or fetch the CLI per-OS.
- Decide `node-pty` story per-OS, or make the terminal view optional/absent where
  it can't build.
- Requires: Apple Developer account (~$99/yr), Windows code-signing cert
  (~$200–400/yr). **Budget decision needed.**

### M4 — Auto-update + telemetry  (M)
- `electron-updater` with a release feed (GitHub Releases or S3).
- Opt-in crash reporting (Sentry) and minimal, privacy-respecting usage metrics.

### M5 — Non-technical UX pass  (M)
- Hide/relabel developer surfaces (terminal, tool names, raw model IDs, session files).
- First-run tutorial, friendly empty/error states, settings for model & data location.
- Accessibility (keyboard, contrast, screen-reader labels).

### M6 — Quality & release engineering  (L)
- Migrate to TypeScript; add unit tests (provider/auth) + a few Playwright E2E flows.
- CI matrix (win/mac/linux) building, signing, and publishing on tag.
- Versioning, changelog, support docs.

---

## Open decisions (need your input)

1. **Signing budget** — Apple Developer + Windows cert (without these, installers
   show scary warnings on Win/Mac). Yes/no?
2. **Update hosting** — GitHub Releases (free, public) vs private S3.
3. **Brand** — final app name, icon, identifiers.
4. **API mode scope** — how much agent capability (tools/skills) to reimplement
   for the API-key path vs. keeping that path "chat-only" initially.

---

## Sequencing summary

M0 (onboarding) → M1 (security) → M2 (dual backend) → M3 (cross-platform/signing)
→ M4 (update/telemetry) → M5 (UX) → M6 (tests/CI). Ship private betas after M3.
