// The CRM (warOnSaaS/crm), mounted as it is. Its pages show in a frame at /m/crm/; its tools join the
// catalogue as crm.*. WOS_CRM_DIR points at a checkout; WOS_CRM_WORKSPACE_DIR keeps its records in a folder
// (otherwise the CRM's own example data, in memory). One CRM workspace per server until the CRM ships as a
// native package with Postgres storage (ROADMAP step 7).
import { mountedApp } from '../../core/mounted.ts';

export default (ctx: any) => mountedApp(ctx, {
  id: 'crm',
  names: ['crm'],
  marker: 'lib/http.mjs',
  dirEnv: 'WOS_CRM_DIR',
  defineTools: 'lib/tools.mjs',
  session: { me: { id: 'you', name: 'the person signed in', role: 'owner' }, crm: { name: 'CRM' } },
  requestedWith: 'crm',
  publicDir: 'public',
  missing: 'The CRM is not installed on this server. Set WOS_CRM_DIR to a checkout of warOnSaaS/crm (with npm install run in it).',
  async handler(dir: string, ctx: any) {
    const { handle } = await import(`${dir}/lib/http.mjs`);
    const { config } = await import(`${dir}/lib/config.mjs`);
    const env: Record<string, string> = { CRM_NAME: ctx.env('WOS_CRM_NAME') || 'CRM' };
    if (ctx.env('WOS_CRM_WORKSPACE_DIR')) env.WORKSPACE_DIR = ctx.env('WOS_CRM_WORKSPACE_DIR');
    const cfg = config(env);
    return { handler: (req: any, res: any) => handle(req, res, cfg), mode: cfg.mode };
  },
});
