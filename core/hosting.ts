// hosting.*: how this server runs, a health check, and "export everything". audit.* and events.* too.
import fs from 'node:fs';
import path from 'node:path';
import type { Core } from './core.ts';
import type { CoreTool, Team } from './types.ts';
import { id, now, parse, fail } from './util.ts';
import { sign } from './crypto.ts';

const S = (props: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object' as const, properties: props, required, additionalProperties: false });

const CORE_TABLES: [string, string][] = [
  ['teams', 'SELECT id, slug, name, github_org, created_at FROM teams WHERE id = ?'],
  ['members', 'SELECT m.user_id, u.name, u.email, u.github_login, m.role, m.joined_at FROM members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ?'],
  ['apps', 'SELECT app_id, enabled, changed_at FROM team_apps WHERE team_id = ?'],
  ['conversations', 'SELECT * FROM conversations WHERE team_id = ?'],
  ['conversation_messages', 'SELECT cm.* FROM conversation_messages cm JOIN conversations c ON c.id = cm.conversation_id WHERE c.team_id = ?'],
  ['alerts', 'SELECT * FROM alerts WHERE team_id = ?'],
  ['audit', 'SELECT * FROM audit WHERE team_id = ?'],
  ['model_providers', 'SELECT id, kind, name, base_url, default_model, user_id, created_at FROM model_providers WHERE team_id = ?'],
];

/** Write one JSON file with everything the team has (core tables plus each app's export) and return a signed link. */
export async function exportTeam(core: Core, team: Team, onlyApps?: string[]) {
  const out: Record<string, unknown> = { format: 'wos-export-1', exported_at: now(), team: { id: team.id, slug: team.slug, name: team.name }, core: {}, apps: {} };
  if (!onlyApps) for (const [name, sql] of CORE_TABLES) (out.core as any)[name] = await core.db.query(sql, [team.id]);
  for (const [appId, a] of core.registry.apps) {
    if (onlyApps && !onlyApps.includes(appId)) continue;
    if (!a.server) continue;
    try {
      (out.apps as any)[appId] = a.server.exportTeam ? await a.server.exportTeam(team) : { note: 'This app has no export yet.' };
    } catch (e: any) {
      (out.apps as any)[appId] = { error: e.message };
    }
  }
  const dir = path.join(core.dataDir, 'exports');
  fs.mkdirSync(dir, { recursive: true });
  const file = `${team.slug}-${now().slice(0, 19).replace(/[:T]/g, '-')}-${id('x').slice(2)}.json`;
  fs.writeFileSync(path.join(dir, file), JSON.stringify(out, null, 2));
  const url = `/files/core/exports/${file}?t=${encodeURIComponent(sign({ k: 'export', f: file, team: team.id }, 7 * 86400))}`;
  return { url, file, bytes: fs.statSync(path.join(dir, file)).size };
}

export function hostingTools(core: Core): CoreTool[] {
  return [
    {
      spec: { name: 'hosting.status', title: 'How this server runs', description: 'Plain facts about this wOS server: hosted or self-hosted, the storage it uses, whether email, phone push and GitHub sign-in are set up, and which apps are loaded.', input: S(), scope: 'read', confirm: 'none', test: 'test/unit/core.test.ts' },
      handler: async () => ({
        version: '0.1.0',
        mode: core.demo ? 'demo' : core.env.WOS_HOSTED === '1' ? 'hosted' : 'self-hosted',
        reduced: core.reduced ? 'Runs on serverless hosting: no live socket and no background work. Agents move forward while a screen is open.' : null,
        storage: core.db.describe.replace(/file .*/, 'file'),
        email: core.mail.configured ? 'SMTP set up' : 'not set up: sign-in links and alerts are written to the server log',
        push: core.push.configured ? 'Web Push ready' : 'off',
        github_sign_in: !!core.env.GITHUB_OAUTH_CLIENT_ID,
        loaded_apps: core.registry.loadedApps(),
      }),
    },
    {
      spec: { name: 'hosting.doctor', title: 'Check this server', description: 'Run the self-host checks and say in plain words what is missing: public address and HTTPS, database, email sending, Web Push, GitHub sign-in, disk space for files, and anything the apps that are on need.', input: S(), scope: 'admin', confirm: 'none', test: 'test/unit/core.test.ts' },
      handler: async (_i, call: any) => {
        const checks: { name: string; ok: boolean; say: string }[] = [];
        const add = (name: string, ok: boolean, say: string) => checks.push({ name, ok, say });
        add('Public address', core.publicUrl.startsWith('https://'), core.publicUrl.startsWith('https://') ? `Served at ${core.publicUrl}.` : `PUBLIC_URL is ${core.publicUrl}. Sign-in callbacks, phone push and installing the app need an https address (the docker compose file includes Caddy for this).`);
        add('Database', core.db.dialect === 'postgres' || !core.env.WOS_HOSTED, core.db.dialect === 'postgres' ? 'Postgres connected.' : 'SQLite file in the data folder. Fine for one person or a small team on one server; set DATABASE_URL for Postgres.');
        add('Email', core.mail.configured, core.mail.configured ? 'SMTP is set.' : 'Set SMTP_URL and MAIL_FROM so sign-in links, invites and alerts are emailed. Any mailbox works.');
        add('Phone push', core.push.configured, core.push.configured ? 'Web Push keys are ready.' : 'Web Push failed to start; see the server log.');
        add('GitHub sign-in', !!core.env.GITHUB_OAUTH_CLIENT_ID, core.env.GITHUB_OAUTH_CLIENT_ID ? 'GitHub OAuth app is set.' : 'Optional: create a GitHub OAuth app (callback /auth/github/callback) and set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET.');
        add('Server key', !!core.env.WOS_SECRET_KEY, core.env.WOS_SECRET_KEY ? 'WOS_SECRET_KEY is set.' : 'Using a key file in the data folder. Back it up: without it, stored model keys cannot be read.');
        for (const a of await core.registry.listFor(call.team.id)) {
          if (!a.on) continue;
          if (a.unavailable) add(`${a.name}`, false, a.unavailable);
          for (const s of (a.needs as any).services ?? []) add(`${a.name} needs ${s}`, false, `Start it with: docker compose --profile ${s} up -d`);
        }
        return { ok: checks.every((c) => c.ok), checks };
      },
    },
    {
      spec: { name: 'hosting.export', title: 'Export everything', description: "Download everything this team has in wOS as one JSON file: members, apps, conversations, alerts, the audit log and each app's own data. The link works for 7 days.", input: S(), scope: 'admin', confirm: 'none', test: 'test/unit/core.test.ts' },
      handler: async (_i, call: any) => exportTeam(core, call.team),
    },
  ];
}

export function auditTools(core: Core): CoreTool[] {
  return [
    {
      spec: { name: 'audit.list', title: 'Activity log', description: 'Every action taken on this team by people and agents (reads from screens are left out), newest first. Filter by tool, by who, or by agents only.', input: S({ tool: { type: 'string' }, actor_id: { type: 'string' }, agents_only: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } }), scope: 'admin', confirm: 'none', test: 'test/unit/core.test.ts' },
      handler: async ({ tool, actor_id, agents_only, limit }, call: any) => {
        const where = ['team_id = ?'];
        const args: unknown[] = [call.team.id];
        if (tool) { where.push('tool = ?'); args.push(tool); }
        if (actor_id) { where.push('actor_id = ?'); args.push(actor_id); }
        if (agents_only) where.push("actor_kind = 'agent'");
        args.push(limit);
        return { entries: (await core.db.query<any>(`SELECT id, actor_kind, actor_id, actor_name, tool, via, status, error, ms, at FROM audit WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT ?`, args)) };
      },
    },
  ];
}

export function eventTools(core: Core): CoreTool[] {
  return [
    {
      spec: { name: 'events.poll', title: 'Catch up on changes', description: 'What changed on this team since a point in time (an ISO time from the last poll). Screens use it when a live connection is not available; agents can use it to wait for changes.', input: S({ since: { type: 'string' }, names: { type: 'array', items: { type: 'string' }, description: 'Only these event names; app.* works' } }), scope: 'read', confirm: 'none', hidden: true, test: 'test/unit/core.test.ts' },
      handler: async ({ since, names }, call: any) => {
        await core.agentsPump?.(call.team.id);
        let events = await core.events.since(call.team.id, since, call.caller?.user?.id ?? '-');
        if (names?.length) events = events.filter((e) => names.some((n: string) => n === e.name || (n.endsWith('.*') && e.name.startsWith(n.slice(0, -1)))));
        return { now: events.at(-1)?.at ?? since ?? now(), events };
      },
    },
  ];
}

export { parse, fail };
