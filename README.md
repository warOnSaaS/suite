# wOS

One app for a team and its AI agents. It opens on a conversation, like the Claude and ChatGPT apps, and around it sit the apps you and your agents both work in: Agents, the board, CRM, and soon Chat, Email and Meetings. Switch any app on or off; an app that is off is not loaded at all. Pick your model: your Anthropic or OpenAI key, a local model through Ollama, or any OpenAI-compatible server.

**Host it yourself, free** (one `docker compose up`, or one person with nothing but Node) **or host with us** (we run it and charge what it costs us times two, shown openly). Same code either way, and you can export everything at any time.

Status: early. See `docs/DECISIONS.md` and the roadmap.

## For app builders

Every wOS app ships the same contract:

| Package | What it is |
|---|---|
| [`packages/manifest`](packages/manifest) | `wos-app.json`: what the app is, its tables, server part and screens. Read this first. |
| [`packages/tools`](packages/tools) | `tools.json`: every action as a tool, served over MCP, REST and to the screens from one handler. |

Licence: AGPL-3.0-only.
