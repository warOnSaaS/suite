// The parity harness (ROADMAP 3.2). Opens every screen of every enabled app in a real browser and checks that
// every button, menu item, switch and form names a tool (data-tool) that is in the catalogue, or says it only
// moves around the screen (data-tool="none" with data-why). Then turns apps off and checks that the browser
// never downloads anything of theirs. Writes docs/PARITY-REPORT.md and fails the build on a gap in any app that
// is on: the shell, Agents, and every app package loaded (the CRM, the board, Chat, Email from vendor/ or
// PARITY_APPS). An app still shown in a frame (mounted pages) is enforced too.
//   node scripts/vendor.mjs && npm run build && npm run test:parity
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-parity-'));
const port = 8700 + Math.floor(Math.random() * 200);
// The real app packages when they are vendored (node scripts/vendor.mjs), otherwise the example app.
const vendored = ['chat', 'email', 'agent-kanban', 'crm', 'meet'].map((d) => path.join(root, 'vendor', d)).filter((d) => fs.existsSync(path.join(d, 'wos-app.json')));
const parityApps = process.env.PARITY_APPS || (vendored.length ? vendored.join(',') : path.join(root, 'packages/manifest/example'));
Object.assign(process.env, { WOS_DEMO: '1', WOS_DATA_DIR: dataDir, WOS_APPS: parityApps, PORT: String(port), PUBLIC_URL: `http://localhost:${port}`, WOS_DEMO_PACE_MS: '300', WOS_SECRET_KEY: 'parity' });
if (!fs.existsSync(path.join(root, 'dist/shell/index.html'))) { console.error('Build the shell first: npm run build'); process.exit(2); }
const { serve } = await import('../apps/server/main.ts');
const { core } = await serve(port);
const base = `http://localhost:${port}`;
const catalogue = { has: (n) => core.catalogue.tools.has(n), get size() { return core.catalogue.tools.size; }, [Symbol.iterator]: () => core.catalogue.tools.keys() };

const browser = await chromium.launch({ args: ['--mute-audio'] }); // never play sound out of the speakers
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
const notes = [];
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
  if (path) { await page.goto(base + path); await page.waitForTimeout(app === 'agents' ? 2500 : app === 'shell' ? 900 : 1500); }
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
// Every screen of every app package, not only its first one. Record pages are found by following the
// first matching link on a list screen.
const SUBSCREENS = {
  chat: { lists: ['/', '/browse', '/activity', '/search', '/settings'], records: [['/', /\/c\/[^/]+$/]] },
  email: { lists: ['/', '/inbox/fyi', '/drafts', '/approvals', '/settings'], records: [['/', /\/t\/[^/]+$/, 'optional: a demo team has no mailbox until one is connected']] },
  crm: { lists: ['/contacts', '/leads', '/organizations', '/pipeline', '/deals', '/activities', '/import', '/settings', '/deleted', '/duplicates'], records: [['/contacts', /\/a\/crm\/contacts\/c_/], ['/organizations', /\/a\/crm\/organizations\/o_/], ['/deals', /\/a\/crm\/deals\/d_/]] },
  meet: { lists: ['/'], records: [['/', /\/a\/meet\/m\/[^/]+$/]], before: async () => { await tool('meet.create', { title: 'Parity check' }).catch(() => {}); } },
  board: { lists: ['/', '/alerts', '/settings'], records: [['/', /\/a\/board\/(.*\/)?(t|task|tasks)\/[^/]+$/], ['/', /\/a\/board\/(.*\/)?(i|idea|ideas)\/[^/]+$/]] },
};
const linkOn = async (path, re) => {
  await page.goto(base + path);
  await page.waitForTimeout(1500);
  const hrefs = await page.evaluate(() => [...document.querySelectorAll('.wos-app-root a[href]')].map((a) => a.getAttribute('href')));
  // Hash links (#/c/x) and app-relative links (/t/x) are addresses inside the app.
  const app = path.split('/')[2];
  const h = hrefs.find((x) => re.test(x));
  if (!h) return null;
  if (h.startsWith('#')) return `/a/${app}${h.slice(1)}`;
  return h.startsWith(`/a/${app}`) ? h : `/a/${app}${h}`;
};
for (const [id, a] of core.registry.apps) {
  if (a.builtin || !a.manifest.screens) continue;
  await tool('apps.enable', { app: id }).catch(() => {});
  const label = `${a.manifest.name}${a.dir.endsWith('packages/manifest/example') ? ' (example app)' : ''}`;
  const plan = SUBSCREENS[id] ?? { lists: ['/'], records: [] };
  await plan.before?.();
  for (const sub of plan.lists) await scan(id, `${label} ${sub}`, `/a/${id}${sub === '/' ? '' : sub}`);
  for (const [list, re, optional] of plan.records) {
    const href = await linkOn(`/a/${id}${list === '/' ? '' : list}`, re);
    if (href) await scan(id, `${label} ${href.replace(`/a/${id}`, '')}`, href);
    else if (optional) notes.push(`${id}: no record to open from ${list} (${optional.replace(/^optional: /, '')}).`);
    else results.push({ app: id, screen: `${label} record from ${list}`, tag: 'screen', text: `no record link matching ${re} on ${list}`, tool: null, verdict: 'no-record', mounted: false, external: true });
  }
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

// Off means never downloaded: turn every app that is not part of wOS off, walk every screen, watch the network.
const offApps = [...core.registry.apps.values()].filter((a) => !a.manifest.core).map((a) => a.manifest.id);
for (const id of offApps) await tool('apps.disable', { app: id }).catch(() => {});
requests.length = 0;
for (const p of ['/', '/inbox', '/agents', '/settings/apps', '/settings/models', ...offApps.map((id) => `/a/${id}`)]) { await page.goto(base + p); await page.waitForTimeout(700); }
const offLeaks = requests.filter((r) => offApps.some((id) => r.startsWith(`/apps/${id}/`) || r.startsWith(`/m/${id}/`) || r === `/m/${id}`));
// And the Agents screens are their own file, not fetched on the home screen.
requests.length = 0;
await page.goto(base + '/');
await page.waitForTimeout(800);
const agentsChunkOnHome = requests.filter((r) => /\/assets\/(index-[^/]+|screens-[^/]+)\.js$/.test(r) && r.includes('screens'));

await browser.close();
await core.stop();

// ---------- report ----------
const suite = results; // every app that is on is enforced, wherever its code lives
const gaps = suite.filter((r) => ['missing', 'unknown-tool', 'none-without-why', 'no-record'].includes(r.verdict));
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
  ...Object.values(byApp).map((a) => `| ${a.app} | ${a.actions} | ${a.tools} | ${a.gaps} | ${a.moves} | yes${a.mounted ? ' (mounted pages)' : a.external ? ' (app package)' : ''} |`),
  '',
  '## Tools with no screen (allowed: agents and programs use them)',
  '',
  ...Object.entries([...catalogue].reduce((m, n) => { const used = Object.values(byApp).some((a) => a.used.has(n)); if (!used) (m[appOf(n)] ??= []).push(n); return m; }, {})).map(([app, names]) => `- **${app}**: ${names.map((n) => `\`${n}\``).join(', ')}`),
  '',
  '## Gaps (these fail the build)',
  '',
  ...(gaps.length ? gaps.map((g) => `- ${g.app}, ${g.screen}: ${g.tag} "${g.text}" (${g.verdict}${g.tool ? `: ${g.tool}` : ''})`) : ['None.']),
  '',
  '## Screens walked',
  '',
  ...Object.entries(results.reduce((m, r) => { const k = `${r.app}: ${r.screen}`; (m[k] ??= { a: 0, mv: 0 }); if (r.verdict === 'moves') m[k].mv++; else m[k].a++; return m; }, {})).map(([k, v]) => `- ${k}: ${v.a} actions, ${v.mv} moves`),
  '',
  ...(notes.length ? ['## Not walked', '', ...notes.map((n) => `- ${n}`), ''] : []),
  '## Where each app comes from',
  '',
  ...[...core.registry.apps.values()].filter((a) => a.server).map((a) => `- **${a.manifest.id}** ${a.manifest.version}: ${a.builtin ? 'built into wOS' : path.relative(root, a.dir) || a.dir}${a.manifest.screens ? ', native screens' : a.manifest.mount ? ', its own pages in a frame' : ''}`),
  '',
  '## Off means not downloaded',
  '',
  offLeaks.length ? `FAILED: requests for apps that were off: ${offLeaks.join(', ')}` : `With every app turned off (${offApps.join(', ')}), walking every screen requested nothing of theirs: no \`/apps/<id>/screens.js\`, nothing under \`/m/<id>/\`.`,
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
