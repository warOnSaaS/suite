// The parity harness (ROADMAP 3.2). Opens every screen of every enabled app in a real browser and checks that
// every button, menu item, switch and form names a tool (data-tool) that is in the catalogue, or says it only
// moves around the screen (data-tool="none" with data-why). Then turns apps off and checks that the browser
// never downloads anything of theirs. Writes docs/PARITY-REPORT.md and fails the build on a gap in wOS's own
// screens. Mounted apps (the CRM and board pages in frames) are measured and reported, not enforced, until their
// native screens replace the frames (ROADMAP step 7).
//   npm run build && npm run test:parity
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-parity-'));
const port = 8700 + Math.floor(Math.random() * 200);
Object.assign(process.env, { WOS_DEMO: '1', WOS_DATA_DIR: dataDir, WOS_APPS: process.env.PARITY_APPS || path.join(root, 'packages/manifest/example'), PORT: String(port), PUBLIC_URL: `http://localhost:${port}`, WOS_DEMO_PACE_MS: '300', WOS_SECRET_KEY: 'parity' });
if (!fs.existsSync(path.join(root, 'dist/shell/index.html'))) { console.error('Build the shell first: npm run build'); process.exit(2); }
const { serve } = await import('../apps/server/main.ts');
const { core } = await serve(port);
const base = `http://localhost:${port}`;
const catalogue = { has: (n) => core.catalogue.tools.has(n), get size() { return core.catalogue.tools.size; }, [Symbol.iterator]: () => core.catalogue.tools.keys() };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const requests = [];
page.on('request', (r) => requests.push(new URL(r.url()).pathname));
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}/auth/demo?next=/`);
await page.waitForLoadState('networkidle');
const tool = (name, input = {}) => page.evaluate(async ([n, i]) => {
  const r = await fetch(`/api/tools/${n}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wos': '1' }, body: JSON.stringify(i) });
  return (await r.json()).result;
}, [name, input]);
await tool('apps.enable', { app: 'chat' });
// Inside the browser: every interactive element, and whether it names a tool.
const SCAN = () => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const out = [];
  const sel = 'button, [role=button], [role=option], [role=tab], [role=switch], a[href], input[type=checkbox], input[type=radio], select, summary, form';
  for (const el of document.querySelectorAll(sel)) {
    if (el.tagName !== 'FORM' && !visible(el)) continue;
    const inForm = el.closest('form');
    const tag = el.tagName.toLowerCase();
    // Fields inside a form are covered by the form's submit button.
    if (inForm && ['input', 'select'].includes(tag) && !el.hasAttribute('data-tool')) continue;
    let t = el.getAttribute('data-tool');
    if (tag === 'form') {
      // A form acts through its submit button.
      const sub = el.querySelector('[type=submit][data-tool], button:not([type=button])[data-tool]') ?? [...el.querySelectorAll('[data-tool]')].find((x) => x.getAttribute('data-tool') !== 'none');
      t = el.getAttribute('data-tool') ?? sub?.getAttribute('data-tool') ?? null;
      // Plain server forms post to a route; record the route so mounted apps can be mapped.
      if (!t && el.getAttribute('action')) t = `route:${el.getAttribute('action')}`;
    }
    const why = tag === 'summary' && !t ? 'opens details' : el.getAttribute('data-why');
    if (tag === 'summary' && !t) t = 'none';
    out.push({ tag, text: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 50), tool: t, why, href: el.getAttribute('href') });
  }
  return out;
};

const results = []; // { app, screen, el, verdict }
function judge(app, screen, items, { mounted = false } = {}) {
  // Apps from other repos are measured and reported here; their own builds enforce them.
  const info = core.registry.apps.get(app);
  const external = !!info && !info.builtin && !info.dir.endsWith('packages/manifest/example');
  for (const el of items) {
    let verdict;
    if (el.tool === 'none') verdict = el.why ? 'moves' : 'none-without-why';
    else if (el.tool && catalogue.has(el.tool)) verdict = 'tool';
    else if (mounted && el.tool && catalogue.has(`${app}.${el.tool.replace(/^route:.*\/v1\//, '')}`)) verdict = 'tool';
    // A link to a real address only moves around; a link used as a button (#, javascript:) must name a tool.
    else if (el.tag === 'a' && el.href && !/^(#|javascript:)/.test(el.href)) verdict = 'moves';
    else if (el.tool) verdict = 'unknown-tool';
    else verdict = 'missing';
    results.push({ app, screen, mounted, external, ...el, verdict });
  }
}

async function scan(app, screen, path, opener) {
  if (path) { await page.goto(base + path); await page.waitForTimeout(app === 'agents' ? 2500 : 900); }
  if (opener) { await opener(); await page.waitForTimeout(400); }
  judge(app, screen, await page.evaluate(SCAN));
}

// A conversation and a run to look at.
const conv = await tool('conversations.send', { text: 'show the open deals in the CRM' });
const runs = await tool('agents.runs', { limit: 1 });

await scan('shell', 'Home', '/');
await scan('shell', 'Home: model menu', null, () => page.click('.wos-picker-btn'));
await scan('shell', 'Conversation', `/c/${conv.conversation_id}`);
await scan('shell', 'Inbox', '/inbox');
for (const t of ['apps', 'models', 'team', 'alerts', 'account', 'hosting']) await scan('shell', `Settings: ${t}`, `/settings/${t}`);
await scan('shell', 'Settings: uninstall dialog', '/settings/apps', () => page.click('[data-tool="apps.uninstall"] >> nth=0'));
await scan('agents', 'Agents grid', '/agents');
await scan('agents', 'New agent dialog', null, () => page.click('.ui-ph [data-tool="agents.create"]'));
await page.keyboard.press('Escape');
await scan('agents', 'Start dialog', null, () => page.click('.ui-ph [data-tool="agents.start"]'));
await page.keyboard.press('Escape');
if (runs.runs[0]) await scan('agents', 'Run focus', `/agents/run/${runs.runs[0].id}`);
for (const [id, a] of core.registry.apps) {
  if (a.builtin || !a.manifest.screens) continue;
  await tool('apps.enable', { app: id }).catch(() => {});
  await scan(id, `${a.manifest.name}${a.dir.endsWith('packages/manifest/example') ? ' (example app)' : ''}`, `/a/${id}`);
}

// Mounted apps: look inside their frames.
for (const [app, sub] of [['crm', '/a/crm'], ['board', '/a/board']]) {
  const info = core.registry.apps.get(app);
  if (!info?.server || info.unavailable) continue;
  await page.goto(base + sub);
  await page.waitForTimeout(1500);
  const frame = page.frames().find((f) => f.url().includes(`/m/${app}/`));
  if (frame) judge(app, `${info.manifest.name} (mounted)`, await frame.evaluate(SCAN), { mounted: true });
}

// Off means never downloaded: turn the example app and the CRM off, walk every screen, watch the network.
await tool('apps.disable', { app: 'chat' });
await tool('apps.disable', { app: 'crm' });
requests.length = 0;
for (const p of ['/', '/inbox', '/agents', '/settings/apps', '/settings/models', '/a/chat', '/a/crm']) { await page.goto(base + p); await page.waitForTimeout(700); }
const offLeaks = requests.filter((r) => r.startsWith('/apps/chat/') || r.startsWith('/m/crm'));
// And the Agents screens are their own file, not fetched on the home screen.
requests.length = 0;
await page.goto(base + '/');
await page.waitForTimeout(800);
const agentsChunkOnHome = requests.filter((r) => /\/assets\/(index-[^/]+|screens-[^/]+)\.js$/.test(r) && r.includes('screens'));

await browser.close();
await core.stop();

// ---------- report ----------
const suite = results.filter((r) => !r.mounted && !r.external);
const gaps = suite.filter((r) => ['missing', 'unknown-tool', 'none-without-why'].includes(r.verdict));
const byApp = {};
for (const r of results) {
  const a = (byApp[r.app] ??= { app: r.app, mounted: r.mounted, external: r.external, actions: 0, tools: 0, moves: 0, gaps: 0, used: new Set() });
  if (r.verdict === 'moves') a.moves++;
  else { a.actions++; if (r.verdict === 'tool') { a.tools++; a.used.add(r.tool.startsWith('route:') ? r.tool : r.tool); } else a.gaps++; }
}
const appOf = (name) => name.split('.')[0];
const lines = [
  '# Parity report',
  '',
  `Generated by \`npm run test:parity\` on ${new Date().toISOString().slice(0, 10)}. Every button, menu item, switch and form on every screen, checked in a real browser against the tool catalogue (${catalogue.size} tools).`,
  '',
  '| App | Screen actions | Covered by a tool | Gaps | Moves only (links, tabs, dialogs) | Enforced |',
  '|---|---|---|---|---|---|',
  ...Object.values(byApp).map((a) => `| ${a.app} | ${a.actions} | ${a.tools} | ${a.gaps} | ${a.moves} | ${a.mounted ? 'no (mounted pages, measured only)' : a.external ? 'in its own repo (reported here)' : 'yes'} |`),
  '',
  '## Tools with no screen (allowed: agents and programs use them)',
  '',
  ...Object.entries([...catalogue].reduce((m, n) => { const used = Object.values(byApp).some((a) => a.used.has(n)); if (!used) (m[appOf(n)] ??= []).push(n); return m; }, {})).map(([app, names]) => `- **${app}**: ${names.map((n) => `\`${n}\``).join(', ')}`),
  '',
  '## Gaps in wOS screens (these fail the build)',
  '',
  ...(gaps.length ? gaps.map((g) => `- ${g.screen}: ${g.tag} "${g.text}" (${g.verdict}${g.tool ? `: ${g.tool}` : ''})`) : ['None.']),
  '',
  '## Apps from other repos: gaps to fix in those repos',
  '',
  ...((g) => (g.length ? g.map((x) => `- ${x.app}, ${x.screen}: ${x.tag} "${x.text}" (${x.verdict}${x.tool ? `: ${x.tool}` : ''})`) : ['None.']))(results.filter((r) => r.external && ['missing', 'unknown-tool', 'none-without-why'].includes(r.verdict))),
  '',
  '## Mounted apps: actions not yet mapped to a tool',
  '',
  'The CRM and board pages call their own `/v1/<tool>` routes from scripts, which are the same handlers as `crm.*` and `board.*`. Elements below carry no `data-tool` yet, so the harness cannot prove which tool each one calls. They close when the native screens replace the frames, or when those apps add `data-tool` to their pages.',
  '',
  ...results.filter((r) => r.mounted && r.verdict !== 'tool' && r.verdict !== 'moves').slice(0, 80).map((g) => `- ${g.app}: ${g.tag} "${g.text}"`),
  '',
  '## Off means not downloaded',
  '',
  offLeaks.length ? `FAILED: requests for apps that were off: ${offLeaks.join(', ')}` : 'With Chat (the example app) and the CRM turned off, walking every screen requested nothing of theirs: no `/apps/chat/screens.js`, nothing under `/m/crm/`.',
  agentsChunkOnHome.length ? `FAILED: the home screen downloaded the Agents screens (${agentsChunkOnHome.join(', ')}).` : 'The home screen does not download the Agents screens; they are a separate file fetched when Agents is opened.',
  '',
  errors.length ? `## Page errors\n\n${errors.map((e) => `- ${e}`).join('\n')}` : '',
];
fs.writeFileSync(path.join(root, 'docs/PARITY-REPORT.md'), lines.join('\n').replace(/\u2014/g, ',') + '\n');
fs.writeFileSync(path.join(root, 'parity-report.json'), JSON.stringify({ byApp: Object.values(byApp).map((a) => ({ ...a, used: [...a.used] })), gaps, offLeaks, agentsChunkOnHome, errors }, null, 2));
console.log(Object.values(byApp).map((a) => `${a.app}: ${a.tools}/${a.actions} actions covered${a.mounted ? ' (mounted, measured)' : ''}`).join('\n'));
if (gaps.length || offLeaks.length || agentsChunkOnHome.length || errors.length) {
  console.error(`parity FAILED: ${gaps.length} gap(s), ${offLeaks.length} off-app download(s), ${errors.length} page error(s). See docs/PARITY-REPORT.md`);
  process.exit(1);
}
console.log('parity passed. Report: docs/PARITY-REPORT.md');
process.exit(0);
