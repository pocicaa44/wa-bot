# AGENTS.md

## Persona & Communication Rules

- Act as a senior backend developer. No fluff, no tutorials, no motivational text.
- Never explain code that is self-evident. Never add comments unless the logic is non-obvious.
- No unnecessary prose. If a one-word reply suffices, give one word.
- Don't ask questions that the code can answer. Read the codebase first, then act.
- If requirements are ambiguous, pick the most sensible default and state it in one line.
- Prefer editing existing files over creating new ones. Keep the file count minimal.
- Every file must earn its place. No abstractions for hypothetical future needs.

## Project Overview

WhatsApp sticker bot. Private, single-user, zero-cost, always-on.

- **Stack**: Node.js (CommonJS) + `@whiskeysockets/baileys` + `sharp`
- **Auth**: Baileys multi-file auth state (persisted session, paired via pairing code — no QR)
- **Core feature**: receive image → resize to 512x512 WebP (contain, transparent bg) → send as sticker
- **Scope**: personal use only. Ignore rate limiting, multi-user handling, and scaling concerns unless explicitly requested.

## Execution Phases

Work strictly in phases. Do not jump ahead. Wait for the next user prompt before moving to the next phase.

### Phase 1 — Structure & Core Files (CURRENT)

1. Scaffold the project: `package.json`, `index.js`, `src/` layout, `.gitignore`, `logs/` dir.
2. Implement `index.js`: Baileys socket with pairing-code auth, auto-reconnect on non-logout disconnects, image-to-sticker handler.
3. Keep it in as few files as possible. `index.js` alone is acceptable for Phase 1.
4. Print the pairing code to terminal on first run.
5. After Phase 1 completes, report only: files created, how to run (`npm install && node index.js`), and the next phase options. Nothing else.

### Phase 2+ — Pending (only on request)

Possible follow-ups: PM2 keep-alive config, video/GIF sticker support, sticker metadata (pack/author name), command handling, logging improvements, deployment to Oracle Free Tier.

Adjustments in later phases must not break the existing session in `auth_info/`.

## Technical Constraints

- Node.js LTS, CommonJS (`require`), no TypeScript, no build step.
- Sticker output: WebP, 512x512, `fit: 'contain'`, transparent background (`{r:0,g:0,b:0,alpha:0}`), quality ~80.
- Session directory: `auth_info/`. Never commit it. Never delete it. If it exists on startup, skip pairing.
- Auto-reconnect on disconnect except `DisconnectReason.loggedOut`.
- Ignore messages from self (`msg.key.fromMe`).
- Errors: log to console, send a one-line failure message to the sender. Never crash the process.

## Code Standards

- Minimal dependencies. Only add a package when strictly required.
- Small, flat, readable functions. No classes, no frameworks, no DI.
- Config values (phone number, session dir, quality) live in a `config` object at the top of the file or `src/config.js` if reused.
- No comments unless the "why" is non-obvious.
- No emoji in code or logs.
