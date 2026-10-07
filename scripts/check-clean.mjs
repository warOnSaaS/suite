// Fails when a tracked file holds a private name (from the git-ignored .names and instances/*.names),
// an em dash, or something that looks like a secret. Run before every commit: npm run check:clean
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const names = [];
for (const f of ['.names', ...(fs.existsSync(path.join(root, 'instances')) ? fs.readdirSync(path.join(root, 'instances')).filter((x) => x.endsWith('.names')).map((x) => `instances/${x}`) : [])]) {
  try { names.push(...fs.readFileSync(path.join(root, f), 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))); } catch {}
}
const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
const SECRET = [/sk-ant-[A-Za-z0-9_-]{20,}/, /sk-(proj-)?[A-Za-z0-9]{32,}/, /gh[opsu]_[A-Za-z0-9]{30,}/, /github_pat_[A-Za-z0-9_]{30,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /xox[bap]-[A-Za-z0-9-]{20,}/];
const BIN = /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf|pdf|zip|sqlite)$/i;
const problems = [];
for (const f of files) {
  if (BIN.test(f) || f === 'package-lock.json') continue;
  let text;
  try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
  const lower = text.toLowerCase();
  for (const n of names) if (lower.includes(n.toLowerCase())) problems.push(`${f}: private name "${n}"`);
  if (text.includes('\u2014')) problems.push(`${f}: em dash`);
  for (const re of SECRET) if (re.test(text)) problems.push(`${f}: looks like a secret (${re.source.slice(0, 18)}...)`);
}
if (problems.length) { console.error(`check:clean found ${problems.length} problem(s):\n- ${problems.join('\n- ')}`); process.exit(1); }
console.log(`check:clean: ${files.length} files, no private names, em dashes or secrets.`);
