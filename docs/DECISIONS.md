# wOS suite: decision log

This log starts fresh with the suite. It replaces the old monorepo's `docs/DECISIONS.md` (D1 to D74) for everything the suite does. Each entry says what was decided, when, and why, in plain words.

Source: `ROADMAP.md` section 8.4, approved by the founder on 2026-10-07 ("go ahead with what you think").

## Approved by the founder (2026-10-07)

| # | Decision | What it means here |
|---|---|---|
| F1 | New suite repo, licence and name | This repo, `warOnSaaS/suite`, licensed AGPL-3.0. The product is called **wOS**. |
| F2 | Desktop base | Browser first (an installable web app), Electron second, using the same screens. Not Tauri. |
| F3 | The old monorepo (`warOnSaaS` contributor platform) | Frozen. We copy its hardened Electron shell code (security, secrets, signed module installer) when desktop work starts, and keep its target scans as reference. Nothing else comes across. |
| F4 | Old decisions D50 and D14 | **Superseded** (see below). Self-hosting is first-class. Apps keep their own repos. |
| F5 | Claude subscriptions | No claude.ai login inside wOS. People use an Anthropic API key, or plug wOS into the Claude app as a connector (our `/mcp`). |
| F6 | ChatGPT subscription sign-in | Ship only after a short read of OpenAI's current terms. Not in the MVP. |
| F7 | Hosting provider for the hosted suite | Long-running containers on one host (to be priced), Neon Postgres, Cloudflare R2 for files, Amazon SES for mail. |
| F8 | Price | Cost times 2, plus $3 a person for support and running it, shown openly. Included AI at cost plus a small percent. |
| F9 | Phones | An installable web app (PWA) with Web Push. No native phone apps until push limits bite. |
| F10 | Gmail for hosted users | IMAP first. Start Google verification and the yearly security assessment when about 20 paying teams ask. |
| F11 | Meetings recording | Off by default, announced to everyone in the call, consent recorded. |
| F12 | "Done with the CRM" | As defined in ROADMAP section 8.1. |

Also approved the same day, from `AGENT-RULES.md`:

| # | Decision |
|---|---|
| C1 | CRM leads are a status on contacts, with a Convert button. |
| G1 | The hosted board uses its own new GitHub App, created from a manifest with one founder click. |
| G2 | Connect tiles show a plain icon instead of the Claude logo until Anthropic gives permission. |

## What the suite supersedes from the old log

| Old decision | Status | Why |
|---|---|---|
| **D14**: one product repo for every replacement app | **Superseded by F4.** | The CRM, the board, Chat, Email and Meetings each live in their own repo and publish an app package (a manifest, a tool catalogue, a server part and a screen part). The suite loads them. Each one still works on its own. |
| **D50 staging**: hosted first, self-hosting staged and only first-class when an enterprise pays | **Superseded by F4.** | Self-hosting for free is a first-class way to run every app from day one: any Postgres through `DATABASE_URL`, SQLite for one person, one `docker compose up`. D50's stage 1 (exit rights, standard Postgres, full export, no vendor-only features) still holds. |
| D1, D24 (bring your own model, we hold no keys for you) | Kept | Matches the model picker: your Anthropic or OpenAI key, Ollama, or any OpenAI-compatible server. Keys you add are encrypted at rest with a key that never sits in the database. |
| D8 (sign in by email) | Kept | Sign-in is GitHub or an email link. |
| D13 (parity means features and experience) | Kept | And extended by the agent parity rule below. |
| D59 (every target plans getting customers off it) | Kept | |
| Everything about tokens, rewards, review economics and the control plane | Not carried over | The suite is a business suite for teams, not a contributor platform. |

## Decisions made while building (Lane B)

| # | Date | Decision | Why |
|---|---|---|---|
| S1 | 2026-10-07 | Every action is a tool. Screens call `POST /api/tools/<name>`, agents call `/mcp`, and both run the same handler. A build test fails when a screen button names no tool. | The hard rule in ROADMAP section 3. |
| S2 | 2026-10-07 | The server is TypeScript run directly by Node 22 (type stripping), bundled with esbuild for production. Screens are React built with Vite. | One language, type checks across apps, no compile step in development. |
| S3 | 2026-10-07 | Storage is plain SQL through one small adapter: Postgres (`pg`) when `DATABASE_URL` is set, otherwise SQLite (Node's built-in `node:sqlite`). Migrations are numbered SQL files applied by the server when it starts. No ORM. | Both databases from one query layer with no native build step; the roadmap allowed Drizzle, but the SQL we need is small and portable. |
| S4 | 2026-10-07 | "Off" means: the app's server code is never imported, its tables are never created, its tools are absent from MCP and the API, and its screen bundle is never requested by the browser. On a server shared by many teams, the code loads once the first team turns the app on; other teams still see none of it. | ROADMAP 2.5 and the founder's "if you toggle one off, it should not be installed". |
| S5 | 2026-10-07 | The CRM and the board are mounted as they are: the suite runs their own Node handlers inside the server under `/m/crm/` and `/m/board/`, rewrites their page addresses, and shows them in a frame. Their tools join the catalogue as `crm.*` and `board.*`. Native screens replace the frames later (ROADMAP step 7). | Proves toggling and parity in days. Their live sites refuse frames, so the suite serves them itself. |
| S6 | 2026-10-07 | A built-in "Demo model" that follows a script and calls real tools. It is labelled as not AI. | So the agents grid, inbox and alerts can be tried with no API key, and tests run without spending money. |
| S7 | 2026-10-07 | The Agents app is part of the core and cannot be switched off (ROADMAP 5.5.7). Settings is core too. | With every other app off, wOS is still a Claude or ChatGPT style app. |
| S8 | 2026-10-07 | Tool names follow `app.verb_noun`. Core tools use the namespaces `account`, `team`, `apps`, `models`, `conversations`, `agents`, `alerts`, `audit`, `hosting`. The shell's own conversations are `conversations.*`, never `chat.*`, which belongs to the Chat app. | No clashes when Chat ships. |
