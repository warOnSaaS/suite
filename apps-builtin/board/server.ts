// The board (warOnSaaS/agent-kanban), mounted as it is. Its pages show in a frame at /m/board/; its tools join
// the catalogue as board.*. WOS_BOARD_DIR points at a checkout; WOS_BOARD_WORKSPACE_DIR keeps the board in a
// folder; WOS_BOARD_REPO and WOS_BOARD_GITHUB_TOKEN use a GitHub repo; otherwise its example board in memory.
import { mountedApp } from '../../core/mounted.ts';

export default (ctx: any) => mountedApp(ctx, {
  id: 'board',
  names: ['agent-kanban'],
  marker: 'lib/routes.mjs',
  dirEnv: 'WOS_BOARD_DIR',
  defineTools: 'lib/mcp.mjs',
  session: { me: { id: 'you', name: 'the person signed in', role: 'owner' }, isOwner: true },
  requestedWith: 'agent-kanban',
  missing: 'The board is not installed on this server. Set WOS_BOARD_DIR to a checkout of warOnSaaS/agent-kanban (with npm install run in it).',
  async handler(dir: string, ctx: any, base: string) {
    const { routeBoard } = await import(`${dir}/lib/routes.mjs`);
    const { Workspace } = await import(`${dir}/lib/workspace.mjs`);
    const store = await import(`${dir}/lib/store.mjs`);
    const name = ctx.env('WOS_BOARD_NAME') || 'Team board';
    let ws: any;
    let mode = 'demo';
    if (ctx.env('WOS_BOARD_WORKSPACE_DIR')) { ws = new Workspace(new store.FsStore(ctx.env('WOS_BOARD_WORKSPACE_DIR')), { name, demo: true }); mode = 'dir'; }
    else if (ctx.env('WOS_BOARD_REPO')) { ws = new Workspace(new store.GitHubStore({ repo: ctx.env('WOS_BOARD_REPO'), token: ctx.env('WOS_BOARD_GITHUB_TOKEN'), branch: 'main' }), { name, demo: true }); mode = 'repo'; }
    else ws = new Workspace(new store.DemoStore(`${dir}/example-workspace`), { name, demo: true });
    const host = `${ctx.publicUrl}${base}`;
    return { handler: async (req: any, res: any) => { if (!(await routeBoard(req, res, ws, host))) res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); }, mode };
  },
});
