// The MCP gateway and its OAuth sign-in, plus the agent run test (ROADMAP 3.2): a scripted agent using only
// MCP completes the shell's main journeys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { makeCore, person, serveCore, tokenFor } from './helpers.ts';

async function mcp(url: string, token: string, method: string, params: unknown = {}) {
  const r = await fetch(`${url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return { status: r.status, body: await r.json().catch(() => null) as any, headers: r.headers };
}

test('OAuth for MCP apps: discovery, registration, consent, PKCE, refresh rotation, reuse revokes the family', async () => {
  const core = await makeCore();
  const sam = await person(core);
  const s = await serveCore(core);
  const unauth = await fetch(`${s.url}/mcp`, { method: 'POST', body: '{}' });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate')!, /resource_metadata=/);
  const meta = await (await fetch(`${s.url}/.well-known/oauth-authorization-server`)).json();
  const reg = await (await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['http://localhost:7777/cb'] }) })).json();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ client_id: reg.client_id, redirect_uri: 'http://localhost:7777/cb', state: 's1', code_challenge: challenge, code_challenge_method: 'S256' });
  const cookie = `wos_session=${await tokenFor(core, sam.user.id, sam.team.id)}`;
  // Signed out: sent to sign in.
  assert.equal((await fetch(`${s.url}/oauth/authorize?${q}`, { redirect: 'manual' })).status, 302);
  const consent = await (await fetch(`${s.url}/oauth/authorize?${q}`, { headers: { cookie } })).text();
  assert.match(consent, /Connect Claude/);
  const consentToken = /name="consent" value="([^"]+)"/.exec(consent)![1];
  const form = new URLSearchParams({ ...Object.fromEntries(q), consent: consentToken, team: sam.team.id, scope_read: 'on', scope_write: 'on' });
  const back = await fetch(`${s.url}/oauth/authorize`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: form, redirect: 'manual' });
  const code = new URL(back.headers.get('location')!).searchParams.get('code')!;
  const tok = async (body: Record<string, string>) => (await fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) })).json() as any;
  assert.equal((await tok({ grant_type: 'authorization_code', code, client_id: reg.client_id, code_verifier: 'wrong' })).error, 'invalid_grant');
  const t1 = await tok({ grant_type: 'authorization_code', code, client_id: reg.client_id, code_verifier: verifier, redirect_uri: 'http://localhost:7777/cb' });
  assert.match(t1.access_token, /^wos_/);
  assert.equal(t1.scope, 'read write');
  assert.equal((await tok({ grant_type: 'authorization_code', code, client_id: reg.client_id, code_verifier: verifier })).error, 'invalid_grant', 'a code works once');
  const list = await mcp(s.url, t1.access_token, 'tools/list');
  const names = list.body.result.tools.map((t: any) => t.name);
  assert.ok(names.includes('agents_start'));
  assert.ok(!names.includes('apps_enable'), 'no admin tools without the admin scope');
  const t2 = await tok({ grant_type: 'refresh_token', refresh_token: t1.refresh_token });
  assert.match(t2.access_token, /^wos_/);
  assert.equal((await mcp(s.url, t1.access_token, 'ping')).status, 401, 'the old access token stops');
  assert.equal((await mcp(s.url, t2.access_token, 'ping')).status, 200);
  // Someone replays the old refresh token: the whole family is revoked.
  assert.equal((await tok({ grant_type: 'refresh_token', refresh_token: t1.refresh_token })).error, 'invalid_grant');
  assert.equal((await mcp(s.url, t2.access_token, 'ping')).status, 401);
  await s.close();
  await core.stop();
});

test('agent run test: using only MCP, an agent turns an app off and on, invites a teammate, starts an agent and exports everything', async () => {
  const core = await makeCore({ WOS_APPS: path.resolve('packages/manifest/example') });
  const sam = await person(core);
  const s = await serveCore(core);
  const token = await tokenFor(core, sam.user.id, sam.team.id);
  const call = async (name: string, args: unknown = {}) => {
    const r = await mcp(s.url, token, 'tools/call', { name, arguments: args });
    assert.equal(r.status, 200);
    if (r.body.error) throw new Error(r.body.error.message);
    return r.body.result;
  };
  const init = await mcp(s.url, token, 'initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.body.result.serverInfo.name, 'wOS');
  await call('apps_enable', { app: 'chat' });
  let tools = (await mcp(s.url, token, 'tools/list')).body.result.tools.map((t: any) => t.name);
  assert.ok(tools.includes('chat_post_message'));
  await call('apps.disable', { app: 'chat' });
  tools = (await mcp(s.url, token, 'tools/list')).body.result.tools.map((t: any) => t.name);
  assert.ok(!tools.includes('chat_post_message'), 'off: gone from MCP');
  await assert.rejects(call('chat.post_message', { channel_id: 'a', text: 'b' }), /turned off/);
  await call('apps.enable', { app: 'chat' });
  const inv = await call('team.invite', { email: 'riley@acme-dental.example' });
  assert.match(inv.structuredContent.link, /invite/);
  const ag = await call('agents.create', { name: 'Helper', role: 'Helps', provider_id: 'demo' });
  const run = await call('agents.start', { agent_id: ag.structuredContent.id, goal: 'Tidy the board' });
  assert.equal(run.structuredContent.status, 'working');
  const exp = await call('hosting.export');
  assert.match(exp.structuredContent.url, /exports/);
  // Removing a teammate over MCP needs the person's yes.
  const rm = await call('team.remove_member', { user_id: sam.user.id });
  assert.ok(rm.structuredContent.pending);
  await s.close();
  await core.stop();
});
