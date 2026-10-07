// People and teams. A team is a GitHub organization or a list of people; roles are owner, admin, member, guest.
import type { Core } from './core.ts';
import type { CoreTool, Role, User, Team, Scope } from './types.ts';
import { ROLE_SCOPES } from './types.ts';
import { id, now, later, fail, slugify, parse, token, sha256 } from './util.ts';
import { sign } from './crypto.ts';

const ROLES: Role[] = ['owner', 'admin', 'member', 'guest'];

export class Users {
  core: Core;
  constructor(core: Core) { this.core = core; }
  async get(userId: string) { return (await this.core.db.get<User>('SELECT * FROM users WHERE id = ?', [userId])) ?? null; }
  async byEmail(email: string) { return (await this.core.db.get<User>('SELECT * FROM users WHERE email = ?', [email.toLowerCase()])) ?? null; }
  async byGithub(login: string) { return (await this.core.db.get<User>('SELECT * FROM users WHERE github_login = ?', [login.toLowerCase()])) ?? null; }

  async create(u: { name: string; email?: string | null; github_login?: string | null; github_id?: string | null; avatar_url?: string | null }) {
    const user = { id: id('u'), name: u.name, email: u.email?.toLowerCase() ?? null, github_login: u.github_login?.toLowerCase() ?? null, avatar_url: u.avatar_url ?? null };
    await this.core.db.run('INSERT INTO users (id, name, email, github_login, github_id, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [user.id, user.name, user.email, user.github_login, u.github_id ?? null, user.avatar_url, now()]);
    return user as User;
  }

  /** Find by GitHub login, then by a verified email; create when new. Fills in what was missing. */
  async fromGithub(gh: { login: string; id: number | string; name?: string | null; avatar_url?: string | null }, verifiedEmails: string[]) {
    let u = await this.byGithub(gh.login);
    if (!u) for (const e of verifiedEmails) { u = await this.byEmail(e); if (u) break; }
    if (!u) return this.create({ name: gh.name || gh.login, email: verifiedEmails[0] ?? null, github_login: gh.login, github_id: String(gh.id), avatar_url: gh.avatar_url });
    await this.core.db.run('UPDATE users SET github_login = ?, github_id = ?, avatar_url = COALESCE(avatar_url, ?), email = COALESCE(email, ?), last_seen_at = ? WHERE id = ?', [gh.login.toLowerCase(), String(gh.id), gh.avatar_url ?? null, verifiedEmails[0] ?? null, now(), u.id]);
    return (await this.get(u.id))!;
  }

  async fromEmail(email: string) {
    return (await this.byEmail(email)) ?? this.create({ name: email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), email });
  }

  async teamsOf(userId: string) {
    return this.core.db.query<Team & { role: Role }>('SELECT t.id, t.slug, t.name, t.github_org, m.role FROM members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? AND t.archived_at IS NULL ORDER BY m.joined_at', [userId]);
  }
}

export class Teams {
  core: Core;
  constructor(core: Core) { this.core = core; }
  async get(teamId: string) { return (await this.core.db.get<Team & { github_org: string | null }>('SELECT id, slug, name, github_org FROM teams WHERE id = ?', [teamId])) ?? null; }
  async bySlug(slug: string) { return (await this.core.db.get<Team>('SELECT id, slug, name, github_org FROM teams WHERE slug = ?', [slug])) ?? null; }
  async role(teamId: string, userId: string) { return ((await this.core.db.get<{ role: Role }>('SELECT role FROM members WHERE team_id = ? AND user_id = ?', [teamId, userId]))?.role ?? null) as Role | null; }

  async create(name: string, ownerId: string, opts: { slug?: string; githubOrg?: string | null } = {}) {
    const base = slugify(opts.slug || name) || 'team';
    let slug = base;
    for (let n = 2; await this.bySlug(slug); n++) slug = `${base}-${n}`;
    const team = { id: id('t'), slug, name };
    await this.core.db.tx(async (db) => {
      await db.run('INSERT INTO teams (id, slug, name, github_org, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', [team.id, slug, name, opts.githubOrg ?? null, ownerId, now()]);
      await db.run('INSERT INTO members (team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', [team.id, ownerId, 'owner', now()]);
    });
    // New teams start with the apps the server suggests (WOS_DEFAULT_APPS), the board and CRM by default.
    for (const app of (this.core.env.WOS_DEFAULT_APPS ?? 'board,crm').split(',').map((s) => s.trim()).filter(Boolean)) {
      if (this.core.registry.has(app)) await this.core.registry.enable(team, app, ownerId).catch((e) => this.core.log.warn(`could not turn on ${app}: ${e.message}`));
    }
    this.core.events.publish(team.id, 'team.team.created', { id: team.id, name });
    return team as Team;
  }

  async addMember(teamId: string, userId: string, role: Role, by?: string) {
    const existing = await this.role(teamId, userId);
    if (existing) return existing;
    await this.core.db.run('INSERT INTO members (team_id, user_id, role, invited_by, joined_at) VALUES (?, ?, ?, ?, ?)', [teamId, userId, role, by ?? null, now()]);
    this.core.events.publish(teamId, 'team.member.joined', { user_id: userId, role });
    return role;
  }

  /** Invites waiting for this person, by email or GitHub login: accept them all. */
  async acceptInvitesFor(user: User) {
    const rows = await this.core.db.query<any>('SELECT * FROM invites WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? AND ((email IS NOT NULL AND email = ?) OR (github_login IS NOT NULL AND github_login = ?))', [now(), user.email ?? '-', user.github_login ?? '-']);
    for (const inv of rows) {
      await this.addMember(inv.team_id, user.id, inv.role, inv.invited_by);
      await this.core.db.run('UPDATE invites SET accepted_at = ?, accepted_by = ? WHERE id = ?', [now(), user.id, inv.id]);
    }
    return rows.length;
  }

  async members(teamId: string) {
    return this.core.db.query<any>('SELECT u.id, u.name, u.email, u.github_login, u.avatar_url, m.role, m.joined_at FROM members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY m.joined_at', [teamId]);
  }
}

// ---------- sessions and personal tokens ----------

export async function createSession(core: Core, userId: string, teamId: string | null, kind: 'web' | 'oauth' | 'token' | 'refresh', opts: { family?: string; clientName?: string; scopes?: Scope[]; ttl?: number } = {}) {
  const raw = `wos_${token(30)}`;
  const sid = id('s');
  const ttl = opts.ttl ?? (kind === 'refresh' ? 365 : kind === 'token' ? 3650 : 30) * 86400;
  await core.db.run('INSERT INTO sessions (id, user_id, team_id, family, kind, client_name, scopes, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    sid, userId, teamId, opts.family ?? sid, kind, opts.clientName ?? null, JSON.stringify(opts.scopes ?? ['read', 'write', 'delete', 'admin']), sha256(raw), now(), later(ttl),
  ]);
  return { token: raw, id: sid, expiresIn: ttl };
}

export async function sessionFromToken(core: Core, raw: string, kinds: string[] = ['web', 'oauth', 'token']) {
  if (!raw?.startsWith('wos_')) return null;
  const s = await core.db.get<any>('SELECT * FROM sessions WHERE token_hash = ?', [sha256(raw)]);
  if (!s || !kinds.includes(s.kind)) return null;
  if (s.revoked_at || s.expires_at < now()) {
    // A refresh token used after it was replaced: someone copied it. Revoke the whole family.
    if (s.kind === 'refresh' && s.revoked_at) await core.db.run('UPDATE sessions SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL', [now(), s.family]);
    return null;
  }
  if (!s.used_at || s.used_at < new Date(Date.now() - 3600e3).toISOString()) core.db.run('UPDATE sessions SET used_at = ? WHERE id = ?', [now(), s.id]).catch(() => {});
  return { id: s.id as string, userId: s.user_id as string, teamId: s.team_id as string | null, family: s.family as string, kind: s.kind as string, scopes: parse<Scope[]>(s.scopes, []), clientName: s.client_name as string | null };
}

// ---------- tools ----------

const S = (props: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object' as const, properties: props, required, additionalProperties: false });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });

async function meView(core: Core, userId: string, teamId: string | null) {
  const u = await core.users.get(userId);
  const teams = await core.users.teamsOf(userId);
  const current = teams.find((t) => t.id === teamId) ?? null;
  return {
    user: u && { id: u.id, name: u.name, email: u.email, github: u.github_login, avatar_url: u.avatar_url },
    team: current && { id: current.id, slug: current.slug, name: current.name, role: current.role, scopes: ROLE_SCOPES[current.role] },
    teams: teams.map((t) => ({ id: t.id, slug: t.slug, name: t.name, role: t.role })),
    server: { version: '0.1.0', demo: core.demo, reduced: core.reduced, storage: core.db.dialect, email: core.mail.configured, push: core.push.configured, github: !!core.env.GITHUB_OAUTH_CLIENT_ID },
  };
}

export function accountTools(core: Core): CoreTool[] {
  return [
    {
      spec: { name: 'account.me', title: 'Who am I', description: 'The signed-in person, their teams and role, the current team, and what this server has set up (storage, email, push, GitHub sign-in).', input: S(), scope: 'read', confirm: 'none', test: 'test/unit/core.test.ts' },
      handler: async (_i, call: any) => meView(core, call.caller.user.id, call.team.id || null),
    },
    {
      spec: { name: 'account.update_profile', title: 'Update profile', description: 'Change your display name.', input: S({ name: str('Your name, as teammates see it', { minLength: 1, maxLength: 80 }) }, ['name']), scope: 'write', confirm: 'none', test: 'test/unit/core.test.ts' },
      handler: async ({ name }, call: any) => { await core.db.run('UPDATE users SET name = ? WHERE id = ?', [name, call.caller.user.id]); return { name }; },
    },
    {
      spec: { name: 'account.switch_team', title: 'Switch team', description: 'Work in another of your teams. Screens and this session then show that team.', input: S({ team_id: str('A team id from account.me') }, ['team_id']), scope: 'read', confirm: 'none', test: 'test/unit/core.test.ts' },
      handler: async ({ team_id }, call: any) => {
        const role = await core.teams.role(team_id, call.caller.user.id);
        if (!role) fail('not_member', 'You are not on that team.');
        if (call.caller.sessionId) await core.db.run('UPDATE sessions SET team_id = ? WHERE id = ?', [team_id, call.caller.sessionId]);
        return meView(core, call.caller.user.id, team_id);
      },
    },
    {
      spec: { name: 'account.sign_out', title: 'Sign out', description: 'End this session. Other devices stay signed in unless everywhere is true.', input: S({ everywhere: { type: 'boolean', description: 'Sign out on every device and app' } }), scope: 'read', confirm: 'none', test: 'test/unit/core.test.ts' },
      handler: async ({ everywhere }, call: any) => {
        if (everywhere) await core.db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [now(), call.caller.user.id]);
        else if (call.caller.sessionId) await core.db.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [now(), call.caller.sessionId]);
        return { signed_out: true };
      },
    },
    {
      spec: { name: 'account.create_token', title: 'Create access token', description: 'A token for a script or an outside agent to call wOS as you, on this team, with the scopes you choose. Shown once; store it safely.', input: S({ name: str('What it is for, for example "nightly import"', { minLength: 2, maxLength: 60 }), scopes: { type: 'array', items: { enum: ['read', 'write', 'delete', 'admin'] }, description: 'Defaults to read and write' } }, ['name']), scope: 'write', confirm: 'human', test: 'test/unit/core.test.ts' },
      handler: async ({ name, scopes }, call: any) => {
        const allowed = (scopes ?? ['read', 'write']).filter((s: Scope) => call.scopes.includes(s));
        const t = await createSession(core, call.caller.user.id, call.team.id, 'token', { clientName: name, scopes: allowed });
        return { id: t.id, token: t.token, scopes: allowed, note: 'Shown once. Send it as: Authorization: Bearer <token>' };
      },
    },
    {
      spec: { name: 'account.list_tokens', title: 'List access tokens', description: 'Your access tokens and connected apps (Claude, ChatGPT, scripts) with when each was last used.', input: S(), scope: 'read', confirm: 'none', test: 'test/unit/core.test.ts' },
      handler: async (_i, call: any) => ({
        tokens: (await core.db.query<any>("SELECT id, kind, client_name, scopes, created_at, used_at, expires_at FROM sessions WHERE user_id = ? AND kind IN ('token', 'oauth') AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC", [call.caller.user.id, now()])).map((r) => ({ ...r, scopes: parse(r.scopes, []) })),
      }),
    },
    {
      spec: { name: 'account.revoke_token', title: 'Revoke access token', description: 'Stop a token or connected app from working, right away.', input: S({ token_id: str('The id from account.list_tokens') }, ['token_id']), scope: 'write', confirm: 'none', test: 'test/unit/core.test.ts' },
      handler: async ({ token_id }, call: any) => {
        const s = await core.db.get<any>('SELECT family FROM sessions WHERE id = ? AND user_id = ?', [token_id, call.caller.user.id]);
        if (!s) fail('not_found', 'No such token.');
        await core.db.run('UPDATE sessions SET revoked_at = ? WHERE family = ?', [now(), s.family]);
        return { revoked: true };
      },
    },
  ];
}

export function teamTools(core: Core): CoreTool[] {
  const roleEnum = { enum: ROLES.filter((r) => r !== 'owner'), description: 'admin, member or guest (read only)' };
  return [
    {
      spec: { name: 'team.create', title: 'Create team', description: 'Start a new team with you as owner. The board and CRM start switched on; change that in apps.', input: S({ name: str('Team name, for example "Acme Dental"', { minLength: 2, maxLength: 60 }), github_org: str('Optional GitHub organization: its members can join by signing in with GitHub') }, ['name']), scope: 'write', confirm: 'none', emits: ['team.team.created'], test: 'test/unit/core.test.ts' },
      handler: async ({ name, github_org }, call: any) => {
        const t = await core.teams.create(name, call.caller.user.id, { githubOrg: github_org?.toLowerCase() ?? null });
        if (call.caller.sessionId) await core.db.run('UPDATE sessions SET team_id = ? WHERE id = ?', [t.id, call.caller.sessionId]);
        return t;
      },
    },
    {
      spec: { name: 'team.get', title: 'Show team', description: 'The current team: its members with roles, open invites, and its GitHub organization if linked.', input: S(), scope: 'read', confirm: 'none', test: 'test/unit/core.test.ts' },
      handler: async (_i, call: any) => {
        const team = await core.teams.get(call.team.id);
        const invites = await core.db.query<any>('SELECT id, email, github_login, role, created_at, expires_at FROM invites WHERE team_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC', [call.team.id, now()]);
        return { team, members: await core.teams.members(call.team.id), invites };
      },
    },
    {
      spec: { name: 'team.update', title: 'Rename team', description: 'Change the team name or its linked GitHub organization (members of that organization can join by signing in with GitHub).', input: S({ name: str('New name', { minLength: 2, maxLength: 60 }), github_org: str('GitHub organization login, or empty to unlink') }), scope: 'admin', confirm: 'none', test: 'test/unit/core.test.ts' },
      handler: async ({ name, github_org }, call: any) => {
        if (name) await core.db.run('UPDATE teams SET name = ? WHERE id = ?', [name, call.team.id]);
        if (github_org !== undefined) await core.db.run('UPDATE teams SET github_org = ? WHERE id = ?', [github_org ? github_org.toLowerCase() : null, call.team.id]);
        return core.teams.get(call.team.id);
      },
    },
    {
      spec: { name: 'team.invite', title: 'Invite someone', description: 'Invite a person by email address or GitHub username. They get a sign-in link by email when an email address is given; with a GitHub username they join when they sign in with GitHub. Returns the invite link to share by hand too.', input: S({ email: str('Their email address', { pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' }), github: str('Their GitHub username'), role: roleEnum }, []), scope: 'admin', confirm: 'none', emits: ['team.invite.sent'], test: 'test/unit/core.test.ts' },
      handler: async ({ email, github, role = 'member' }, call: any) => {
        if (!email && !github) fail('invalid_input', 'Give an email address or a GitHub username.');
        const inv = { id: id('inv'), email: email?.toLowerCase() ?? null, github_login: github?.replace(/^@/, '').toLowerCase() ?? null, role };
        await core.db.run('INSERT INTO invites (id, team_id, email, github_login, role, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [inv.id, call.team.id, inv.email, inv.github_login, role, call.caller.user.id, now(), later(14 * 86400)]);
        const link = `${core.publicUrl}/auth/invite?t=${encodeURIComponent(sign({ k: 'invite', i: inv.id }, 14 * 86400))}`;
        let emailed = false;
        if (inv.email) {
          const r = await core.mail.send({ teamId: call.team.id, to: inv.email, subject: `${call.actor.name} invited you to ${call.team.name} on wOS`, text: `${call.actor.name} invited you to join ${call.team.name} on wOS.\n\nJoin: ${link}\n\nThe link works for 14 days.` });
          emailed = r.sent;
        }
        call.emit('team.invite.sent', { id: inv.id, email: inv.email, github: inv.github_login, role });
        return { ...inv, link, emailed };
      },
    },
    {
      spec: { name: 'team.revoke_invite', title: 'Cancel invite', description: 'Cancel an invite that has not been used yet.', input: S({ invite_id: str('From team.get') }, ['invite_id']), scope: 'admin', confirm: 'none', test: 'test/unit/core.test.ts' },
      handler: async ({ invite_id }, call: any) => { const r = await core.db.run('UPDATE invites SET revoked_at = ? WHERE id = ? AND team_id = ?', [now(), invite_id, call.team.id]); return { revoked: r.changes > 0 }; },
    },
    {
      spec: { name: 'team.set_role', title: 'Change role', description: 'Make a member an admin, a member or a guest (guests can only look). The owner cannot be changed here.', input: S({ user_id: str('From team.get'), role: roleEnum }, ['user_id', 'role']), scope: 'admin', confirm: 'none', emits: ['team.member.role_changed'], test: 'test/unit/core.test.ts' },
      handler: async ({ user_id, role }, call: any) => {
        const cur = await core.teams.role(call.team.id, user_id);
        if (!cur) fail('not_found', 'That person is not on this team.');
        if (cur === 'owner') fail('owner', 'The owner keeps the owner role.');
        await core.db.run('UPDATE members SET role = ? WHERE team_id = ? AND user_id = ?', [role, call.team.id, user_id]);
        call.emit('team.member.role_changed', { user_id, role });
        return { user_id, role };
      },
    },
    {
      spec: { name: 'team.remove_member', title: 'Remove from team', description: 'Take a person off the team. Their sessions on this team stop working. Their work stays.', input: S({ user_id: str('From team.get') }, ['user_id']), scope: 'admin', confirm: 'human', emits: ['team.member.left'], test: 'test/unit/core.test.ts' },
      handler: async ({ user_id }, call: any) => {
        if ((await core.teams.role(call.team.id, user_id)) === 'owner') fail('owner', 'The owner cannot be removed.');
        await core.db.run('DELETE FROM members WHERE team_id = ? AND user_id = ?', [call.team.id, user_id]);
        await core.db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND team_id = ? AND revoked_at IS NULL', [now(), user_id, call.team.id]);
        call.emit('team.member.left', { user_id });
        return { removed: true };
      },
    },
  ];
}
