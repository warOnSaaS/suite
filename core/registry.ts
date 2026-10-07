// The app registry. Finds app packages (apps-builtin/, WOS_APPS), and turns them on and off per team.
// "Off" means: the server part is never imported, its tables are never created, its tools are not in the
// catalogue for that team, and the browser never downloads its screens. On a server shared by many teams,
// an app's code loads the first time any team turns it on; other teams still see none of it.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkManifest, satisfies } from '../packages/manifest/index.mjs';
import { checkCatalogue } from '../packages/tools/index.mjs';
import type { Core } from './core.ts';
import { CORE_VERSION, ROOT, FROM_DIST } from './core.ts';
import type { Manifest, AppServer, Team, ToolSpec } from './types.ts';
import { migrate } from './migrate.ts';
import { now, fail } from './util.ts';

export interface AppEntry {
  manifest: Manifest;
  dir: string;
  tools: ToolSpec[];
  builtin: boolean;
  server?: AppServer;
  loading?: Promise<void>;
  /** Why the app cannot be turned on here (for example, the mounted package is not installed). */
  unavailable?: string;
}

export class Registry {
  core: Core;
  apps = new Map<string, AppEntry>();
  private onCache = new Map<string, { on: Set<string>; until: number }>();

  constructor(core: Core) { this.core = core; }

  discover() {
    const dirs: { dir: string; builtin: boolean }[] = [];
    const builtin = path.join(ROOT, 'apps-builtin');
    for (const d of fs.readdirSync(builtin)) dirs.push({ dir: path.join(builtin, d), builtin: true });
    for (const d of (this.core.env.WOS_APPS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) dirs.push({ dir: path.resolve(d), builtin: false });
    const installed = path.join(ROOT, 'apps-installed');
    if (fs.existsSync(installed)) for (const d of fs.readdirSync(installed)) dirs.push({ dir: path.join(installed, d), builtin: false });

    for (const { dir, builtin: b } of dirs) {
      const file = path.join(dir, 'wos-app.json');
      if (!fs.existsSync(file)) continue;
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
      const problems = checkManifest(manifest, { core: b });
      if (problems.length) { this.core.log.warn(`skipping app in ${dir}: ${problems.join(' ')}`); continue; }
      if (!satisfies(CORE_VERSION, manifest.requires.core)) { this.core.log.warn(`skipping ${manifest.id}: needs core ${manifest.requires.core}, this is ${CORE_VERSION}`); continue; }
      const cat = JSON.parse(fs.readFileSync(path.join(dir, manifest.tools), 'utf8'));
      const cp = checkCatalogue(cat);
      if (cp.length) { this.core.log.warn(`skipping ${manifest.id}: tools.json: ${cp.join(' ')}`); continue; }
      this.apps.set(manifest.id, { manifest, dir, tools: cat.tools, builtin: b });
    }
  }

  async start() {
    this.discover();
    // Core apps load always; others only if some team has them on.
    const on = new Set((await this.core.db.query<{ app_id: string }>('SELECT DISTINCT app_id FROM team_apps WHERE enabled = 1')).map((r) => r.app_id));
    for (const [appId, a] of this.apps) if (a.manifest.core || on.has(appId)) await this.load(appId).catch((e) => this.core.log.error(`${appId} failed to load: ${e.message}`));
  }

  async stop() { for (const a of this.apps.values()) await a.server?.stop?.(); }

  has(appId: string) { return this.apps.has(appId); }
  name(appId: string) { return this.apps.get(appId)?.manifest.name ?? appId; }
  isLoaded(appId: string) { return !!this.apps.get(appId)?.server; }
  loadedApps() { return [...this.apps.values()].filter((a) => a.server).map((a) => a.manifest.id); }

  /** Import the server part, run its migrations, put its tools in the catalogue. Once per process. */
  async load(appId: string) {
    const a = this.apps.get(appId);
    if (!a) fail('no_app', `There is no app called ${appId}.`, 404);
    if (a!.server) return;
    a!.loading ??= (async () => {
      const m = a!.manifest;
      if (m.tables) await migrate(this.core.db, m.id, path.join(a!.dir, m.tables), (s) => this.core.log.info(s));
      let server: AppServer = { handlers: {} };
      if (m.server) {
        const built = path.join(ROOT, 'dist', 'server', 'apps', `${m.id}.mjs`);
        const file = a!.builtin && FROM_DIST && fs.existsSync(built) ? built : path.join(a!.dir, m.server);
        const mod = await import(pathToFileURL(file).href);
        server = await mod.default(this.contextFor(a!));
      }
      if ((server as any).unavailable) a!.unavailable = (server as any).unavailable;
      const tools: ToolSpec[] = (server as any).tools ?? a!.tools; // mounted apps report their live tool list
      for (const t of tools) this.core.catalogue.add(m.id, t, server.handlers[t.name] ?? (async () => fail('unavailable', a!.unavailable ?? `${t.name} has no handler.`)));
      await server.start?.();
      a!.server = server;
      this.core.log.info(`loaded app ${m.id} ${m.version}${a!.unavailable ? ` (unavailable: ${a!.unavailable})` : ''}`);
    })();
    try { await a!.loading; } catch (e) { a!.loading = undefined; throw e; }
  }

  private contextFor(a: AppEntry) {
    const core = this.core;
    const dataDir = path.join(core.dataDir, 'apps', a.manifest.id);
    fs.mkdirSync(dataDir, { recursive: true });
    const allowed = new Set(a.manifest.needs?.env ?? []);
    return {
      app: a.manifest,
      dir: a.dir,
      db: core.db,
      core,
      events: {
        publish: (teamId: string, name: string, data?: unknown, actor?: any) => core.events.publish(teamId, name, data, actor),
        on: (name: string, fn: any) => core.events.on(name, fn),
      },
      alerts: {
        raise: (x: any) => core.alerts.raise({ ...x, source: a.manifest.id }),
        /** An answer that arrived through this app (a reply to an alert email): same effect as the inbox. */
        answer: (alertId: string, personId: string, answer: string | number, via = 'email') => core.alerts.answer(alertId, personId, answer, via),
      },
      /** Call any tool as a team member, outside a request: run-by-email, schedules, webhooks. Uses that member's
       *  role scopes (optionally fewer), writes the audit log with via, and treats the call as untrusted:
       *  confirm: human tools wait for the person's yes in the inbox. Throws no_tool when the app is off. */
      callAs: async (who: { teamId: string; personId: string; via?: 'email' | 'system'; label?: string; scopes?: string[]; trusted?: boolean }, name: string, input: unknown = {}) => {
        const user = await core.users.get(who.personId);
        const team = await core.teams.get(who.teamId);
        const role = user && team ? await core.teams.role(team.id, user.id) : null;
        if (!user || !team || !role) throw new Error('That person is not on that team.');
        const { ROLE_SCOPES } = await import('./types.ts');
        const scopes = ROLE_SCOPES[role].filter((s) => !who.scopes || who.scopes.includes(s));
        const r = await core.catalogue.call(name, input, { actor: { kind: 'person', id: user.id, name: who.label ?? `${user.name} (${who.via ?? 'system'})` }, user, team: { id: team.id, slug: team.slug, name: team.name }, role, scopes, untrusted: !who.trusted }, who.via ?? 'system');
        return r.pending ? { pending: r.pending } : r.result;
      },
      /** Team membership, the one source of truth. Apps read it instead of keeping their own list. */
      people: {
        members: (teamId: string) => core.teams.members(teamId),
        byEmail: async (teamId: string, email: string) => (await core.teams.members(teamId)).find((m: any) => m.email && m.email.toLowerCase() === String(email).toLowerCase()) ?? null,
        teamsOf: async (email: string) => { const u = await core.users.byEmail(String(email)); return u ? core.users.teamsOf(u.id) : []; },
        teamsWithApp: async () => (await core.db.query<any>('SELECT t.id, t.slug, t.name FROM team_apps a JOIN teams t ON t.id = a.team_id WHERE a.app_id = ? AND a.enabled = 1', [a.manifest.id])),
      },
      env: (name: string) => (allowed.has(name) || a.builtin ? core.env[name] : undefined),
      dataDir,
      publicUrl: core.publicUrl,
      log: { info: (...x: unknown[]) => core.log.info(`[${a.manifest.id}]`, ...x), warn: (...x: unknown[]) => core.log.warn(`[${a.manifest.id}]`, ...x), error: (...x: unknown[]) => core.log.error(`[${a.manifest.id}]`, ...x) },
    };
  }

  async onFor(teamId: string): Promise<Set<string>> {
    const hit = this.onCache.get(teamId);
    if (hit && hit.until > Date.now()) return hit.on;
    const rows = await this.core.db.query<{ app_id: string }>('SELECT app_id FROM team_apps WHERE team_id = ? AND enabled = 1', [teamId]);
    const on = new Set(rows.map((r) => r.app_id));
    for (const [id, a] of this.apps) if (a.manifest.core) on.add(id);
    this.onCache.set(teamId, { on, until: Date.now() + 2000 });
    return on;
  }

  async isOn(teamId: string, appId: string) {
    if (!this.apps.has(appId)) return true; // core namespaces (team, apps, models...) are always on
    return (await this.onFor(teamId)).has(appId);
  }

  async enable(team: Team, appId: string, by: string | null) {
    const a = this.apps.get(appId);
    if (!a) fail('no_app', `There is no app called ${appId}.`, 404);
    for (const [dep, range] of Object.entries(a!.manifest.requires.apps ?? {})) {
      if (!(await this.isOn(team.id, dep))) fail('needs_app', `${a!.manifest.name} needs ${this.name(dep)} on first.`);
      if (!satisfies(this.apps.get(dep)!.manifest.version, range)) fail('needs_app', `${a!.manifest.name} needs ${this.name(dep)} ${range}.`);
    }
    await this.load(appId);
    if (a!.unavailable) fail('unavailable', a!.unavailable);
    await this.setRow(team.id, appId, 1, by);
    await a!.server?.onEnable?.(team);
    this.core.events.publish(team.id, 'apps.app.enabled', { app: appId });
  }

  async disable(team: Team, appId: string, by: string | null) {
    const a = this.apps.get(appId);
    if (!a) fail('no_app', `There is no app called ${appId}.`, 404);
    if (a!.manifest.core) fail('core_app', `${a!.manifest.name} is part of wOS and stays on.`);
    await this.setRow(team.id, appId, 0, by);
    await a!.server?.onDisable?.(team);
    this.core.events.publish(team.id, 'apps.app.disabled', { app: appId });
  }

  private async setRow(teamId: string, appId: string, enabled: number, by: string | null) {
    const r = await this.core.db.run('UPDATE team_apps SET enabled = ?, changed_at = ?, changed_by = ? WHERE team_id = ? AND app_id = ?', [enabled, now(), by, teamId, appId]);
    if (!r.changes) await this.core.db.run('INSERT INTO team_apps (team_id, app_id, enabled, changed_at, changed_by) VALUES (?, ?, ?, ?, ?)', [teamId, appId, enabled, now(), by]);
    this.onCache.delete(teamId);
  }

  /** What the shell needs to draw the left rail and fetch screens. Only apps that are on. */
  async listFor(teamId: string) {
    const on = await this.onFor(teamId);
    return [...this.apps.values()]
      .map((a) => ({
        id: a.manifest.id,
        name: a.manifest.name,
        description: a.manifest.description,
        version: a.manifest.version,
        icon: a.manifest.icon ?? a.manifest.id,
        order: a.manifest.nav?.order ?? 50,
        nav: !a.manifest.nav?.hidden,
        core: !!a.manifest.core,
        on: on.has(a.manifest.id),
        loaded: !!a.server,
        unavailable: a.unavailable ?? null,
        mount: a.manifest.mount ?? null,
        needs: a.manifest.needs ?? {},
        tools: a.server ? [...this.core.catalogue.tools.values()].filter((t) => t.app === a.manifest.id).length : a.tools.length,
        screens: on.has(a.manifest.id) && a.manifest.screens ? `/apps/${a.manifest.id}/screens.js` : null,
      }))
      .sort((x, y) => x.order - y.order);
  }
}
