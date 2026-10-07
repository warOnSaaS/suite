// A fresh core on an in-memory SQLite database, with a person and a team, for tests.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Core } from '../../core/core.ts';
import { ROLE_SCOPES, type Caller, type Role } from '../../core/types.ts';

export async function makeCore(env: Record<string, string> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-test-'));
  const core = new Core({ env: { WOS_DB: 'memory', WOS_SECRET_KEY: 'test-key', PUBLIC_URL: 'http://localhost:9', WOS_DEFAULT_APPS: '', WOS_REDUCED: '1', WOS_DEMO_PACE_MS: '0', ...env }, dataDir, quiet: true });
  await core.start();
  return core;
}

export async function person(core: Core, name = 'Sam', role: Role = 'owner', team?: { id: string; slug: string; name: string }) {
  const user = await core.users.create({ name, email: `${name.toLowerCase()}@acme-dental.example` });
  const t = team ?? (await core.teams.create('Acme Dental', user.id));
  if (team) await core.teams.addMember(team.id, user.id, role);
  const caller: Caller = { actor: { kind: 'person', id: user.id, name }, user, team: t, role, scopes: ROLE_SCOPES[role] };
  const call = async (tool: string, input: unknown = {}) => (await core.catalogue.call(tool, input, caller, 'screen')).result as any;
  return { user, team: t, caller, call };
}

/** The real HTTP handler on a random port, for REST, MCP and OAuth tests. */
export async function serveCore(core: Core) {
  const http = await import('node:http');
  const { handle } = await import('../../core/http.ts');
  const srv = http.createServer((req, res) => { handle(core, req, res); });
  await new Promise<void>((r) => srv.listen(0, r));
  const port = (srv.address() as any).port;
  core.publicUrl = `http://localhost:${port}`;
  return { url: core.publicUrl, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) };
}

/** A personal access token for a person (as Settings, Account would make). */
export async function tokenFor(core: Core, userId: string, teamId: string, scopes = ['read', 'write', 'delete', 'admin']) {
  const { createSession } = await import('../../core/accounts.ts');
  return (await createSession(core, userId, teamId, 'token', { clientName: 'test', scopes: scopes as any })).token;
}

/** A tiny OpenAI-compatible model server that follows a script of replies (text or tool calls). */
export async function fakeModelServer(script: (body: any) => { text?: string; tool?: { name: string; args: unknown } }) {
  const http = await import('node:http');
  const seen: any[] = [];
  const srv = http.createServer(async (req, res) => {
    let b = '';
    for await (const c of req) b += c;
    if (req.url?.endsWith('/models')) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'fake-1' }, { id: 'fake-2' }] }));
    const body = JSON.parse(b || '{}');
    seen.push({ body, auth: req.headers.authorization });
    const step = script(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (step.text) for (const w of step.text.split(' ')) send({ choices: [{ delta: { content: `${w} ` } }] });
    if (step.tool) send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${seen.length}`, function: { name: step.tool.name.replace('.', '__'), arguments: JSON.stringify(step.tool.args) } }] } }] });
    send({ choices: [{ delta: {}, finish_reason: step.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((r) => srv.listen(0, r));
  return { url: `http://localhost:${(srv.address() as any).port}/v1`, seen, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }) };
}
