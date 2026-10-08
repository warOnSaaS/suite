// The full walkthrough, recorded: sign in to the demo, turn apps off and on (and prove an app that is off is
// never downloaded), run one conversation that works across the CRM and Chat, run two agents on one board
// task, answer an alert from the inbox, check that everything is still there after a reload and in a second
// browser, and (when Meetings is installed) start a call from Chat and join it from the second browser.
//   node scripts/walkthrough.mjs https://app.waronsaas.com     videos and a log in .shots/walkthrough/
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';

const base = (process.argv[2] ?? 'https://app.waronsaas.com').replace(/\/$/, '');
const root = path.resolve(new URL('..', import.meta.url).pathname);
const out = path.join(root, '.shots', 'walkthrough');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'raw'), { recursive: true });
const log = [];
const results = [];
const note = (s) => { log.push(`${new Date().toISOString().slice(11, 19)} ${s}`); console.log(s); };
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); note(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

const browser = await chromium.launch({ args: ['--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const size = { width: 1280, height: 800 };
const ctxA = await browser.newContext({ viewport: size, recordVideo: { dir: path.join(out, 'raw'), size }, permissions: ['camera', 'microphone'] });
const page = await ctxA.newPage();
const videos = [page.video(), null];
// The film cuts between browsers: each segment is a stretch of one browser's recording, in seconds from
// when that browser opened. show(i) ends the current stretch and starts one on browser i.
const opened = [Date.now()];
const segs = [];
let cur = { v: 0, from: 0 };
const show = (i) => { const t = (v) => (Date.now() - opened[v]) / 1000; segs.push({ ...cur, to: t(cur.v) }); cur = { v: i, from: t(i) }; };
const requests = [];
page.on('request', (r) => requests.push(new URL(r.url()).pathname));
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const pause = (ms) => page.waitForTimeout(ms);
// A caption at the bottom of the frame, so the video explains itself.
async function caption(p, text) {
  await p.evaluate((t) => {
    let el = document.getElementById('wt-caption');
    if (!el) {
      el = document.createElement('div');
      el.id = 'wt-caption';
      el.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483647;max-width:min(860px,92vw);padding:10px 16px;border-radius:10px;background:rgba(17,17,19,.92);color:#fafafa;font:500 15px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25);pointer-events:none';
      document.body.append(el);
    }
    el.textContent = t;
  }, text).catch(() => {});
}
const say = async (text, ms = 1600) => { note(`> ${text}`); await caption(page, text); await pause(ms); };
const tool = (p, n, i = {}) => p.evaluate(async ([n, i]) => {
  const r = await fetch(`/api/tools/${n}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-wos': '1' }, body: JSON.stringify(i) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}, [n, i]);
const go = async (p, to, wait = 1800) => { await p.goto(base + to); await p.waitForLoadState('domcontentloaded'); await p.waitForTimeout(wait); };

try {
  // 1. Sign in to the demo
  await go(page, '/', 1200);
  await say('wOS: sign in to the demo');
  await page.getByRole('link', { name: 'Try the demo' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 30000 });
  await pause(2500);
  const me = (await tool(page, 'account.me')).body.result;
  check('signed in to the demo', !!me?.user?.id, `${me?.user?.name} on ${me?.team?.name ?? me?.teams?.[0]?.name ?? ''}`);
  await say('A private sandbox: the conversation home, and the apps in the left rail');

  // 2. Apps off and on; an app that is off is never downloaded
  await go(page, '/settings/apps');
  await say('Settings, Apps: turn Email off');
  const emailSwitch = page.locator('input[role=switch][aria-label^="Email"]');
  await emailSwitch.click();
  await pause(1800);
  requests.length = 0;
  await say('Email is gone from the left rail. Open every screen and watch the network');
  for (const p of ['/', '/inbox', '/agents', '/a/crm', '/a/chat', '/a/board', '/a/email']) await go(page, p, 1200);
  const leaked = requests.filter((r) => r.startsWith('/apps/email/') || r.startsWith('/m/email'));
  check('an app that is off is never downloaded', leaked.length === 0, leaked.length ? leaked.join(', ') : `${requests.length} requests, none for Email`);
  await say(leaked.length ? 'Email was downloaded while off' : 'Not one request for Email while it was off', 2200);
  const railOff = await page.locator('nav').getByText('Email', { exact: true }).count();
  check('an app that is off leaves the left rail', railOff === 0);
  await go(page, '/settings/apps');
  await say('Turn Email back on');
  await page.locator('input[role=switch][aria-label^="Email"]').click();
  await pause(1800);
  requests.length = 0;
  await go(page, '/a/email', 3000);
  check('turned back on, Email loads its screens', requests.some((r) => r === '/apps/email/screens.js'));
  await say('Back on: Email downloads its screens only now');

  // 3. One conversation across the CRM and Chat
  await go(page, '/');
  await say('Ask the conversation to work across two apps');
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.click();
  await box.pressSequentially('create a contact for Dana at Acme Dental and post in #general that I did', { delay: 18 });
  await pause(500);
  await box.press('Enter');
  await page.waitForFunction(() => /posted in #general/i.test(document.body.innerText), null, { timeout: 60000 }).catch(() => {});
  await pause(2500);
  await say('Two real tool calls: crm.create_contact, then chat.post_message', 2600);
  const found = (await tool(page, 'crm.find', { q: 'Dana' })).body.result;
  const contactId = /Dana at Acme Dental \((c_[a-z0-9]+)\)/.exec(found?.result ?? '')?.[1] ?? /\b(c_[a-z0-9]+)\)/.exec(found?.result ?? '')?.[1];
  check('the contact is in the CRM', !!contactId, contactId ?? found?.result?.slice(0, 120));
  if (contactId) { await go(page, `/a/crm/contacts/${contactId}`, 2600); await say('The CRM: Dana at Acme Dental, just created', 2400); }
  const msgs = (await tool(page, 'chat.read_messages', { channel: 'general', limit: 5 })).body.result?.messages ?? [];
  check('the post is in #general', msgs.some((m) => /created a contact for Dana/i.test(m.body)), msgs.at(-1)?.body);
  await go(page, '/a/chat', 2500);
  const general = page.locator('a', { hasText: '#general' }).first();
  if (await general.count()) { await general.click(); await pause(2000); } else await go(page, `/a/chat/c/${msgs[0]?.channel ?? ''}`, 2000);
  await say('Chat, #general: the message the conversation posted', 2600);

  // 4. Two agents on one board task
  await go(page, '/agents', 2500);
  await say('Agents: start two agents on the same board task');
  const tasks = (await tool(page, 'board.find_tasks', {})).body.result?.result ?? '';
  const taskTitle = /\*\*(.+?)\*\*/.exec(tasks)?.[1];
  const runIds = [];
  for (const agent of ['Researcher', 'Follow-up writer']) {
    await page.locator('.ui-ph [data-tool="agents.start"]').first().click();
    await pause(900);
    const dlg = page.locator('dialog[open]');
    await dlg.locator('select').first().selectOption({ label: agent });
    const taskSel = dlg.locator('select').nth(1);
    if (taskTitle && (await taskSel.count())) await taskSel.selectOption({ label: taskTitle });
    await pause(700);
    await dlg.locator('button[type=submit]').click();
    await pause(1800);
  }
  const runs = (await tool(page, 'agents.runs', { limit: 10 })).body.result?.runs ?? [];
  const onTask = runs.filter((r) => r.task_ref && taskTitle && r.task_ref.includes(taskTitle));
  check('two agents started on one board task', onTask.length >= 2, `${onTask.length} runs on "${taskTitle}"`);
  runIds.push(...onTask.map((r) => r.id));
  await say(`Both panels work on "${taskTitle}": plan, steps and percent update live`, 1000);
  const pct = async () => (await tool(page, 'agents.runs', { limit: 10 })).body.result?.runs?.filter((r) => runIds.includes(r.id)).map((r) => [r.percent, r.status]) ?? [];
  const first = await pct();
  let later = first;
  let needsYou = false;
  for (let i = 0; i < 40 && !needsYou; i++) { await pause(1500); later = await pct(); needsYou = later.some(([, s]) => s === 'needs_you'); }
  note(`percent before ${JSON.stringify(first)}, after ${JSON.stringify(later)}`);
  check('the panels move forward on their own', JSON.stringify(first) !== JSON.stringify(later), `${JSON.stringify(first)} to ${JSON.stringify(later)}`);
  await say('An agent stopped to ask a question: it waits in the inbox', 2200);

  // 5. Answer an alert from the inbox: the question the waiting agent asked.
  const waiting = (await tool(page, 'agents.runs', { limit: 10 })).body.result?.runs?.find((r) => runIds.includes(r.id) && r.status === 'needs_you');
  await go(page, `/inbox${waiting?.waiting_alert_id ? `?alert=${waiting.waiting_alert_id}` : ''}`, 2500);
  await say('The inbox: answer the agent');
  const answerBtn = page.locator('[data-tool="alerts.answer"]').first();
  const hadAlert = await answerBtn.count();
  if (hadAlert) { await answerBtn.click(); await pause(7000); }
  const alertNow = waiting?.waiting_alert_id ? (await tool(page, 'alerts.list', { status: 'answered' })).body.result?.alerts?.find((a) => a.id === waiting.waiting_alert_id) : null;
  check('the agent\'s alert answered from the inbox', !!alertNow, alertNow ? `"${alertNow.title}" answered ${alertNow.answer ?? ''}` : `waiting run ${waiting?.id ?? 'none'}, alert ${waiting?.waiting_alert_id ?? 'none'}`);
  await go(page, '/agents', 1500);
  await say('Back to the agents: the answer lets that run finish', 1000);
  const before = waiting?.percent ?? 0;
  let mine = null;
  for (let i = 0; i < 30; i++) { await pause(1500); mine = (await tool(page, 'agents.get_run', { run_id: waiting?.id ?? '' })).body.result; if (mine && mine.status !== 'needs_you' && (mine.percent ?? 0) > before) break; }
  check('that run moves on and its percent goes up', !!mine && mine.status !== 'needs_you' && (mine.percent ?? 0) > before, `${before}% to ${mine?.percent}% (${mine?.status})`);
  await pause(2500);

  // 6. State after a reload and in a second browser
  await say('Reload the page: everything is still there');
  await page.reload();
  await pause(2500);
  const afterReload = (await tool(page, 'crm.find', { q: 'Dana' })).body.result?.result ?? '';
  const runsReload = (await tool(page, 'agents.runs', { limit: 10 })).body.result?.runs ?? [];
  check('state persists after a reload', afterReload.includes(contactId ?? 'none') && runIds.every((id) => runsReload.some((r) => r.id === id)));
  await pause(1500);

  // A second browser, signed in as the same person (the demo pass is that person's sign-in).
  const state = await ctxA.storageState();
  const ctxB = await browser.newContext({ viewport: size, recordVideo: { dir: path.join(out, 'raw'), size }, storageState: state, permissions: ['camera', 'microphone'] });
  const pageB = await ctxB.newPage();
  videos[1] = pageB.video();
  opened[1] = Date.now();
  show(1);
  await pageB.goto(`${base}/a/crm/contacts/${contactId ?? ''}`);
  await pageB.waitForTimeout(3000);
  await caption(pageB, 'A second browser, same person: the contact is here');
  await pageB.waitForTimeout(2500);
  const bContact = (await tool(pageB, 'crm.find', { q: 'Dana' })).body.result?.result ?? '';
  const bMsgs = (await tool(pageB, 'chat.read_messages', { channel: 'general', limit: 5 })).body.result?.messages ?? [];
  const bRuns = (await tool(pageB, 'agents.runs', { limit: 10 })).body.result?.runs ?? [];
  check('state shows in a second browser', !!contactId && bContact.includes(contactId) && bMsgs.some((m) => /created a contact for Dana/i.test(m.body)) && runIds.every((id) => bRuns.some((r) => r.id === id)));
  await pageB.goto(`${base}/agents`);
  await pageB.waitForTimeout(3000);
  await caption(pageB, 'The same two agents, with the same progress');
  await pageB.waitForTimeout(2500);
  show(0);

  // 7. Meetings, when installed: start a call from a Chat channel, and join it from another browser. A call
  // needs two different people (the same person joining twice replaces their first connection), so the
  // other browser is a second demo visitor, who waits in the waiting room until the host lets them in.
  const apps = (await tool(page, 'apps.list')).body.result?.apps ?? [];
  if (apps.some((a) => a.id === 'meet')) {
    if (!apps.find((a) => a.id === 'meet').on) await tool(page, 'apps.enable', { app: 'meet' });
    await go(page, '/a/chat', 2500);
    const g = page.locator('a', { hasText: '#general' }).first();
    if (await g.count()) { await g.click(); await pause(1800); }
    await say('Meetings: start a call from the #general channel');
    const start = page.locator('[data-tool="meet.huddle"]').first();
    await start.waitFor({ timeout: 10000 }).catch(() => {});
    if (await start.count()) {
      await start.click();
      await page.waitForURL(/\/a\/meet\/m\//, { timeout: 20000 }).catch(() => {});
      await pause(2500);
      const link = new URL(page.url()).pathname;
      const posted = (await tool(page, 'chat.read_messages', { channel: 'general', limit: 5 })).body.result?.messages ?? [];
      check('starting a call posts its link in #general', posted.some((m) => /\/a\/meet\/m\//.test(m.body)), posted.at(-1)?.body?.slice(0, 120));
      await say('The host joins the call');
      await page.locator('button[data-tool="meet.join"]').first().click().catch(() => {});
      await pause(4000);
      const ctxC = await browser.newContext({ viewport: size, recordVideo: { dir: path.join(out, 'raw'), size }, permissions: ['camera', 'microphone'] });
      const pageC = await ctxC.newPage();
      videos[2] = pageC.video();
      opened[2] = Date.now();
      await pageC.goto(`${base}/auth/demo?next=/`);
      await pageC.waitForTimeout(2500);
      await tool(pageC, 'apps.enable', { app: 'meet' });
      show(2);
      await pageC.goto(base + link);
      await pageC.waitForTimeout(3000);
      await caption(pageC, 'Another browser, another person, opens the call link');
      await pageC.waitForTimeout(1500);
      await pageC.locator('button[data-tool="meet.join"]').first().click().catch(() => {});
      await pageC.waitForTimeout(3000);
      await caption(pageC, 'They wait in the waiting room');
      await pageC.waitForTimeout(1500);
      show(0);
      await say('The host lets them in');
      const admit = page.locator('[data-tool="meet.admit"]').first();
      await admit.waitFor({ timeout: 20000 }).catch(() => {});
      await admit.click().catch(() => {});
      await pageC.waitForTimeout(6000);
      show(2);
      await pageC.waitForTimeout(1000);
      await caption(pageC, 'Both people in the call');
      await pageC.waitForTimeout(2000);
      const live = async (p) => p.evaluate(() => [...document.querySelectorAll('video')].filter((v) => v.readyState >= 2 && v.videoWidth > 0).length);
      const [a, c] = [await live(page), await live(pageC)];
      check('both browsers are in the call with video', a >= 2 && c >= 2, `host sees ${a} playing videos, guest sees ${c}`);
      show(0);
      await say('Both people in the call, peer to peer', 3000);
      await ctxC.close();
    } else check('a Call button in the channel', false, 'none found');
  } else note('Meetings is not installed on this server: call step skipped.');

  await ctxB.close();
} catch (e) {
  check('walkthrough ran to the end', false, e.message.split('\n')[0]);
} finally {
  await say(results.every((r) => r.ok) ? 'Walkthrough complete' : 'Walkthrough finished with problems', 1500);
  show(0);
  await ctxA.close();
  await browser.close();
}

// Cut the stretches out of each browser's recording and join them, a little faster than real time.
try {
  const files = [];
  for (const v of videos) files.push(v ? await v.path() : null);
  const parts = [];
  segs.filter((g) => files[g.v] && g.to - g.from > 0.3).forEach((g, n) => {
    const part = path.join(out, 'raw', `part${String(n).padStart(2, '0')}.mp4`);
    execSync(`ffmpeg -y -loglevel error -ss ${g.from.toFixed(2)} -to ${g.to.toFixed(2)} -i "${files[g.v]}" -vf "setpts=PTS/1.5,fps=25" -an -c:v libx264 -pix_fmt yuv420p -crf 26 -preset veryfast "${part}"`);
    parts.push(part);
  });
  fs.writeFileSync(path.join(out, 'raw', 'list.txt'), parts.map((f) => `file '${f}'`).join('\n'));
  execSync(`ffmpeg -y -loglevel error -f concat -safe 0 -i "${path.join(out, 'raw', 'list.txt')}" -c copy "${path.join(out, 'walkthrough.mp4')}"`);
  note(`video: ${path.join(out, 'walkthrough.mp4')} (${parts.length} cuts, 1.5x speed)`);
} catch (e) { note(`ffmpeg failed (${e.message.split('\n')[0]}); raw videos are in ${path.join(out, 'raw')}`); }
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ base, at: new Date().toISOString(), results, errors }, null, 2));
fs.writeFileSync(path.join(out, 'log.txt'), log.join('\n') + '\n');
console.log(`\n${results.filter((r) => r.ok).length} of ${results.length} checks passed${errors.length ? `; page errors: ${errors.length}` : ''}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
