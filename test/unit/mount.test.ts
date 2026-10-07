// The CRM and the board, mounted as they are: every crm.* and board.* tool from their packages is in the
// catalogue and runs through their own REST route; their pages are served under /m/<id>/ and may sit in a frame.
// Skipped when the packages are not installed (set WOS_CRM_DIR and WOS_BOARD_DIR, or keep sibling checkouts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCore, person, serveCore, tokenFor } from './helpers.ts';
import { findApp } from '../../core/mount.ts';

const crmDir = findApp(process.env.WOS_CRM_DIR, ['crm'], 'lib/http.mjs');
const boardDir = findApp(process.env.WOS_BOARD_DIR, ['agent-kanban'], 'lib/routes.mjs');

test('crm.* tools come from the CRM package and run', { skip: !crmDir && 'CRM package not installed' }, async () => {
  const core = await makeCore();
  const sam = await person(core);
  await sam.call('apps.enable', { app: 'crm' });
  const crm = [...core.catalogue.tools.values()].filter((t) => t.app === 'crm');
  assert.ok(crm.length >= 10);
  for (const t of crm) assert.match(t.name, /^crm\.[a-z0-9_]+$/);
  const found = await sam.call('crm.find', { q: 'birch' });
  assert.match(found.result, /Birch Law/);
  const s = await serveCore(core);
  const auth = { authorization: `Bearer ${await tokenFor(core, sam.user.id, sam.team.id)}` };
  const page = await fetch(`${s.url}/m/crm/`, { headers: auth });
  assert.equal(page.status, 200);
  assert.notEqual(page.headers.get('x-frame-options'), 'DENY');
  const html = await page.text();
  assert.match(html, /href="\/m\/crm\/contacts"/, 'links rewritten under the mount');
  assert.doesNotMatch(html, /href="\/contacts"/);
  const css = await fetch(`${s.url}/m/crm/ui/src/ui.css`, { headers: auth });
  assert.equal(css.status, 200);
  await sam.call('apps.disable', { app: 'crm' });
  assert.match(await (await fetch(`${s.url}/m/crm/`, { headers: auth })).text(), /is off/);
  await s.close();
  await core.stop();
});

test('board.* tools come from the board package and run', { skip: !boardDir && 'board package not installed' }, async () => {
  const core = await makeCore();
  const sam = await person(core);
  await sam.call('apps.enable', { app: 'board' });
  const board = [...core.catalogue.tools.values()].filter((t) => t.app === 'board');
  assert.ok(board.length >= 10);
  const day = await sam.call('board.my_day', {});
  assert.ok(typeof day.result === 'string' && day.result.length > 10);
  const s = await serveCore(core);
  const page = await fetch(`${s.url}/m/board/board`, { headers: { authorization: `Bearer ${await tokenFor(core, sam.user.id, sam.team.id)}` } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /\/m\/board\//);
  await s.close();
  await core.stop();
});
