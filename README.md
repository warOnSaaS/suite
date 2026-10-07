# wOS

One app for a team and its AI agents. It opens on a conversation, like the Claude and ChatGPT apps, and around it sit the apps you and your agents both work in: **Agents**, the **Board**, **CRM**, **Chat** and **Email**, with Meetings next. Switch any app on or off; an app that is off is not loaded at all. Pick your model: your Anthropic or OpenAI key, a local model through Ollama, or any OpenAI-compatible server.

Everything a person can do on a screen, an agent can do too: every button calls a tool, and the same tools are served to Claude, ChatGPT, Codex and Claude Code over MCP.

Try it: **https://app.waronsaas.com** (a demo with made-up data; press "Try the demo").

| Host it yourself, free | Host with us |
|---|---|
| One `docker compose up` runs wOS, Postgres and HTTPS on any server. One person can run it with nothing but Node and a SQLite file. No licence check, ever. | We run it and charge what it costs us times two, plus $3 a person for support, shown openly. Move to your own hosting any time with one export. Coming soon. |

Licence: AGPL-3.0-only. Status: early (v0.1). Decisions: [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Host it yourself

**On a server (a team):**

```sh
git clone https://github.com/warOnSaaS/suite && cd suite
cp .env.example .env          # set WOS_DOMAIN (DNS pointing here) and WOS_SECRET_KEY (openssl rand -hex 32)
docker compose up -d          # wOS + Postgres + Caddy, which gets the HTTPS certificate
```

Open `https://<your domain>`. The first person to sign in owns the server; everyone else joins by invite (Settings, Team) or through a linked GitHub organization. Database changes apply themselves when the server starts.

**On your own computer (one person, nothing else to install):**

```sh
npm install && npm run build
WOS_SOLO=1 npm start          # http://localhost:8080, SQLite in ./.data, "Continue on this computer"
```

**What a self-hoster really needs** (more than a database):

| Piece | Needed for | Free option |
|---|---|---|
| A machine that stays on, with Docker or Node 22 | everything (Chat sockets, agents and email polling need a process that stays up) | a $5 to $10 VPS, a home server, your laptop |
| A domain with HTTPS | sign-in callbacks, phone push, installing the app | Caddy in the compose file does the certificate |
| Postgres (`DATABASE_URL`) or nothing (SQLite) | storage | the bundled Postgres, or Neon, Supabase, RDS |
| SMTP (`SMTP_URL`, `MAIL_FROM`) | sign-in links, invites, alert emails | any mailbox you already have |
| A GitHub OAuth app | GitHub sign-in (optional) | free, five minutes |
| Model access | conversations and agents | your API key, or Ollama on your own hardware; the built-in demo model needs nothing |

Settings, Hosting has **Check this server**, which tests all of this and says in plain words what is missing (also the `hosting.doctor` tool, so an agent can run it), and **Export everything** (`hosting.export`).

All settings: [`.env.example`](.env.example).

## How it is built

| Part | Where | What |
|---|---|---|
| Server | `apps/server`, `core/` | One long-running Node 22 process: accounts and teams, sign-in (GitHub, email link, MCP OAuth), the app registry, the tool catalogue, `/api/tools/<name>` and `/mcp` from the same handlers, storage (Postgres or SQLite) with migrations on start, events and the `/live` socket, the audit log, alerts (inbox, browser, Web Push, email), the model router, conversations |
| Shell | `apps/shell` | React on the ui-design kit: conversation home with history and a model picker, the left rail of enabled apps, inbox, settings. Installable as a web app (PWA). |
| Agents | `apps-builtin/agents` | Saved agents run on the server; plans as checklists with evidence; progress = done steps / all steps; a 1, 2, 4 or 6 panel grid; status colours; one inbox |
| Board and CRM | `apps-builtin/board`, `apps-builtin/crm` | Their own pages mounted as they are under `/m/<id>/`, their tools as `board.*` and `crm.*` |
| Other apps | their own repos (Chat, Email, Meetings) | loaded from `WOS_APPS` or `apps-installed/`; see [`packages/manifest`](packages/manifest) |
| Contracts | `packages/manifest`, `packages/tools` | the app manifest and the tool catalogue every app ships |
| Self-host | `docker-compose.yml`, `deploy/` | server, Postgres, Caddy |

**Off means not installed.** An app that is off for a team is never imported by the server (on a server shared by many teams, it loads once the first team turns it on, and other teams still see none of it), its tables are not created, its tools are absent from MCP and the API, and the browser never downloads its screens. The parity harness checks the last part in a real browser.

**Models.** Anthropic (Claude, through the official SDK), OpenAI, Ollama and any OpenAI-compatible server, added in Settings, Models. Keys are sealed with a server key that never sits in the database and are never shown again. Claude subscriptions cannot be used inside wOS (Anthropic's rule); connect wOS to the Claude app as a connector instead (Settings, Account shows the address). The built-in **demo model** is a script, not AI, so everything can be tried with no key.

**Running on serverless hosting (Vercel).** `api/index.mjs` runs the same code in reduced mode: no socket (screens poll), no background loop (agents move forward while a screen is open). Use `DATABASE_URL` there; the demo at app.waronsaas.com uses SQLite per server copy and rebuilds each visitor's sandbox where needed, so changes can reset.

## Agent parity

Every action is a tool. The build fails when it is not:

| Check | Command | Fails when |
|---|---|---|
| Screen to tool (Playwright) | `npm run test:parity` | a button, menu item, switch or form on any screen has no `data-tool`, or names a tool not in the catalogue; or an app that is off gets downloaded |
| Catalogue | `npm test` (`test/unit/catalogue.test.ts`) | a tool lacks a schema, description, scope, handler or a test that names it, or is not reachable over MCP and REST |
| No side doors | `npm run lint:doors` | screen code calls anything but `/api/tools/*`, `/files/*`, `/media/*` and the live socket |
| Agent run test | `test/unit/mcp.test.ts` | a scripted agent using only MCP cannot turn apps off and on, invite someone, start an agent and export everything |
| Parity report | written by `npm run test:parity` | [`docs/PARITY-REPORT.md`](docs/PARITY-REPORT.md) |

## Development

```sh
nvm use 22
npm install
npm run sync-kit              # copies ui-design from ../waronsaas-ui-design into apps/shell/public/ui
npm run build                 # shell into dist/shell, server into dist/server
WOS_DEMO=1 npm start          # or: npm run dev (source, restarts on change) with npm run dev:shell
npm test                      # unit tests on SQLite; npm run test:pg on Postgres (TEST_DATABASE_URL)
npm run test:parity           # the browser parity check
npm run check                 # typecheck, tests, no side doors, check:clean
npm run shots -- http://localhost:8080   # screenshots at 1440 and 390, light and dark, into .shots/
```

The CRM and board mount from sibling checkouts (`../crm`, `../agent-kanban`) or `WOS_CRM_DIR` and `WOS_BOARD_DIR`; `node scripts/vendor.mjs` copies them (and Chat and Email) into `vendor/` for a deploy.
