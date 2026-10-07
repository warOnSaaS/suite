// Screenshots of every screen at 1440 and 390, light and dark, into .shots/ (git-ignored).
// Needs a running demo server: WOS_DEMO=1 npm start, then: node scripts/shots.mjs http://localhost:8080
import fs from 'node:fs';
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:8080';
const only = process.argv[3];
fs.mkdirSync('.shots', { recursive: true });
const browser = await chromium.launch();
const pages = [
  ['signin', '/auth/sign-in', false],
  ['home', '/', true],
  ['agents', '/agents', true],
  ['inbox', '/inbox', true],
  ['settings-apps', '/settings/apps', true],
  ['settings-models', '/settings/models', true],
  ['settings-team', '/settings/team', true],
  ['settings-alerts', '/settings/alerts', true],
  ['settings-account', '/settings/account', true],
  ['settings-hosting', '/settings/hosting', true],
  ['crm', '/a/crm', true],
  ['board', '/a/board', true],
];
for (const scheme of ['light', 'dark']) {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: w < 500 ? 2 : 1 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`page error (${w} ${scheme}): ${e.message}`));
    await page.goto(`${base}/auth/demo?next=/`);
    await page.waitForTimeout(800);
    for (const [name, path, signed] of pages) {
      if (only && !name.startsWith(only)) continue;
      if (!signed) {
        const p2 = await (await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme })).newPage();
        await p2.goto(base + path);
        await p2.screenshot({ path: `.shots/${name}-${w}-${scheme}.png` });
        continue;
      }
      await page.goto(base + path);
      await page.waitForTimeout(name === 'agents' ? 4500 : name === 'crm' || name === 'board' ? 2500 : 1200);
      await page.screenshot({ path: `.shots/${name}-${w}-${scheme}.png`, fullPage: false });
    }
    await ctx.close();
  }
}
await browser.close();
console.log('saved to .shots/');
