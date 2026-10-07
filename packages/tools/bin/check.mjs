#!/usr/bin/env node
// Check a tools.json: npx wos-check-tools path/to/tools.json
import fs from 'node:fs';
import { checkCatalogue } from '../index.mjs';

const file = process.argv[2] ?? 'tools.json';
let doc;
try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error(`Cannot read ${file}: ${e.message}`); process.exit(2); }
const problems = checkCatalogue(doc);
if (problems.length) { console.error(`${file}: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`); process.exit(1); }
console.log(`${file}: ${doc.tools.length} tools, all fine.`);
