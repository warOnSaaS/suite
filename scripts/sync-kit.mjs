// Copies the warOnSaaS UI kit (ui-design) into apps/shell/public/ui. The shell and the server's own pages load
// it from /ui/. Never edit public/ui by hand: what the kit lacks goes into the kit, or meanwhile into
// apps/shell/src/wos.css in the kit's style, listed in docs/KIT-GAPS.md.
// Usage: node scripts/sync-kit.mjs [path-to-ui-design]   (default ../waronsaas-ui-design)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const kit = path.resolve(process.argv[2] ?? path.join('..', 'waronsaas-ui-design'));
const out = path.resolve('apps', 'shell', 'public', 'ui');
const files = ['src/ui.css', 'src/tokens.css', 'src/ui.mjs', 'src/noscript.css', 'themes/ops.css', 'themes/midnight.css', 'NOTICE', 'LICENSE',
  ...fs.readdirSync(path.join(kit, 'fonts')).map((f) => `fonts/${f}`)];
fs.rmSync(out, { recursive: true, force: true });
let bytes = 0;
for (const f of files) {
  const from = path.join(kit, f);
  if (!fs.existsSync(from)) continue;
  const to = path.join(out, f);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  bytes += fs.statSync(to).size;
}
let rev = 'unknown';
try { rev = execFileSync('git', ['-C', kit, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
fs.writeFileSync(path.join(out, 'SYNCED.txt'), `Copied from warOnSaaS/ui-design at ${rev} by scripts/sync-kit.mjs. Do not edit.\n`);
console.log(`synced ui-design ${rev} (${bytes} bytes) into apps/shell/public/ui`);
