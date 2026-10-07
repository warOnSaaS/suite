// Writes apps-builtin/<crm|board>/tools.json from the installed packages, so the catalogue of mounted apps is
// documented in this repo. Run after updating either package: npm run gen:mounts
import fs from 'node:fs';
import path from 'node:path';
import { findApp, toolsFrom } from '../core/mount.ts';
import { checkCatalogue } from '../packages/tools/index.mjs';

const apps = [
  { id: 'crm', names: ['crm'], marker: 'lib/http.mjs', env: process.env.WOS_CRM_DIR, def: 'lib/tools.mjs', session: { me: { id: 'you', name: 'the person signed in', role: 'owner' }, crm: { name: 'CRM' } } },
  { id: 'board', names: ['agent-kanban'], marker: 'lib/routes.mjs', env: process.env.WOS_BOARD_DIR, def: 'lib/mcp.mjs', session: { me: { id: 'you', name: 'the person signed in', role: 'owner' }, isOwner: true } },
];
for (const a of apps) {
  const dir = findApp(a.env, a.names, a.marker);
  if (!dir) { console.log(`${a.id}: package not found, skipped`); continue; }
  const tools = await toolsFrom(dir, a.id, a.def, a.session);
  const doc = { $schema: 'https://raw.githubusercontent.com/warOnSaaS/suite/main/packages/tools/tools.schema.json', app: a.id, version: 1, tools };
  const problems = checkCatalogue(doc);
  if (problems.length) { console.error(`${a.id}: ${problems.join('\n')}`); process.exitCode = 1; }
  fs.writeFileSync(path.resolve('apps-builtin', a.id, 'tools.json'), JSON.stringify(doc, null, 2) + '\n');
  console.log(`${a.id}: ${tools.length} tools from ${dir}`);
}
