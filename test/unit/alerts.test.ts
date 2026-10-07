// The inbox and alert channels: alerts.list, alerts.answer, alerts.clear, alerts.get_rules, alerts.set_rules,
// alerts.push_key, alerts.subscribe_push, alerts.unsubscribe_push, alerts.send_test; approvals for agents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCore, person, serveCore } from './helpers.ts';
import { sign } from '../../core/crypto.ts';

test('raise, list, answer by number or words, clear', async () => {
  const core = await makeCore();
  const sam = await person(core);
  const a = await sam.call('alerts.send_test', { kind: 'question' });
  let inbox = await sam.call('alerts.list');
  assert.equal(inbox.open, 1);
  assert.deepEqual(inbox.alerts[0].options, ['Yes, got it', 'Something is off']);
  const r = await sam.call('alerts.answer', { alert_id: a.id, option: 1 });
  assert.equal(r.answer, 'Something is off');
  assert.equal((await sam.call('alerts.list')).open, 0);
  assert.equal((await sam.call('alerts.list', { status: 'answered' })).alerts.length, 1);
  const b = await sam.call('alerts.send_test', {});
  await sam.call('alerts.answer', { alert_id: b.id, text: 'Looks fine to me' });
  const c = await sam.call('alerts.send_test', {});
  assert.equal((await sam.call('alerts.clear', { alert_id: c.id })).cleared, true);
  assert.equal((await sam.call('alerts.list', { status: 'cleared' })).alerts.length, 1);
  await assert.rejects(sam.call('alerts.answer', { alert_id: c.id }), /Pick an option/);
  const jordan = await person(core, 'Jordan', 'member', sam.team);
  const d = await sam.call('alerts.send_test', {});
  await assert.rejects(jordan.call('alerts.answer', { alert_id: d.id, option: 0 }), /No such alert/);
  await core.stop();
});

test('rules: defaults, change, and email after the wait', async () => {
  const core = await makeCore();
  const sam = await person(core);
  const rules = await sam.call('alerts.get_rules');
  assert.equal(rules.kinds.approval.email_after_min, 10);
  assert.equal(rules.kinds.done.push, false, 'done goes to the inbox only');
  await sam.call('alerts.set_rules', { kinds: { question: { email: true, email_after_min: 0 } }, quiet_hours: null });
  await sam.call('alerts.send_test', { kind: 'question' });
  const mail = await core.db.query<any>('SELECT * FROM outbox WHERE to_addr = ?', ['sam@acme-dental.example']);
  assert.equal(mail.length, 1, 'emailed at once');
  assert.match(mail[0].body, /\/alerts\/answer\?t=/);
  // An approval waits ten minutes before email.
  await core.alerts.raise({ teamId: sam.team.id, personId: sam.user.id, kind: 'approval', title: 'Approve?', options: ['Approve', 'Deny'] });
  await core.alerts.escalate();
  assert.equal((await core.db.query('SELECT * FROM outbox')).length, 1);
  await core.db.run("UPDATE alerts SET created_at = ? WHERE kind = 'approval'", [new Date(Date.now() - 11 * 60e3).toISOString()]);
  await core.alerts.escalate();
  assert.equal((await core.db.query('SELECT * FROM outbox')).length, 2);
  await core.stop();
});

test('push: key, subscribe, unsubscribe', async () => {
  const core = await makeCore();
  const sam = await person(core);
  const k = await sam.call('alerts.push_key');
  assert.ok(k.public_key && k.public_key.length > 40);
  await sam.call('alerts.subscribe_push', { endpoint: 'https://push.example/abc', keys: { p256dh: 'x', auth: 'y' }, device: 'test' });
  assert.equal((await sam.call('alerts.get_rules')).push_devices, 1);
  assert.equal((await sam.call('alerts.unsubscribe_push', {})).removed, 1);
  await core.stop();
});

test('an agent calling a confirm: human tool waits; approving runs it, denying does not', async () => {
  const core = await makeCore();
  const sam = await person(core);
  const agent = { ...sam.caller, actor: { kind: 'agent' as const, id: 'ag_1', name: 'Helper', personId: sam.user.id } };
  const jordan = await person(core, 'Jordan', 'member', sam.team);
  const r = await core.catalogue.call('team.remove_member', { user_id: jordan.user.id }, agent, 'agent');
  assert.ok(r.pending?.alert_id);
  assert.equal(await core.teams.role(sam.team.id, jordan.user.id), 'member', 'not removed yet');
  const inbox = await sam.call('alerts.list');
  assert.equal(inbox.alerts[0].kind, 'approval');
  assert.match(inbox.alerts[0].title, /Helper wants to: remove from team/);
  const out = await sam.call('alerts.answer', { alert_id: r.pending!.alert_id, option: 0 });
  assert.equal(out.outcome.status, 'done');
  assert.equal(await core.teams.role(sam.team.id, jordan.user.id), null);
  const r2 = await core.catalogue.call('account.create_token', { name: 'sneaky' }, agent, 'agent');
  await sam.call('alerts.answer', { alert_id: r2.pending!.alert_id, option: 1 });
  assert.equal((await sam.call('account.list_tokens')).tokens.length, 0);
  await core.stop();
});

test('answering from an email link needs a press, and a forged link does nothing', async () => {
  const core = await makeCore();
  const sam = await person(core);
  const s = await serveCore(core);
  const a = await sam.call('alerts.send_test', {});
  const t = sign({ k: 'answer', a: a.id, o: 0, u: sam.user.id }, 600);
  const page = await fetch(`${s.url}/alerts/answer?t=${encodeURIComponent(t)}`);
  assert.match(await page.text(), /Yes, got it/);
  assert.equal((await sam.call('alerts.list')).open, 1, 'opening the link answers nothing');
  await fetch(`${s.url}/alerts/answer?t=${encodeURIComponent(t)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
  const done = (await sam.call('alerts.list', { status: 'answered' })).alerts[0];
  assert.equal(done.answered_via, 'email');
  assert.equal((await fetch(`${s.url}/alerts/answer?t=forged.x`)).status, 400);
  await s.close();
  await core.stop();
});
