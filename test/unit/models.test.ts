// The model router: models.list_providers, models.add_provider, models.test_provider, models.set_default,
// models.remove_provider. Keys are sealed at rest and never come back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCore, person, fakeModelServer } from './helpers.ts';

test('add an OpenAI-compatible provider: tested first, key sealed, never shown', async () => {
  const core = await makeCore();
  const sam = await person(core);
  const fake = await fakeModelServer(() => ({ text: 'Hello from the fake model' }));
  await assert.rejects(sam.call('models.add_provider', { kind: 'openai_compatible', base_url: 'http://127.0.0.1:1/v1' }), /Could not connect/);
  const p = await sam.call('models.add_provider', { kind: 'openai_compatible', base_url: fake.url, api_key: 'sk-test-secret-1234567890', name: 'Office server' });
  assert.equal(p.models, 2);
  const row = await core.db.get<any>('SELECT secret FROM model_providers WHERE id = ?', [p.id]);
  assert.ok(row.secret && !row.secret.includes('sk-test'), 'stored sealed');
  const list = await sam.call('models.list_providers');
  assert.equal(JSON.stringify(list).includes('sk-test'), false, 'never sent back');
  assert.equal(list.default.provider_id, p.id, 'the first real provider becomes the default');
  assert.ok(list.providers.some((x: any) => x.kind === 'demo'));
  assert.deepEqual(await sam.call('models.test_provider', { provider_id: p.id }), { ok: true, models: 2 });
  await sam.call('models.set_default', { provider_id: 'demo', model: 'demo-scripted' });
  assert.equal((await sam.call('models.list_providers')).default.provider_id, 'demo');
  // A member's own provider is theirs; shared ones need admin.
  const riley = await person(core, 'Riley', 'member', sam.team);
  assert.equal((await riley.call('models.list_providers')).providers.some((x: any) => x.id === p.id), false);
  await assert.rejects(riley.call('models.add_provider', { kind: 'ollama', base_url: fake.url, shared: true }), /admins/);
  await sam.call('models.remove_provider', { provider_id: p.id });
  assert.equal((await sam.call('models.list_providers')).providers.some((x: any) => x.id === p.id), false);
  // The key reached the server as a bearer token.
  const r2 = await sam.call('models.add_provider', { kind: 'openai_compatible', base_url: fake.url, api_key: 'sk-test-2' });
  await sam.call('conversations.send', { text: 'hi', provider_id: r2.id, model: 'fake-1' });
  assert.equal(fake.seen.at(-1).auth, 'Bearer sk-test-2');
  await fake.close();
  await core.stop();
});

test('Anthropic and OpenAI need a key; Claude subscriptions are not offered', async () => {
  const core = await makeCore();
  const sam = await person(core);
  await assert.rejects(sam.call('models.add_provider', { kind: 'anthropic' }), /needs an API key/);
  const kinds = (await sam.call('models.list_providers')).kinds.map((k: any) => k.kind);
  assert.deepEqual(kinds, ['anthropic', 'openai', 'ollama', 'openai_compatible']);
  await core.stop();
});
