// apps.*: list, turn on, turn off and uninstall apps for the team.
import type { Core } from './core.ts';
import type { CoreTool } from './types.ts';
import { fail, now } from './util.ts';

const S = (props: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object' as const, properties: props, required, additionalProperties: false });
const appId = { type: 'string', description: 'The app id, for example crm, board, chat' };

export function appTools(core: Core): CoreTool[] {
  return [
    {
      spec: { name: 'apps.list', title: 'List apps', description: 'Every app this server has, whether it is on for your team, and what each needs to run. Apps that are off are not loaded and their screens are never downloaded.', input: S(), scope: 'read', confirm: 'none', test: 'test/unit/apps.test.ts' },
      handler: async (_i, call) => ({ apps: await core.registry.listFor(call.team.id) }),
    },
    {
      spec: { name: 'apps.enable', title: 'Turn app on', description: 'Switch an app on for the whole team: its tables are created, its tools become available to people and agents, and it appears in the left rail.', input: S({ app: appId }, ['app']), scope: 'admin', confirm: 'none', emits: ['apps.app.enabled'], test: 'test/unit/apps.test.ts' },
      handler: async ({ app }, call: any) => { await core.registry.enable(call.team, app, call.caller?.user?.id ?? null); return { app, on: true }; },
    },
    {
      spec: { name: 'apps.disable', title: 'Turn app off', description: 'Switch an app off for the whole team. Its tools and screens disappear; its data is kept and comes back when it is turned on again.', input: S({ app: appId }, ['app']), scope: 'admin', confirm: 'none', emits: ['apps.app.disabled'], test: 'test/unit/apps.test.ts' },
      handler: async ({ app }, call: any) => { await core.registry.disable(call.team, app, call.caller?.user?.id ?? null); return { app, on: false }; },
    },
    {
      spec: { name: 'apps.uninstall', title: 'Uninstall and delete data', description: "Turn an app off and delete this team's data in it, for good. An export of that data is made first and its link returned. Other teams are not affected.", input: S({ app: appId, confirm_name: { type: 'string', description: 'Type the app name to confirm, for example "CRM"' } }, ['app', 'confirm_name']), scope: 'delete', confirm: 'human', emits: ['apps.app.uninstalled'], test: 'test/unit/apps.test.ts' },
      handler: async ({ app, confirm_name }, call: any) => {
        const a = core.registry.apps.get(app);
        if (!a) fail('no_app', `There is no app called ${app}.`, 404);
        if (a!.manifest.core) fail('core_app', `${a!.manifest.name} is part of wOS and cannot be uninstalled.`);
        if (String(confirm_name).trim().toLowerCase() !== a!.manifest.name.toLowerCase()) fail('confirm', `Type "${a!.manifest.name}" to confirm.`);
        const { exportTeam } = await import('./hosting.ts');
        const exp = await exportTeam(core, call.team, [app]);
        if (await core.registry.isOn(call.team.id, app)) await core.registry.disable(call.team, app, call.caller?.user?.id ?? null);
        // Delete this team's rows in the app's own tables (they all carry team_id).
        let rows = 0;
        const tables = await listTables(core, app);
        for (const t of tables) rows += (await core.db.run(`DELETE FROM ${t} WHERE team_id = ?`, [call.team.id]).catch(() => ({ changes: 0 }))).changes;
        await core.db.run('DELETE FROM team_apps WHERE team_id = ? AND app_id = ?', [call.team.id, app]);
        call.emit('apps.app.uninstalled', { app, rows, at: now() });
        return { app, deleted_rows: rows, export_url: exp.url };
      },
    },
  ];
}

async function listTables(core: Core, app: string): Promise<string[]> {
  const prefix = `${app.replace(/-/g, '_')}_`;
  const names = core.db.dialect === 'sqlite'
    ? (await core.db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name)
    : (await core.db.query<{ name: string }>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()")).map((r) => r.name);
  return names.filter((n) => n.startsWith(prefix) || (app === 'agents' && n.startsWith('agent_')) || n === app);
}
