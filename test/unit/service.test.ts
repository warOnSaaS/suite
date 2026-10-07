// What the core gives apps for work outside a request: ctx.callAs (run by email), ctx.people (one membership
// list) and the Email app's alert transport. Uses a stand-in Email app in test/fixtures/email-like.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeCore, person } from './helpers.ts';

test('email.run_command: a command email runs another tool as the sender, audited, untrusted', async () => {
  const core = await makeCore({ WOS_APPS: path.resolve('test/fixtures/email-like') });
  const sam = await person(core);
  const jordan = await person(core, 'Jordan', 'member', sam.team);
  await sam.call('apps.enable', { app: 'email' });
  const r = await sam.call('email.run_command', { from: 'jordan@acme-dental.example', tool: 'team_get' });
  assert.equal(r.out.members.length, 2);
  const a = await core.db.get<any>("SELECT * FROM audit WHERE tool = 'team.get' AND via = 'email'");
  assert.equal(a.actor_id, jordan.user.id);
  assert.match(a.actor_name, /Jordan \(email\)/);
  // Scopes are the sender's: a member cannot do admin by email either.
  await assert.rejects(sam.call('email.run_command', { from: 'jordan@acme-dental.example', tool: 'team.invite', input: { email: 'x@y.example' } }), /admin access/);
  // A confirm: human tool by email waits for a yes, even for the owner.
  const p = await sam.call('email.run_command', { from: 'sam@acme-dental.example', tool: 'team.remove_member', input: { user_id: jordan.user.id } });
  assert.ok(p.out.pending);
  assert.equal(await core.teams.role(sam.team.id, jordan.user.id), 'member');
  await assert.rejects(sam.call('email.run_command', { from: 'riley@elsewhere.example', tool: 'team.get' }), /not on this team/);
  await core.stop();
});

test('alert emails go through the Email app when it is on, and replies answer them', async () => {
  const core = await makeCore({ WOS_APPS: path.resolve('test/fixtures/email-like') });
  const sam = await person(core);
  await sam.call('alerts.set_rules', { kinds: { question: { email: true, email_after_min: 0 } } });
  await sam.call('alerts.send_test', {});
  assert.equal((await core.db.query('SELECT * FROM outbox')).length, 1, 'Email off: plain mail from the core');
  await sam.call('apps.enable', { app: 'email' });
  const mod: any = await import('../fixtures/email-like/server.mjs');
  const a = await sam.call('alerts.send_test', {});
  assert.equal(mod.sent.length, 1);
  assert.equal(mod.sent[0].to, 'sam@acme-dental.example');
  assert.deepEqual(mod.sent[0].options, ['Yes, got it', 'Something is off']);
  assert.equal((await core.db.query('SELECT * FROM outbox')).length, 1, 'no second plain mail');
  await (core.registry.apps.get('email')!.server as any).answerFromReply(a.id, sam.user.id, 'Yes, got it');
  assert.equal((await sam.call('alerts.list', { status: 'answered' })).alerts[0].answered_via, 'email');
  await core.stop();
});
