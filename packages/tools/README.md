# @wos/tools: the tool catalogue format

Every action a person can take in a wOS app is written once, as a **tool**. The suite serves each tool three ways from the same handler:

| Who calls | How |
|---|---|
| Agents (Claude app, ChatGPT, Codex, Claude Code, wOS's own agents) | MCP at `/mcp` (Streamable HTTP, `tools/list` and `tools/call`) |
| Any program, ChatGPT GPT Actions | `POST /api/tools/<name>` with a JSON body; OpenAPI at `/api/openapi.json` |
| The app's own screens | the same `POST /api/tools/<name>`, through one `callTool(name, input)` function |

Screens never call private routes. A build test fails when a button, menu item or form has no `data-tool="<name>"` naming a tool in the catalogue (see `docs/PARITY.md`).

## The file

Each app ships `tools.json` next to its `wos-app.json`. Schema: [`tools.schema.json`](tools.schema.json). A full example: [`example.tools.json`](example.tools.json).

```json
{
  "$schema": "https://raw.githubusercontent.com/warOnSaaS/suite/main/packages/tools/tools.schema.json",
  "app": "chat",
  "version": 1,
  "tools": [
    {
      "name": "chat.post_message",
      "title": "Post a message",
      "description": "Post a message in a channel, or reply in a thread when thread_id is given. Returns the new message.",
      "input": { "type": "object", "properties": { "channel_id": { "type": "string" }, "text": { "type": "string" } }, "required": ["channel_id", "text"] },
      "output": { "type": "object", "properties": { "id": { "type": "string" } } },
      "scope": "write",
      "confirm": "none",
      "emits": ["chat.message.posted"],
      "test": "test/tools.test.mjs"
    }
  ]
}
```

| Field | Required | Rule |
|---|---|---|
| `name` | yes | `app.verb_noun`, lower snake case after the dot: `crm.move_deal`, `board.hand_off`, `meet.start_recording`. The part before the dot is the app id. |
| `title` | yes | Sentence case, as the button says it: "Post a message". |
| `description` | yes | Plain words for a person and a model: what it does, when to use it, what comes back. No em dashes. |
| `input` | yes | JSON Schema, always `"type": "object"`. Describe each property. |
| `output` | yes | JSON Schema of the result. Keep results small: ids, names, counts, a short text. |
| `scope` | yes | `read` (looks only), `write` (creates or changes), `delete` (removes), `admin` (team, apps, billing, hosting). |
| `confirm` | yes | `none`, or `human`: when an **agent** calls it, the call waits for a person's yes. A person pressing the button is the yes. Use `human` for anything that pays, deletes for everyone, sends outside the team or changes the plan. |
| `emits` | no | Event names the tool may publish: `app.noun.past_verb`, such as `chat.message.posted`. Other apps listen to events, never to your tables. |
| `test` | for the suite | Path of the test that exercises the tool. The suite's catalogue test fails without one. |
| `public` | no | Callable without sign-in. Rare. |
| `hidden` | no | Not offered to models by default (still callable): screen-only conveniences such as saving a panel layout. |

Check a file:

```sh
node packages/tools/bin/check.mjs path/to/tools.json      # or: npx wos-check-tools tools.json
```

## Calling a tool over REST

```
POST /api/tools/chat.post_message
content-type: application/json
authorization: Bearer <token>          (programs and agents)
cookie: wos_session=...  + x-wos: 1    (the suite's own screens)

{ "channel_id": "ch_general", "text": "Standup in 5" }
```

| Status | Body | Meaning |
|---|---|---|
| 200 | `{ "result": { ... } }` | Done. `result` matches `output`. |
| 202 | `{ "pending": { "approval_id": "al_...", "message": "Waiting for Sam to approve" } }` | A `confirm: human` tool called by an agent. The person answers in their inbox, by notification or by email; the tool then runs and the agent is told. |
| 400 | `{ "error": { "code": "invalid_input", "message": "text: required" } }` | The input did not match `input`, or the handler refused it. |
| 401 | `{ "error": { "code": "sign_in" } }` | No session or token. |
| 403 | `{ "error": { "code": "scope" } }` | The caller lacks the tool's scope. |
| 404 | `{ "error": { "code": "no_tool" } }` | No such tool, **or the app is off** for this team. |

Errors always have a plain-language `message` a person can act on.

## Over MCP

`tools/list` returns every tool of every app that is on for the caller's team, limited to the caller's scopes. Each entry has `name`, `title`, `description`, `inputSchema`, `outputSchema` and annotations (`readOnlyHint` for `read`, `destructiveHint` for `delete`). `tools/call` returns the result as JSON text plus `structuredContent`.

## In a screen

```html
<button data-tool="chat.post_message">Send</button>
```

Every interactive element names the tool it calls. Elements that only move around the screen (open a panel, switch a tab, focus a field) carry `data-tool="none"` and a reason in `data-why`, so the parity test can tell them apart from forgotten tools.

## Helpers in this package

```js
import { checkCatalogue, checkTool, toMcp, toOpenApi } from '@wos/tools';
```

`index.d.ts` has the `ToolSpec` and `ToolCatalogue` types. The package has no dependencies; copy it into your repo if you prefer that to installing from GitHub.
