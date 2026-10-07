// The example app's own tests: run its handlers against a stand-in ctx. Run: node --test packages/manifest/example/test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import register from '../server.mjs';

test('chat.post_message and chat.delete_channel', async () => {
  const rows = [];
  const ctx = { db: { run: async (sql, params) => { rows.push({ sql, params }); return { changes: 1 }; } } };
  const events = [];
  const call = { team: { id: 't1' }, actor: { kind: 'person', id: 'u1' }, emit: (n, d) => events.push(n) };
  const { handlers } = register(ctx);
  const m = await handlers['chat.post_message']({ channel_id: 'ch_general', text: 'hi' }, call);
  assert.match(m.id, /^msg_/);
  assert.deepEqual(events, ['chat.message.posted']);
  assert.equal((await handlers['chat.delete_channel']({ channel_id: 'ch_general' }, call)).deleted, true);
});
