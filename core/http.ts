// Every HTTP route of the suite server, in one place. The node server (apps/server/main.ts) and the
// serverless entry (api/index.mjs) both call handle(), so they never drift.
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { toOpenApi } from '../packages/tools/index.mjs';
import type { Core } from './core.ts';
import { ROOT } from './core.ts';
import { callerFromRequest, handleAuth, bodyOf, json, cookieOf } from './auth.ts';
import { handleMcp } from './mcp.ts';
import { verify } from './crypto.ts';
import { page, esc } from './page.ts';
import { WosError, parse } from './util.ts';

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon', '.map': 'application/json' };

export const SHELL_DIR = () => [path.join(ROOT, 'dist', 'shell'), path.join(ROOT, 'apps', 'shell', 'public')];

function serveFile(res: ServerResponse, file: string, cache: string) {
  const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': cache, 'x-content-type-options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}

function staticFile(p: string): string | null {
  const rel = path.normalize(decodeURIComponent(p)).replace(/^(\.\.[/\\])+/, '');
  for (const dir of SHELL_DIR()) {
    const f = path.join(dir, rel);
    if (f.startsWith(dir) && fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  }
  return null;
}

export async function handle(core: Core, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', core.publicUrl);
  const p = url.pathname;
  try {
    if (p === '/health') return json(res, 200, { ok: true, version: '0.1.0', storage: core.db.dialect, reduced: core.reduced });
    if (p.startsWith('/api/tools/')) return await handleTool(core, req, res, decodeURIComponent(p.slice('/api/tools/'.length)));
    if (p === '/api/openapi.json') return await handleOpenApi(core, req, res);
    if (p === '/mcp') return await handleMcp(core, req, res);
    if (await handleAuth(core, req, res, url)) return;
    if (p === '/alerts/answer') return await handleEmailAnswer(core, req, res, url);
    if (p.startsWith('/files/core/exports/')) return await handleExport(core, req, res, url);
    if (p.startsWith('/m/')) return await handleMount(core, req, res, url);
    if (/^\/(files|media|hooks)\/[a-z][a-z0-9-]*\//.test(p)) return await handleAppRoute(core, req, res, url);
    if (p.startsWith('/apps/') && p.endsWith('/screens.js')) return await handleScreens(core, req, res, p.split('/')[2]);

    // The shell: static files, then the single page for every other address.
    if (req.method === 'GET' || req.method === 'HEAD') {
      const f = p !== '/' && staticFile(p);
      if (f) return serveFile(res, f, /\/assets\//.test(p) ? 'public, max-age=31536000, immutable' : 'no-cache');
      if (/\.[a-z0-9]+$/i.test(p) && !p.startsWith('/m/')) return res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      const caller = await callerFromRequest(core, req);
      if (!caller?.user) return res.writeHead(302, { location: `/auth/sign-in?next=${encodeURIComponent(p + url.search)}${core.demo && cookieOf(req) ? '&reset=1' : ''}`, 'cache-control': 'no-store' }).end();
      const index = staticFile('/index.html');
      if (!index) return page(res, 503, 'Not built', '<h1>The screens are not built yet</h1><p>Run <code>npm run build</code>, then reload.</p>');
      return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-frame-options': 'SAMEORIGIN' }).end(fs.readFileSync(index));
    }
    return json(res, 404, { error: { code: 'not_found', message: 'Nothing here.' } });
  } catch (e: any) {
    core.log.error(e);
    if (!res.headersSent) json(res, e instanceof WosError ? e.status : 500, { error: { code: e.code ?? 'server', message: e instanceof WosError ? e.message : 'Something went wrong on our side. Try again.' } });
  }
}

async function handleTool(core: Core, req: IncomingMessage, res: ServerResponse, name: string) {
  if (req.method === 'OPTIONS') return res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, x-wos-team', 'access-control-allow-methods': 'POST' }).end();
  if (req.method !== 'POST') return json(res, 405, { error: { code: 'method', message: 'Use POST.' } }, { allow: 'POST' });
  const bearer = /^Bearer\s/i.test(req.headers.authorization ?? '');
  // Cookie calls come only from our own screens, which send this header; a form on another site cannot.
  if (!bearer && cookieOf(req) && req.headers['x-wos'] !== '1') return json(res, 403, { error: { code: 'csrf', message: 'Missing request header.' } });
  const caller = await callerFromRequest(core, req);
  const input = await bodyOf(req);
  try {
    const r = await core.catalogue.call(name, input, caller, bearer ? 'rest' : 'screen');
    if (r.pending) return json(res, 202, { pending: r.pending });
    return json(res, 200, { result: r.result });
  } catch (e: any) {
    if (e instanceof WosError) return json(res, e.status, { error: { code: e.code, message: e.message } }, e.status === 401 ? { 'www-authenticate': `Bearer resource_metadata="${core.publicUrl}/.well-known/oauth-protected-resource"` } : {});
    throw e;
  }
}

async function handleOpenApi(core: Core, req: IncomingMessage, res: ServerResponse) {
  const caller = await callerFromRequest(core, req);
  // Signed out: the full catalogue of what this server offers. Signed in: only what your team has on.
  const tools = caller?.team ? await core.catalogue.visible(caller) : [...core.catalogue.tools.values()];
  json(res, 200, toOpenApi(tools, { title: 'wOS', version: '0.1.0', server: core.publicUrl }), { 'access-control-allow-origin': '*' });
}

async function handleEmailAnswer(core: Core, req: IncomingMessage, res: ServerResponse, url: URL) {
  const t = verify<{ a: string; o: number | null; u: string }>(url.searchParams.get('t'), 'answer');
  if (!t) return page(res, 400, 'Link expired', '<h1>This link has expired</h1><p>Open wOS to answer from your inbox.</p><a class="ui-btn is-block" href="/inbox">Open inbox</a>');
  const a = await core.db.get<any>('SELECT * FROM alerts WHERE id = ?', [t.a]);
  if (!a) return page(res, 404, 'Not found', '<h1>That alert is gone</h1>');
  const opts = parse<string[]>(a.options, []);
  if (a.status !== 'open') return page(res, 200, 'Already answered', `<h1>Already answered</h1><p>${esc(a.title)}</p><p>Answer: <b>${esc(a.answer ?? 'cleared')}</b></p><a class="ui-btn is-quiet is-block" href="/inbox">Open inbox</a>`);
  if (req.method !== 'POST') {
    const choice = t.o != null ? opts[t.o] : null;
    return page(res, 200, 'Answer', `<h1>${esc(a.title)}</h1>${a.body ? `<p class="wos-gate-sub">${esc(a.body).replace(/\n/g, '<br>')}</p>` : ''}<form method="post">${choice ? `<button class="ui-btn is-lg is-block" type="submit">${esc(choice)}</button>` : opts.map((o, i) => `<button class="ui-btn ${i ? 'is-quiet' : ''} is-block" name="o" value="${i}">${esc(o)}</button>`).join('')}</form><p class="ui-hint wos-center">Nothing happens until you press the button.</p>`);
  }
  const b = await bodyOf(req);
  const option = t.o ?? Number(b.o ?? 0);
  const user = await core.users.get(t.u);
  const team = await core.teams.get(a.team_id);
  const role = await core.teams.role(a.team_id, t.u);
  if (!user || !team || !role) return page(res, 403, 'Not allowed', '<h1>You are no longer on that team</h1>');
  const r = await core.catalogue.call('alerts.answer', { alert_id: a.id, option }, { actor: { kind: 'person', id: user.id, name: user.name }, user, team, role, scopes: ['read', 'write'] }, 'email');
  return page(res, 200, 'Done', `<h1>Thanks</h1><p>You answered <b>${esc((r.result as any)?.answer)}</b>.</p><a class="ui-btn is-quiet is-block" href="/inbox">Open inbox</a>`);
}

async function handleExport(core: Core, req: IncomingMessage, res: ServerResponse, url: URL) {
  const file = path.basename(url.pathname);
  const t = verify<{ f: string; team: string }>(url.searchParams.get('t'), 'export');
  if (!t || t.f !== file) return page(res, 403, 'Link expired', '<h1>This export link has expired</h1><p>Make a new export in Settings.</p>');
  const f = path.join(core.dataDir, 'exports', file);
  if (!fs.existsSync(f)) return page(res, 404, 'Gone', '<h1>That export is no longer on this server</h1>');
  res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${file}"`, 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
}

/** Mounted apps (the CRM and the board as they are): their own pages, under /m/<id>/, for signed-in members of a team that has the app on. */
async function handleMount(core: Core, req: IncomingMessage, res: ServerResponse, url: URL) {
  const appId = url.pathname.split('/')[2];
  const a = core.registry.apps.get(appId);
  if (!a?.manifest.mount) return page(res, 404, 'Not found', '<h1>No such app</h1>');
  const caller = await callerFromRequest(core, req);
  if (!caller?.team) return res.writeHead(302, { location: `/auth/sign-in?next=${encodeURIComponent(url.pathname + url.search)}` }).end();
  if (!(await core.registry.isOn(caller.team.id, appId)) || !a.server) return page(res, 404, 'Turned off', `<h1>${esc(a.manifest.name)} is off</h1><p>Turn it on in Settings, Apps.</p>`);
  const m = (a.server as any).mount;
  if (!m) return page(res, 503, 'Unavailable', `<h1>${esc(a.manifest.name)} is not available</h1><p>${esc(a.unavailable ?? '')}</p>`);
  return m(req, res, url, caller);
}

async function handleAppRoute(core: Core, req: IncomingMessage, res: ServerResponse, url: URL) {
  const appId = url.pathname.split('/')[2];
  const a = core.registry.apps.get(appId);
  const caller = await callerFromRequest(core, req);
  if (!a?.server?.routes || (caller?.team && !(await core.registry.isOn(caller.team.id, appId)))) return json(res, 404, { error: { code: 'not_found', message: 'Nothing here.' } });
  const call = caller ? core.catalogue.makeCall(caller, 'screen') : null;
  if (!(await a.server.routes(req, res, url, call as any))) json(res, 404, { error: { code: 'not_found', message: 'Nothing here.' } });
}

/** Screens of apps from other repos. Built-in screens ship inside the shell bundle, split per app. */
async function handleScreens(core: Core, req: IncomingMessage, res: ServerResponse, appId: string) {
  const a = core.registry.apps.get(appId);
  const caller = await callerFromRequest(core, req);
  if (!a?.manifest.screens || !caller?.team || !(await core.registry.isOn(caller.team.id, appId))) return json(res, 404, { error: { code: 'off', message: 'That app is off.' } });
  const file = path.join(a.dir, a.manifest.screens);
  if (!fs.existsSync(file)) { core.log.error(`${appId}: screens file missing at ${file}`); return json(res, 500, { error: { code: 'missing', message: `${a.manifest.name} is installed without its screens file.` } }); }
  serveFile(res, file, 'no-cache');
}
