# @wos/manifest: the wOS app contract

A wOS app (Chat, Email, Meetings, the CRM, the board) is a folder with four things. The suite loads it only when a team turns it on; turned off, none of it is loaded, created or downloaded.

```
my-app/
  wos-app.json      the manifest (this package)
  tools.json        every action, as tools (packages/tools)
  migrations/       0001_init.sql, 0002_... applied in order
  server.mjs        register(ctx) -> { handlers, routes?, start?, stop? }
  screens.mjs       { mount(el, ctx) }, built for the browser
```

A working example lives in [`example/`](example). Check any app folder with:

```sh
node packages/manifest/bin/check.mjs path/to/my-app      # or: npx wos-check-app path/to/my-app
```

## 1. `wos-app.json`

Schema: [`wos-app.schema.json`](wos-app.schema.json).

```json
{
  "$schema": "https://raw.githubusercontent.com/warOnSaaS/suite/main/packages/manifest/wos-app.schema.json",
  "id": "chat",
  "name": "Chat",
  "description": "Channels, direct messages and threads for the team and its agents.",
  "version": "0.1.0",
  "license": "AGPL-3.0-only",
  "requires": { "core": ">=0.1" },
  "tools": "./tools.json",
  "tables": "./migrations",
  "server": "./server.mjs",
  "screens": "./screens.mjs",
  "icon": "chat",
  "nav": { "label": "Chat", "order": 30 },
  "events": { "emits": ["chat.message.posted"], "listens": ["meet.notes.written"] },
  "needs": { "services": [], "permissions": ["notifications"], "desktop": [], "env": [] },
  "data": { "onDisable": "keep", "exports": ["channels", "messages", "files"] }
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Lower case. It is also the tool namespace (`chat.post_message`), the event namespace (`chat.message.posted`) and the table prefix (`chat_messages`). Core names (`agents`, `alerts`, `apps`, `team`, `models`, `conversations`, `settings` and a few more) are reserved. |
| `name`, `description` | yes | What people see. Sentence case, plain words. |
| `version` | yes | Semver of the app package. |
| `requires.core` | yes | Which suite versions work: `">=0.1"`. `requires.apps` names other apps that must be on (avoid it: prefer events and tools that cope when the other app is off). |
| `tools` | yes | Path to `tools.json`. |
| `tables` | no | Folder of migrations (section 3). |
| `server` | no | The server part (section 4). |
| `screens` | no | The screen part (section 5). |
| `icon`, `nav` | no | Left rail icon, label and order. Core apps use orders 0 to 19. |
| `events` | no | What the app publishes and listens to. |
| `needs` | no | What a self-hoster must add when this app is on: `services` (docker compose profiles, such as `livekit`), browser `permissions`, `desktop` capabilities, and the `env` variables the server part reads. |
| `data` | no | `onDisable` is always `keep`: turning an app off never deletes data. Only `apps.uninstall` deletes, and it exports first. `exports` names what the export contains. |
| `mount` | no | Only for apps whose existing pages the suite frames until native screens exist (the CRM and board today). |

## 2. On and off

| | On | Off |
|---|---|---|
| Server | `server` is imported once (when the first team turns it on), its migrations run, its tools join the catalogue for that team | Never imported (on a one-team server). Its tools return 404 and are absent from `/mcp` for that team. |
| Tables | Created by its migrations | Left as they are. Deleted only by `apps.uninstall`, after an automatic export. |
| Browser | `screens` is fetched when the person opens the app | Never requested. No left rail entry. |
| Desktop (later) | The signed module is installed | Removed from disk |
| Self-host compose | The services in `needs.services` start | Left out (`docker compose --profile`) |

The suite's own tools do this: `apps.list`, `apps.enable`, `apps.disable`, `apps.uninstall`.

## 3. Tables: migrations

`migrations/NNNN_label.sql`, applied in number order by the server when the app is turned on and on every start, inside a transaction, recorded in `wos_migrations`. Never edit a migration that has shipped; add the next number.

Write **portable SQL** so the same file runs on Postgres and SQLite:

| Kind | Use |
|---|---|
| ids | `TEXT PRIMARY KEY` (make them in code: `msg_x7k2...`) |
| times | `TEXT`, ISO 8601 in UTC (`2026-10-07T12:00:00.000Z`) |
| flags | `INTEGER` 0 or 1 |
| JSON | `TEXT`, parsed in code |
| money | `INTEGER` cents |
| every table | starts with the app id and has `team_id TEXT NOT NULL` |

When you truly need a dialect feature (Postgres full-text search, for example), add `NNNN_label.postgres.sql` and `NNNN_label.sqlite.sql` beside each other; the suite runs the one for its database and skips the plain file of the same number.

Apps never read or write another app's tables. They call its tools or listen to its events.

## 4. The server part

`server.mjs` (or `.js`) default-exports `register(ctx)`. Full types: [`index.d.ts`](index.d.ts).

```js
export default function register(ctx) {
  return {
    handlers: {
      async 'chat.post_message'(input, call) {
        await ctx.db.run('INSERT INTO chat_messages (...) VALUES (?, ?, ...)', [/* ... */]);
        call.emit('chat.message.posted', { id });
        return { id, created_at };
      },
    },
    // optional:
    routes(req, res, url, call) { /* files, media and webhooks under /files/chat/, /media/chat/, /hooks/chat/ */ return false; },
    start() {}, stop() {},
    onEnable(team) {}, onDisable(team) {},
    async exportTeam(team) { return { channels: [...], messages: [...] }; },
    // only for apps that still serve their own pages (needs "mount" in wos-app.json): served at /m/<id>/
    mount(req, res, url, call) {},
    // only the Email app: the core sends alert emails through it when Email is on for the team
    alertTransport: { async send({ alertId, teamId, personId, to, title, body, options, link, answerLinks }) {} },
  };
}
```

| `ctx` | What it gives you |
|---|---|
| `ctx.db` | `query`, `get`, `run`, `tx` with `?` placeholders, on Postgres or SQLite. Always filter by `team_id`. |
| `ctx.events` | `publish(teamId, name, data)` and `on('email.message.received', fn)`; `on('chat.*', fn)` works too. |
| `ctx.alerts.raise(...)` | Put a question, approval or notice in a person's inbox and out on their alert channels (in app, browser, phone, email). |
| `ctx.env(name)` | Settings from the environment that the manifest lists in `needs.env`. |
| `ctx.alerts.answer(alertId, personId, answer, via)` | An answer that reached your app (a reply to an alert email). Same effect as the inbox. |
| `ctx.callAs({ teamId, personId, via, label?, scopes?, trusted? }, tool, input)` | Call any tool as a team member outside a request: run by email, schedules, webhooks. The member's role scopes (or fewer), audited with `via`, and untrusted by default, so `confirm: human` tools wait for the person's yes. Returns `{ pending }` while waiting. |
| `ctx.people.members(teamId)`, `byEmail(teamId, email)`, `teamsOf(email)`, `teamsWithApp()` | Team membership, the one source of truth. Do not keep your own list; listen to `team.member.joined`, `team.member.left` and `team.member.role_changed` if you cache. |
| `ctx.dataDir`, `ctx.publicUrl`, `ctx.log` | A folder for files, the public address, a logger. |

| `call` (second argument of every handler) | |
|---|---|
| `call.actor` | `{ kind: 'person' or 'agent' or 'system', id, name, personId }` |
| `call.team` | `{ id, slug, name }` |
| `call.scopes` | What the caller may do: `read`, `write`, `delete`, `admin` |
| `call.via` | `screen`, `rest`, `mcp`, `agent`, `email` or `system` |
| `call.callTool(name, input)` | Use another app's tool as the same caller. Throws a `no_tool` error when that app is off: handle it. |
| `call.emit(name, data)` | Publish an event for this team. |

The suite has already checked sign-in, the team, the app being on, the caller's scope and the input against the tool's `input` schema before your handler runs, and writes every call to the audit log. Throw an `Error` with a plain message to refuse; the caller sees the message.

Rules:
- Handlers are the only way in. No private routes for screens.
- Keep a long-running process in mind (WebSockets, schedules) but never rely on memory for data; another copy of the server may answer the next call.
- Do not import other apps' code.

## 5. The screen part

`screens.mjs` is an ES module built for the browser (bundle your framework into it, or use none). Default export:

```js
export default {
  title: 'Chat',
  mount(el, ctx) {
    // draw into el; every button has data-tool="<tool name>"
    // ctx.callTool(name, input)  -> POST /api/tools/<name>
    // ctx.on(event, fn)          -> live events for this team
    // ctx.path, ctx.navigate(p)  -> the path inside the app (see below)
    // ctx.me, ctx.team, ctx.toast(msg)
    return () => { /* clean up */ };
  },
};
```

- Navigation: `ctx.navigate('/channels/ch_general')` changes the address bar to `/a/<id>/channels/ch_general` and the suite then calls `update(path)` on the object `mount` returned. The screen is not remounted, so return `{ unmount, update }` if your app has more than one view. The back button calls `update` too. `ctx.path` is the path at mount time.
- Style only with the ui-design kit classes (`ui-page`, `ui-ph`, `ui-btn`, `ui-dtable`, `ui-dialog` and the rest). The shell already loads the kit. Anything missing goes into the kit, not into your app.
- Sentence case. Works at 390px and 1440px wide.
- `fetch` only to `/api/tools/*`, `/files/*` and `/media/*`. The suite's lint fails the build otherwise.
- Every interactive element carries `data-tool="<name>"`, or `data-tool="none"` with `data-why="..."` when it only moves around the screen.

## 6. Standalone and in the suite

Until the suite loads your app package directly, keep shipping it standalone (as the CRM and board do): serve the same handlers at `/mcp` and `/api/tools/<name>` (or `/v1/<name>`), with GitHub sign-in and `docker-compose.yml`. The manifest and catalogue are the same files either way.
