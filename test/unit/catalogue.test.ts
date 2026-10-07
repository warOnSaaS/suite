// The catalogue test (ROADMAP 3.2): with every app on, every tool has a valid spec (name, plain description,
// input and output schema, scope, confirm), a handler, a test that names it, and is reachable over MCP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { checkTool, toWire } from '../../packages/tools/index.mjs';
import { makeCore, person, serveCore, tokenFor } from './helpers.ts';

const EXAMPLE = path.resolve('packages/manifest/example');

test('every tool is complete, tested and reachable over MCP', async () => {
  const core = await makeCore({ WOS_APPS: EXAMPLE });
  const sam = await person(core);
  for (const a of (await sam.call('apps.list')).apps) if (!a.on && !a.unavailable) await sam.call('apps.enable', { app: a.id });
  const tools = [...core.catalogue.tools.values()];
  assert.ok(tools.length > 60, `only ${tools.length} tools`);
  const problems: string[] = [];
  const testText = new Map<string, string>();
  for (const t of tools) {
    const { app, handler, ...spec } = t as any;
    problems.push(...checkTool(spec, t.name.split('.')[0]));
    if (typeof handler !== 'function') problems.push(`${t.name}: no handler`);
    if (!t.test) { problems.push(`${t.name}: no test`); continue; }
    const entry = core.registry.apps.get(app);
    const file = entry && !entry.builtin ? path.join(entry.dir, t.test) : path.resolve(t.test);
    if (!fs.existsSync(file)) { problems.push(`${t.name}: test file ${t.test} is missing`); continue; }
    if (!testText.has(file)) testText.set(file, fs.readFileSync(file, 'utf8'));
    // Mounted apps are tested as a whole (every tool runs through one route); everything else is named in its test.
    const mounted = !!entry?.manifest.mount;
    if (!mounted && !testText.get(file)!.includes(t.name)) problems.push(`${t.name}: not named in ${t.test}`);
  }
  assert.deepEqual(problems, []);

  const s = await serveCore(core);
  const token = await tokenFor(core, sam.user.id, sam.team.id);
  const r = await fetch(`${s.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  const listed = new Set(((await r.json()) as any).result.tools.map((t: any) => t.name));
  const missing = tools.filter((t) => !listed.has(toWire(t.name))).map((t) => t.name);
  assert.ok([...listed].every((n: any) => /^[a-zA-Z0-9_-]{1,64}$/.test(n)), 'every MCP name is valid for the Anthropic and OpenAI APIs');
  assert.deepEqual(missing, [], 'every tool is reachable over MCP');
  const open = await (await fetch(`${s.url}/api/openapi.json`, { headers: { authorization: `Bearer ${token}` } })).json() as any;
  assert.equal(Object.keys(open.paths).length, tools.length, 'and over REST');
  await s.close();
  await core.stop();
});
