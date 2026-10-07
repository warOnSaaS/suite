#!/usr/bin/env node
// Check an app folder: npx wos-check-app path/to/app   (reads wos-app.json and the tools.json it points at)
import fs from 'node:fs';
import path from 'node:path';
import { checkManifest } from '../index.mjs';
import { checkCatalogue } from '../../tools/index.mjs';

const dir = path.resolve(process.argv[2] ?? '.');
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let m;
try { m = read('wos-app.json'); } catch (e) { console.error(`Cannot read ${dir}/wos-app.json: ${e.message}`); process.exit(2); }
const problems = checkManifest(m).map((p) => `wos-app.json: ${p}`);
if (typeof m.tools === 'string') {
  try {
    const cat = read(m.tools);
    problems.push(...checkCatalogue(cat).map((p) => `${m.tools}: ${p}`));
    if (cat.app !== m.id) problems.push(`${m.tools}: "app" is "${cat.app}" but the manifest id is "${m.id}".`);
  } catch (e) { problems.push(`${m.tools}: cannot read (${e.message}).`); }
}
for (const k of ['tables', 'server', 'screens']) if (m[k] && !fs.existsSync(path.join(dir, m[k]))) problems.push(`wos-app.json: "${k}" points at ${m[k]}, which does not exist.`);
if (problems.length) { console.error(`${problems.length} problem(s)\n- ${problems.join('\n- ')}`); process.exit(1); }
console.log(`${m.id} ${m.version}: manifest and tools are fine.`);
