// The conversation home: conversations.send, conversations.list, conversations.get, conversations.rename,
// conversations.delete, with tool use through the catalogue and approvals for risky tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCore, person, fakeModelServer } from './helpers.ts';

test('a model uses tools as the person and answers; history is kept', async () => {
  const core = await makeCore();
  const sam = await person(core);
  let n = 0;
  const fake = await fakeModelServer((body) => (++n === 1 ? { text: 'Checking.', tool: { name: 'team.get', args: {} } } : { text: `You have ${JSON.parse(body.messages.at(-1).content).members.length} member.` }));
  const p = await sam.call('models.add_provider', { kind: 'openai_compatible', base_url: fake.url });
  const deltas: string[] = [];
  core.events.on('conversations.message.delta', (e) => { deltas.push(e.data.text); });
  const r = await sam.call('conversations.send', { text: 'How big is my team?', provider_id: p.id, model: 'fake-1' });
  assert.equal(r.message.text.trim(), 'You have 1 member.');
  assert.deepEqual(r.message.tools, [{ name: 'team.get', error: false }]);
  assert.ok(deltas.length > 2, 'words streamed');
  assert.ok(fake.seen[0].body.tools.some((t: any) => t.function.name === 'team_get'), 'tools offered with safe names');
  const list = await sam.call('conversations.list');
  assert.equal(list.conversations[0].title, 'How big is my team?');
  const conv = await sam.call('conversations.get', { conversation_id: r.conversation_id });
  assert.deepEqual(conv.messages.map((m: any) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  await sam.call('conversations.rename', { conversation_id: r.conversation_id, title: 'Team size' });
  assert.equal((await sam.call('conversations.list', { q: 'team' })).conversations.length, 1);
  await sam.call('conversations.delete', { conversation_id: r.conversation_id });
  assert.equal((await sam.call('conversations.list')).conversations.length, 0);
  await fake.close();
  await core.stop();
});

test('the assistant cannot do a confirm: human action without the person', async () => {
  const core = await makeCore();
  const sam = await person(core);
  const jordan = await person(core, 'Jordan', 'member', sam.team);
  let n = 0;
  const fake = await fakeModelServer(() => (++n === 1 ? { tool: { name: 'team.remove_member', args: { user_id: jordan.user.id } } } : { text: 'Asked for approval.' }));
  const p = await sam.call('models.add_provider', { kind: 'openai_compatible', base_url: fake.url });
  const r = await sam.call('conversations.send', { text: 'Remove Jordan', provider_id: p.id, model: 'fake-1' });
  assert.match(r.message.text, /approval/);
  assert.equal(await core.teams.role(sam.team.id, jordan.user.id), 'member');
  assert.equal((await sam.call('alerts.list')).alerts[0].kind, 'approval');
  await fake.close();
  await core.stop();
});

test('the demo model looks things up with real tools', async () => {
  const core = await makeCore();
  const sam = await person(core);
  const r = await sam.call('conversations.send', { text: 'anything in my inbox?' });
  assert.equal(r.provider_id, 'demo');
  assert.deepEqual(r.message.tools.map((t: any) => t.name), ['alerts.list']);
  await core.stop();
});
