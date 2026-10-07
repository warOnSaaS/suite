// Accounts, teams, roles and scopes, tokens, hosting and audit: account.*, team.*, hosting.*, audit.*, events.poll.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCore, person, serveCore, tokenFor } from './helpers.ts';

test('account.me, account.update_profile, account.switch_team and team.create', async () => {
  const core = await makeCore();
  const sam = await person(core);
  const me = await sam.call('account.me');
  assert.equal(me.user.name, 'Sam');
  assert.equal(me.team.role, 'owner');
  assert.deepEqual(me.team.scopes, ['read', 'write', 'delete', 'admin']);
  await sam.call('account.update_profile', { name: 'Sam Rivera' });
  assert.equal((await core.users.get(sam.user.id))!.name, 'Sam Rivera');
  const t2 = await sam.call('team.create', { name: 'Birch Law' });
  assert.equal(t2.slug, 'birch-law');
  const switched = await sam.call('account.switch_team', { team_id: t2.id });
  assert.equal(switched.team.name, 'Birch Law');
  await assert.rejects(sam.call('account.switch_team', { team_id: 't_nope' }), /not on that team/);
  await core.stop();
});

test('team.invite, team.get, team.revoke_invite, team.set_role, team.update and team.remove_member', async () => {
  const core = await makeCore();
  const sam = await person(core);
  const inv = await sam.call('team.invite', { email: 'jordan@birch-law.example', role: 'member' });
  assert.match(inv.link, /\/auth\/invite\?t=/);
  assert.equal(inv.emailed, false); // no SMTP in tests: written to the outbox instead
  const out = await core.db.get<any>('SELECT * FROM outbox WHERE to_addr = ?', ['jordan@birch-law.example']);
  assert.equal(out.status, 'logged');
  let t = await sam.call('team.get');
  assert.equal(t.invites.length, 1);
  // Jordan signs in by email: the invite is accepted.
  const jordan = await core.users.fromEmail('jordan@birch-law.example');
  await core.teams.acceptInvitesFor(jordan);
  t = await sam.call('team.get');
  assert.equal(t.members.length, 2);
  await sam.call('team.set_role', { user_id: jordan.id, role: 'guest' });
  assert.equal(await core.teams.role(sam.team.id, jordan.id), 'guest');
  await assert.rejects(sam.call('team.set_role', { user_id: sam.user.id, role: 'member' }), /owner/);
  const inv2 = await sam.call('team.invite', { github: '@casey', role: 'admin' });
  assert.equal((await sam.call('team.revoke_invite', { invite_id: inv2.id })).revoked, true);
  await sam.call('team.update', { name: 'Acme Dental Group', github_org: 'acme-dental' });
  assert.equal((await core.teams.get(sam.team.id))!.github_org, 'acme-dental');
  await sam.call('team.remove_member', { user_id: jordan.id });
  assert.equal(await core.teams.role(sam.team.id, jordan.id), null);
  await core.stop();
});

test('roles limit scopes: a guest can read but not write; a member cannot do admin', async () => {
  const core = await makeCore();
  const sam = await person(core);
  const casey = await person(core, 'Casey', 'guest', sam.team);
  const riley = await person(core, 'Riley', 'member', sam.team);
  assert.ok(await casey.call('apps.list'));
  await assert.rejects(casey.call('conversations.send', { text: 'hi' }), (e: any) => e.code === 'scope');
  await assert.rejects(riley.call('team.invite', { email: 'x@y.example' }), (e: any) => e.code === 'scope');
  await assert.rejects(riley.call('nope.tool'), (e: any) => e.code === 'no_tool');
  await assert.rejects(riley.call('team.invite', {}), (e: any) => e.code === 'scope');
  await assert.rejects(sam.call('team.set_role', { user_id: 'x' }), (e: any) => e.code === 'invalid_input');
  await core.stop();
});

test('account.create_token, account.list_tokens, account.revoke_token and account.sign_out over REST', async () => {
  const core = await makeCore();
  const sam = await person(core);
  const s = await serveCore(core);
  // Token creation needs a person: an agent asking for one waits for approval.
  const made = await sam.call('account.create_token', { name: 'nightly import', scopes: ['read'] });
  assert.match(made.token, /^wos_/);
  const post = (name: string, body: unknown, token = made.token) => fetch(`${s.url}/api/tools/${name}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let r = await post('account.me', {});
  assert.equal(r.status, 200);
  r = await post('team.create', { name: 'Nope' });
  assert.equal(r.status, 403, 'a read-only token cannot write');
  assert.equal((await sam.call('account.list_tokens')).tokens.length, 1);
  await sam.call('account.revoke_token', { token_id: made.id });
  r = await post('account.me', {});
  assert.equal(r.status, 401);
  // Cookie calls without the screens' header are refused (cross-site forms).
  const full = await tokenFor(core, sam.user.id, sam.team.id);
  r = await fetch(`${s.url}/api/tools/account.me`, { method: 'POST', headers: { cookie: `wos_session=${full}` }, body: '{}' });
  assert.equal(r.status, 403);
  r = await fetch(`${s.url}/api/tools/account.sign_out`, { method: 'POST', headers: { cookie: `wos_session=${full}`, 'x-wos': '1' }, body: '{}' });
  assert.equal(r.status, 200);
  r = await post('account.me', {}, full);
  assert.equal(r.status, 401, 'signed out');
  await s.close();
  await core.stop();
});

test('hosting.status, hosting.doctor, hosting.export, audit.list and events.poll', async () => {
  const core = await makeCore();
  const sam = await person(core);
  const st = await sam.call('hosting.status');
  assert.equal(st.mode, 'self-hosted');
  assert.match(st.storage, /SQLite/);
  const doc = await sam.call('hosting.doctor');
  assert.ok(doc.checks.some((c: any) => c.name === 'Email' && !c.ok));
  const exp = await sam.call('hosting.export');
  assert.match(exp.url, /^\/files\/core\/exports\/acme-dental-/);
  const s = await serveCore(core);
  const dl = await fetch(s.url + exp.url);
  assert.equal(dl.status, 200);
  const body = await dl.json();
  assert.equal(body.format, 'wos-export-1');
  assert.equal(body.core.members.length, 1);
  assert.equal((await fetch(s.url + exp.url.replace(/t=.*/, 't=forged'))).status, 403);
  await s.close();
  const log = await sam.call('audit.list', { limit: 10 });
  assert.ok(log.entries.some((e: any) => e.tool === 'hosting.export'));
  const since = new Date(Date.now() - 1000).toISOString();
  await sam.call('team.update', { name: 'Acme' });
  core.events.publish(sam.team.id, 'test.thing.happened', { n: 1 });
  await new Promise((r) => setTimeout(r, 30));
  const ev = await sam.call('events.poll', { since, names: ['test.*'] });
  assert.equal(ev.events.length, 1);
  await core.stop();
});
