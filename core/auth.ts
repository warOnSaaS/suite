// Sign-in: GitHub, an email link, or (demo servers only) a demo button. Apps that connect over MCP
// (Claude, ChatGPT, Codex, Claude Code) use standard OAuth with dynamic registration and PKCE, ported from
// agent-kanban's lib/auth.mjs; the difference is that tokens here are sessions in the database, so they can be
// listed and revoked, and a refresh token used twice revokes its whole family.
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Core } from './core.ts';
import type { Caller, Role, Scope, User } from './types.ts';
import { ROLE_SCOPES } from './types.ts';
import { createSession, sessionFromToken } from './accounts.ts';
import { sign, verify } from './crypto.ts';
import { page, esc } from './page.ts';
import { now, parse } from './util.ts';

export const COOKIE = 'wos_session';
const GH_WEB = (core: Core) => core.env.GITHUB_WEB_BASE || 'https://github.com';
const GH_API = (core: Core) => core.env.GITHUB_API_BASE || 'https://api.github.com';

export function cookieOf(req: IncomingMessage, name = COOKIE) {
  return decodeURIComponent(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1] ?? '');
}
const secure = (core: Core) => core.publicUrl.startsWith('https://');
const setCookie = (core: Core, value: string, maxAge: number) => `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure(core) ? '; Secure' : ''}`;
const safeNext = (n: unknown) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');

/** Who is calling: from a bearer token (apps, scripts) or the session cookie (screens). */
export async function callerFromRequest(core: Core, req: IncomingMessage): Promise<Caller | null> {
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  const raw = bearer || cookieOf(req);
  if (!raw) return null;
  const s = await sessionFromToken(core, raw);
  if (!s) return null;
  const user = await core.users.get(s.userId);
  if (!user) return null;
  // The team: the one asked for (x-wos-team), else the session's, else the person's first.
  const teams = await core.users.teamsOf(user.id);
  const want = String(req.headers['x-wos-team'] ?? '') || s.teamId;
  const t = teams.find((x) => x.id === want || x.slug === want) ?? teams[0] ?? null;
  const role = (t?.role ?? null) as Role | null;
  const scopes = role ? ROLE_SCOPES[role].filter((x) => s.scopes.includes(x)) : [];
  return { actor: { kind: 'person', id: user.id, name: user.name }, user, team: t ? { id: t.id, slug: t.slug, name: t.name } : null, role, scopes, sessionId: s.id };
}

/** After any sign-in: accept invites, join teams linked to the person's GitHub organizations, or start a team. */
async function placeInTeam(core: Core, user: User, opts: { inviteId?: string | null; githubOrgs?: string[] } = {}) {
  if (opts.inviteId) {
    const inv = await core.db.get<any>('SELECT * FROM invites WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?', [opts.inviteId, now()]);
    if (inv) {
      await core.teams.addMember(inv.team_id, user.id, inv.role, inv.invited_by);
      await core.db.run('UPDATE invites SET accepted_at = ?, accepted_by = ? WHERE id = ?', [now(), user.id, inv.id]);
    }
  }
  await core.teams.acceptInvitesFor(user);
  for (const org of opts.githubOrgs ?? []) {
    for (const t of await core.db.query<any>('SELECT id FROM teams WHERE github_org = ? AND archived_at IS NULL', [org.toLowerCase()])) await core.teams.addMember(t.id, user.id, 'member');
  }
  let teams = await core.users.teamsOf(user.id);
  if (!teams.length) {
    const any = await core.db.get<any>('SELECT id FROM teams LIMIT 1');
    // The first person on a new server sets it up; after that, new teams only when sign-up is open.
    if (!any || core.env.WOS_OPEN_SIGNUP === '1') {
      await core.teams.create(`${user.name.split(' ')[0]}'s team`, user.id);
      teams = await core.users.teamsOf(user.id);
    }
  }
  return teams;
}

async function signInAndRedirect(core: Core, res: ServerResponse, user: User, next: string, opts: { inviteId?: string | null; githubOrgs?: string[] } = {}) {
  const teams = await placeInTeam(core, user, opts);
  if (!teams.length) {
    return page(res, 403, 'Not on a team yet', `<h1>Hi ${esc(user.name)}</h1><p>You are signed in, but you are not on a team on this server yet.</p><p>Ask a team admin to invite ${esc(user.email ?? `@${user.github_login}`)}, then sign in again.</p><a class="ui-btn is-quiet is-block" href="/auth/sign-in">Back to sign in</a>`);
  }
  const s = await createSession(core, user.id, teams[0].id, 'web');
  await core.db.run('UPDATE users SET last_seen_at = ? WHERE id = ?', [now(), user.id]);
  res.writeHead(302, { location: safeNext(next), 'set-cookie': setCookie(core, s.token, s.expiresIn), 'cache-control': 'no-store' }).end();
}

export async function bodyOf(req: IncomingMessage): Promise<Record<string, any>> {
  if ((req as any).body && typeof (req as any).body === 'object') return (req as any).body;
  let s = '';
  for await (const c of req) { s += c; if (s.length > 2_000_000) throw new Error('Body too large'); }
  if (!s) return {};
  try {
    return (req.headers['content-type'] ?? '').includes('json') ? JSON.parse(s) : Object.fromEntries(new URLSearchParams(s));
  } catch {
    return {};
  }
}

const json = (res: ServerResponse, status: number, obj: unknown, headers: Record<string, string> = {}) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(obj));

function signInPage(core: Core, res: ServerResponse, next: string, note = '', invite = '') {
  const gh = !!core.env.GITHUB_OAUTH_CLIENT_ID;
  const carry = `${encodeURIComponent(next)}${invite ? `&invite=${encodeURIComponent(invite)}` : ''}`;
  page(res, 200, 'Sign in', `<h1>Sign in to wOS</h1><p class="wos-gate-sub">One place for your team and its AI agents.</p>${note ? `<div class="ui-notice is-quiet">${note}</div>` : ''}
${core.demo ? `<a class="ui-btn is-lg is-block" href="/auth/demo?next=${carry}">Try the demo</a><p class="ui-hint wos-center">A private sandbox with example data. No account needed.</p>` : ''}
${gh ? `<a class="ui-btn ${core.demo ? 'is-quiet' : ''} is-lg is-block" href="/auth/github?next=${carry}">Continue with GitHub</a>` : ''}
<form class="wos-gate-form" method="post" action="/auth/email"><label class="ui-field"><span>Or get a sign-in link by email</span><input class="ui-input" type="email" name="email" required autocomplete="email" placeholder="you@example.com"></label><input type="hidden" name="next" value="${esc(next)}"><input type="hidden" name="invite" value="${esc(invite)}"><button class="ui-btn is-quiet is-block" type="submit">Email me a link</button></form>
<p class="ui-hint wos-center">Host it yourself, free, or host with us. Same app either way.</p>`);
}

/** Every /auth, /oauth and /.well-known route. Returns false when the path is not one of them. */
export async function handleAuth(core: Core, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname;
  const host = core.publicUrl;
  const q = Object.fromEntries(url.searchParams);

  if (p === '/auth/sign-in') { signInPage(core, res, safeNext(q.next), '', q.invite ?? ''); return true; }

  if (p === '/auth/sign-out') {
    const raw = cookieOf(req);
    if (raw && req.method === 'POST') { const s = await sessionFromToken(core, raw); if (s) await core.db.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [now(), s.id]); }
    res.writeHead(302, { location: '/auth/sign-in', 'set-cookie': setCookie(core, '', 0) }).end();
    return true;
  }

  if (p === '/auth/demo') {
    if (!core.demo) { page(res, 404, 'Not here', '<h1>No demo on this server</h1>'); return true; }
    const { demoSignIn } = await import('./demo.ts');
    const user = await demoSignIn(core);
    const teams = await core.users.teamsOf(user.id);
    const s = await createSession(core, user.id, teams[0]?.id ?? null, 'web', { ttl: 7 * 86400 });
    res.writeHead(302, { location: safeNext(q.next), 'set-cookie': setCookie(core, s.token, 7 * 86400), 'cache-control': 'no-store' }).end();
    return true;
  }

  // ---- GitHub ----
  if (p === '/auth/github') {
    if (!core.env.GITHUB_OAUTH_CLIENT_ID) { signInPage(core, res, safeNext(q.next), 'GitHub sign-in is not set up on this server. Use an email link.'); return true; }
    const state = sign({ k: 'gh', n: safeNext(q.next), i: q.invite || null }, 900);
    const u = new URL(`${GH_WEB(core)}/login/oauth/authorize`);
    u.searchParams.set('client_id', core.env.GITHUB_OAUTH_CLIENT_ID);
    u.searchParams.set('redirect_uri', `${host}/auth/github/callback`);
    u.searchParams.set('scope', 'read:user user:email read:org');
    u.searchParams.set('state', state);
    u.searchParams.set('allow_signup', 'true');
    res.writeHead(302, { location: u.toString(), 'cache-control': 'no-store' }).end();
    return true;
  }
  if (p === '/auth/github/callback') {
    const st = verify<{ n: string; i: string | null }>(q.state, 'gh');
    if (!st || !q.code) { signInPage(core, res, '/', 'That sign-in expired. Try again.'); return true; }
    const tok: any = await fetch(`${GH_WEB(core)}/login/oauth/access_token`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ client_id: core.env.GITHUB_OAUTH_CLIENT_ID, client_secret: core.env.GITHUB_OAUTH_CLIENT_SECRET, code: q.code, redirect_uri: `${host}/auth/github/callback` }) }).then((r) => r.json()).catch(() => ({}));
    if (!tok.access_token) { signInPage(core, res, st.n, 'GitHub sign-in failed. Try again.'); return true; }
    const gh = (path: string) => fetch(`${GH_API(core)}${path}`, { headers: { authorization: `Bearer ${tok.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'wos' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [user, emails, orgs] = await Promise.all([gh('/user'), gh('/user/emails'), gh('/user/orgs')]);
    if (!user?.login) { signInPage(core, res, st.n, 'GitHub sign-in failed. Try again.'); return true; }
    const verified = ((emails as any[]) ?? []).filter((e) => e.verified).sort((a, b) => Number(b.primary) - Number(a.primary)).map((e) => String(e.email).toLowerCase());
    const u = await core.users.fromGithub(user, verified);
    await signInAndRedirect(core, res, u, st.n, { inviteId: st.i, githubOrgs: ((orgs as any[]) ?? []).map((o) => o.login) });
    return true;
  }

  // ---- email link ----
  if (p === '/auth/email' && req.method === 'POST') {
    const b = await bodyOf(req);
    const email = String(b.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { signInPage(core, res, safeNext(b.next), 'That email address does not look right.'); return true; }
    const link = `${host}/auth/email/verify?t=${encodeURIComponent(sign({ k: 'magic', e: email, n: safeNext(b.next), i: b.invite || null }, 900))}`;
    await core.mail.send({ to: email, subject: 'Your wOS sign-in link', text: `Sign in to wOS:\n\n${link}\n\nThe link works for 15 minutes. If you did not ask for it, ignore this email.` });
    const dev = core.env.WOS_DEV_LINKS === '1' ? `<p class="ui-hint">Development server: <a href="${esc(link)}">open the link</a>.</p>` : '';
    page(res, 200, 'Check your email', `<h1>Check your email</h1><p class="wos-gate-sub">We sent a sign-in link to <b>${esc(email)}</b>. It works for 15 minutes.</p>${core.mail.configured ? '' : '<div class="ui-notice is-quiet">Email sending is not set up on this server yet, so the link was written to the server log.</div>'}${dev}`);
    return true;
  }
  if (p === '/auth/email/verify') {
    const t = verify<{ e: string; n: string; i: string | null }>(q.t, 'magic');
    if (!t) { signInPage(core, res, '/', 'That link has expired or was already used. Ask for a new one.'); return true; }
    if (req.method !== 'POST') {
      // Mail scanners open links; signing in takes a press.
      page(res, 200, 'Sign in', `<h1>Sign in as ${esc(t.e)}</h1><form method="post"><button class="ui-btn is-lg is-block" type="submit">Continue</button></form>`);
      return true;
    }
    const used = await core.db.get<any>("SELECT value FROM settings WHERE scope = 'used-link' AND key = ?", [crypto.createHash('sha256').update(q.t).digest('hex')]);
    if (used) { signInPage(core, res, '/', 'That link was already used. Ask for a new one.'); return true; }
    await core.db.run("INSERT INTO settings (scope, key, value, updated_at) VALUES ('used-link', ?, '1', ?)", [crypto.createHash('sha256').update(q.t).digest('hex'), now()]);
    const u = await core.users.fromEmail(t.e);
    await signInAndRedirect(core, res, u, t.n, { inviteId: t.i });
    return true;
  }

  // ---- invite link ----
  if (p === '/auth/invite') {
    const t = verify<{ i: string }>(q.t, 'invite');
    const inv = t ? await core.db.get<any>('SELECT i.*, t.name AS team_name FROM invites i JOIN teams t ON t.id = i.team_id WHERE i.id = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?', [t.i, now()]) : null;
    if (!inv) { signInPage(core, res, '/', 'That invite has expired or was already used. Ask for a new one.'); return true; }
    const me = await callerFromRequest(core, req);
    if (me?.user) { await placeInTeam(core, me.user, { inviteId: inv.id }); res.writeHead(302, { location: '/' }).end(); return true; }
    signInPage(core, res, '/', `You are invited to <b>${esc(inv.team_name)}</b>. Sign in to join.`, inv.id);
    return true;
  }

  // ---- MCP OAuth ----
  if (p.startsWith('/.well-known/oauth-protected-resource')) {
    json(res, 200, { resource: `${host}/mcp`, authorization_servers: [host], bearer_methods_supported: ['header'], resource_name: 'wOS', scopes_supported: ['read', 'write', 'delete', 'admin'] }, { 'access-control-allow-origin': '*' });
    return true;
  }
  if (p.startsWith('/.well-known/oauth-authorization-server') || p.startsWith('/.well-known/openid-configuration')) {
    json(res, 200, { issuer: host, authorization_endpoint: `${host}/oauth/authorize`, token_endpoint: `${host}/oauth/token`, registration_endpoint: `${host}/oauth/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['read', 'write', 'delete', 'admin'] }, { 'access-control-allow-origin': '*' });
    return true;
  }
  if (p === '/oauth/register' && req.method === 'POST') {
    const b = await bodyOf(req);
    const uris = (Array.isArray(b.redirect_uris) ? b.redirect_uris : []).filter(okRedirect);
    if (!uris.length) { json(res, 400, { error: 'invalid_redirect_uri' }); return true; }
    const client_id = sign({ k: 'client', r: uris, n: String(b.client_name ?? 'An app').slice(0, 80) }, 10 * 365 * 86400);
    json(res, 201, { client_id, client_name: b.client_name, redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', client_id_issued_at: Math.floor(Date.now() / 1000) }, { 'access-control-allow-origin': '*' });
    return true;
  }
  if (p === '/oauth/authorize') {
    const params = req.method === 'POST' ? await bodyOf(req) : q;
    const client = verify<{ r: string[]; n: string }>(params.client_id, 'client');
    if (!client || !client.r.includes(params.redirect_uri)) { page(res, 400, 'Not valid', '<h1>This sign-in link is not valid</h1><p>Start again from your app.</p>'); return true; }
    if (!params.code_challenge || (params.code_challenge_method ?? 'S256') !== 'S256') { page(res, 400, 'Not valid', '<h1>This app must use PKCE</h1>'); return true; }
    const me = await callerFromRequest(core, req);
    if (!me?.user || !me.team) { res.writeHead(302, { location: `/auth/sign-in?next=${encodeURIComponent(url.pathname + url.search)}` }).end(); return true; }
    if (req.method !== 'POST' || !verify(params.consent, 'consent')) {
      const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method'].map((k) => `<input type="hidden" name="${k}" value="${esc(params[k] ?? '')}">`).join('');
      const teams = await core.users.teamsOf(me.user.id);
      page(res, 200, 'Connect an app', `<h1>Connect ${esc(client.n)}</h1><p class="wos-gate-sub">${esc(client.n)} will use wOS as <b>${esc(me.user.name)}</b>, with the tools of every app that is on.</p>
<form method="post">${hidden}<input type="hidden" name="consent" value="${esc(sign({ k: 'consent', u: me.user.id }, 600))}">
<label class="ui-field"><span>Team</span><select class="ui-select" name="team">${teams.map((t) => `<option value="${esc(t.id)}" ${t.id === me.team!.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
<fieldset class="wos-scopes"><legend class="ui-label">It may</legend>${(['read', 'write', 'delete', 'admin'] as Scope[]).filter((s) => me.scopes.includes(s)).map((s) => `<label class="ui-check"><input type="checkbox" name="scope_${s}" ${s !== 'admin' ? 'checked' : ''}> ${{ read: 'Look things up', write: 'Create and change things', delete: 'Delete things', admin: 'Manage the team, apps and hosting' }[s]}</label>`).join('')}</fieldset>
<button class="ui-btn is-lg is-block" type="submit">Allow</button></form><p class="ui-hint wos-center">You can disconnect it any time in Settings, Account.</p>`);
      return true;
    }
    const teamId = (await core.teams.role(params.team, me.user.id)) ? params.team : me.team.id;
    const scopes = (['read', 'write', 'delete', 'admin'] as Scope[]).filter((s) => params[`scope_${s}`] && me.scopes.includes(s));
    const code = sign({ k: 'code', u: me.user.id, t: teamId, c: params.client_id, r: params.redirect_uri, cc: params.code_challenge, s: scopes.length ? scopes : ['read'], n: client.n }, 300);
    const to = new URL(params.redirect_uri);
    to.searchParams.set('code', code);
    if (params.state) to.searchParams.set('state', params.state);
    res.writeHead(302, { location: to.toString(), 'cache-control': 'no-store' }).end();
    return true;
  }
  if (p === '/oauth/token' && req.method === 'POST') {
    const b = await bodyOf(req);
    const cors = { 'access-control-allow-origin': '*' };
    if (b.grant_type === 'authorization_code') {
      const g = verify<any>(b.code, 'code');
      if (!g || g.c !== b.client_id || (b.redirect_uri && g.r !== b.redirect_uri)) { json(res, 400, { error: 'invalid_grant' }, cors); return true; }
      const s256 = crypto.createHash('sha256').update(String(b.code_verifier ?? '')).digest('base64url');
      if (s256 !== g.cc) { json(res, 400, { error: 'invalid_grant', error_description: 'PKCE check failed' }, cors); return true; }
      const used = await core.db.get<any>("SELECT value FROM settings WHERE scope = 'used-code' AND key = ?", [crypto.createHash('sha256').update(b.code).digest('hex')]);
      if (used) { json(res, 400, { error: 'invalid_grant', error_description: 'Code already used' }, cors); return true; }
      await core.db.run("INSERT INTO settings (scope, key, value, updated_at) VALUES ('used-code', ?, '1', ?)", [crypto.createHash('sha256').update(b.code).digest('hex'), now()]);
      json(res, 200, await issue(core, g.u, g.t, g.s, g.n), cors);
      return true;
    }
    if (b.grant_type === 'refresh_token') {
      const s = await sessionFromToken(core, String(b.refresh_token ?? ''), ['refresh']);
      if (!s) { json(res, 400, { error: 'invalid_grant' }, cors); return true; }
      // Rotate: the used refresh token and the old access token stop working; the family carries on.
      await core.db.run('UPDATE sessions SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL', [now(), s.family]);
      json(res, 200, await issue(core, s.userId, s.teamId, s.scopes, s.clientName ?? 'An app', s.family), cors);
      return true;
    }
    json(res, 400, { error: 'unsupported_grant_type' }, cors);
    return true;
  }
  return false;
}

async function issue(core: Core, userId: string, teamId: string | null, scopes: Scope[], clientName: string, family?: string) {
  const access = await createSession(core, userId, teamId, 'oauth', { clientName, scopes, family });
  const fam = family ?? access.id;
  const refresh = await createSession(core, userId, teamId, 'refresh', { clientName, scopes, family: fam });
  return { access_token: access.token, refresh_token: refresh.token, token_type: 'bearer', expires_in: access.expiresIn, scope: scopes.join(' ') };
}

function okRedirect(uri: string) {
  try {
    const u = new URL(uri);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname));
  } catch {
    return false;
  }
}

export { json, parse };
