// Apps on and off: apps.list, apps.enable, apps.disable, apps.uninstall. Off means not loaded, no tables, no tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeCore, person, serveCore, tokenFor } from './helpers.ts';

const EXAMPLE = path.resolve('packages/manifest/example');

async function tableExists(core: any, name: string) {
  if (core.db.dialect === 'postgres') return !!(await core.db.get('SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?', [name]));
  return !!(await core.db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]));
}

test('an app that is off is not loaded, has no tables, and its tools do not exist', async () => {
  const core = await makeCore({ WOS_APPS: EXAMPLE });
  const sam = await person(core);
  const list = await sam.call('apps.list');
  const chat = list.apps.find((a: any) => a.id === 'chat');
  assert.equal(chat.on, false);
  assert.equal(chat.loaded, false);
  assert.equal(chat.screens, null, 'no screen address while off');
  assert.equal(core.registry.isLoaded('chat'), false);
  assert.equal(await tableExists(core, 'chat_messages'), false);
  assert.equal(core.catalogue.tools.has('chat.post_message'), false);
  await assert.rejects(sam.call('chat.post_message', { channel_id: 'ch_general', text: 'hi' }), (e: any) => e.code === 'no_tool');

  await sam.call('apps.enable', { app: 'chat' });
  assert.equal(core.registry.isLoaded('chat'), true);
  assert.equal(await tableExists(core, 'chat_messages'), true);
  const r = await sam.call('chat.post_message', { channel_id: 'ch_general', text: 'Standup in 5' });
  assert.match(r.id, /^msg_/);
  assert.equal((await sam.call('apps.list')).apps.find((a: any) => a.id === 'chat').screens, '/apps/chat/screens.js');

  // Another team never sees it while it is off for them.
  const jordan = await person(core, 'Jordan');
  await assert.rejects(jordan.call('chat.post_message', { channel_id: 'x', text: 'y' }), (e: any) => e.code === 'no_tool');

  // The screen file is served only to teams that have the app on.
  const s = await serveCore(core);
  const get = async (who: any) => (await fetch(`${s.url}/apps/chat/screens.js`, { headers: { authorization: `Bearer ${await tokenFor(core, who.user.id, who.team.id)}` } })).status;
  assert.equal(await get(sam), 200);
  assert.equal(await get(jordan), 404);

  await sam.call('apps.disable', { app: 'chat' });
  await assert.rejects(sam.call('chat.post_message', { channel_id: 'ch_general', text: 'again' }), (e: any) => e.code === 'no_tool');
  assert.equal(await get(sam), 404);
  assert.equal(await tableExists(core, 'chat_messages'), true, 'turning off keeps the data');
  await s.close();
  await core.stop();
});

test('core apps stay on; apps.uninstall exports first and deletes only this team\'s rows', async () => {
  const core = await makeCore({ WOS_APPS: EXAMPLE });
  const sam = await person(core);
  await assert.rejects(sam.call('apps.disable', { app: 'agents' }), /stays on/);
  await sam.call('apps.enable', { app: 'chat' });
  await sam.call('chat.post_message', { channel_id: 'ch_general', text: 'one' });
  const riley = await person(core, 'Riley');
  await riley.call('apps.enable', { app: 'chat' });
  await riley.call('chat.post_message', { channel_id: 'ch_general', text: 'riley' });
  await assert.rejects(sam.call('apps.uninstall', { app: 'chat', confirm_name: 'nope' }), /Type "Chat"/);
  const r = await sam.call('apps.uninstall', { app: 'chat', confirm_name: 'Chat' });
  assert.equal(r.deleted_rows, 1);
  assert.match(r.export_url, /exports/);
  assert.equal((await core.db.query('SELECT * FROM chat_messages')).length, 1, "Riley's team keeps its data");
  assert.equal((await sam.call('apps.list')).apps.find((a: any) => a.id === 'chat').on, false);
  await core.stop();
});

test('an agent cannot uninstall without a person saying yes', async () => {
  const core = await makeCore({ WOS_APPS: EXAMPLE });
  const sam = await person(core);
  await sam.call('apps.enable', { app: 'chat' });
  const agent = { ...sam.caller, actor: { kind: 'agent' as const, id: 'ag_x', name: 'Cleaner', personId: sam.user.id } };
  const r = await core.catalogue.call('apps.uninstall', { app: 'chat', confirm_name: 'Chat' }, agent, 'agent');
  assert.ok(r.pending, 'waits for approval');
  assert.equal((await sam.call('apps.list')).apps.find((a: any) => a.id === 'chat').on, true);
  await core.stop();
});
