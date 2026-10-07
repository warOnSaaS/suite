import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoAdapter } from '../../core/models/demo.ts';

// The demo model turns a plain two-part command into real tool calls, one per turn, then says what it did.
test('demo model: create a contact and post in a channel, in order', async () => {
  const m = demoAdapter();
  const tools = ['crm.create_contact', 'chat.post_message'].map((name) => ({ name, description: name, input: { type: 'object' } })) as any;
  const messages: any[] = [{ role: 'user', content: [{ type: 'text', text: 'create a contact for Dana at Acme Dental and post in #general that I did' }] }];
  const r1 = await m.chat({ system: '', messages, tools } as any);
  const c1 = r1.parts.find((p: any) => p.type === 'tool_call') as any;
  assert.equal(c1.name, 'crm.create_contact');
  assert.deepEqual(c1.input, { first_name: 'Dana', org: 'Acme Dental' });
  messages.push({ role: 'assistant', content: r1.parts }, { role: 'user', content: [{ type: 'tool_result', id: c1.id, name: c1.name, output: 'Added Dana (c_x1)' }] });
  const r2 = await m.chat({ system: '', messages, tools } as any);
  const c2 = r2.parts.find((p: any) => p.type === 'tool_call') as any;
  assert.equal(c2.name, 'chat.post_message');
  assert.deepEqual(c2.input, { channel: 'general', body: 'I created a contact for Dana at Acme Dental in the CRM.' });
  messages.push({ role: 'assistant', content: r2.parts }, { role: 'user', content: [{ type: 'tool_result', id: c2.id, name: c2.name, output: 'posted' }] });
  const r3 = await m.chat({ system: '', messages, tools } as any);
  assert.equal(r3.stop, 'end');
  assert.match((r3.parts[0] as any).text, /created a contact for Dana at Acme Dental.*posted in #general/s);
});
