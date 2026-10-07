// Copies the committed files of other apps into vendor/ (git-ignored) so a deploy can load them:
// the CRM and the board (mounted), and app packages such as Chat and Email (loaded through WOS_APPS).
// Usage: node scripts/vendor.mjs   (sibling checkouts ../crm, ../agent-kanban, ../wos-chat, ../wos-email, ../wos-meet)
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
for (const [name, from] of [['crm', '../crm'], ['agent-kanban', '../agent-kanban'], ['chat', '../wos-chat'], ['email', '../wos-email'], ['meet', '../wos-meet']]) {
  const src = path.resolve(root, from);
  if (!fs.existsSync(path.join(src, '.git'))) { console.log(`${name}: no checkout at ${src}, skipped`); continue; }
  const out = path.join(root, 'vendor', name);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  execSync(`git -C "${src}" archive HEAD | tar -x -C "${out}"`);
  const rev = execSync(`git -C "${src}" rev-parse --short HEAD`, { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(out, 'VENDORED.txt'), `Copied from ${name} at ${rev} by scripts/vendor.mjs.\n`);
  console.log(`${name}: ${rev} into vendor/${name}`);
}
