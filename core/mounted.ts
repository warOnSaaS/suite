// The shared server part of a mounted app (see core/mount.ts). Each mounted app passes where to find the
// package and how to build its request handler.
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { findApp, toolsFrom, inProcess, mountResponse, staticFrom } from './mount.ts';
import type { ToolSpec } from './types.ts';

interface Spec {
  id: string;
  names: string[];
  marker: string;
  dirEnv: string;
  defineTools: string;
  session: unknown;
  requestedWith: string;
  publicDir?: string;
  missing: string;
  handler(dir: string, ctx: any, base: string): Promise<{ handler: (req: IncomingMessage, res: ServerResponse) => unknown; mode: string }>;
}

export async function mountedApp(ctx: any, s: Spec) {
  const base = `/m/${s.id}`;
  const dir = findApp(ctx.env(s.dirEnv), s.names, s.marker);
  // Without the package the app is listed but cannot be turned on; its tools.json snapshot still documents it.
  if (!dir) return { handlers: {}, unavailable: s.missing };
  const { handler, mode } = await s.handler(dir, ctx, base);
  const tools: ToolSpec[] = await toolsFrom(dir, s.id, s.defineTools, s.session);
  const handlers: Record<string, (input: any) => Promise<unknown>> = {};
  for (const t of tools) {
    const original = t.name.slice(s.id.length + 1);
    handlers[t.name] = async (input: any) => {
      const r = await inProcess(handler, 'POST', `/v1/${original}`, input ?? {}, { 'x-requested-with': s.requestedWith, accept: 'application/json' });
      let j: any = {};
      try { j = JSON.parse(r.text); } catch { j = { error: r.text.slice(0, 300) }; }
      if (r.status >= 400) throw new Error(typeof j.error === 'string' ? j.error : j.error?.message ?? `The ${s.id} answered ${r.status}.`);
      return { result: j.result ?? j };
    };
  }
  // Keep the committed snapshot in step with the installed package (documentation and the catalogue test).
  try {
    const snap = path.join(ctx.dir, 'tools.json');
    const cur = JSON.parse(fs.readFileSync(snap, 'utf8'));
    if (JSON.stringify(cur.tools.map((t: ToolSpec) => t.name)) !== JSON.stringify(tools.map((t) => t.name))) ctx.log.warn(`installed ${s.id} has different tools than apps-builtin/${s.id}/tools.json; run npm run gen:mounts`);
  } catch {}
  ctx.log.info(`mounted from ${dir} (${mode})`);
  return {
    handlers,
    tools,
    mode,
    dir,
    mount(req: IncomingMessage, res: ServerResponse, url: URL) {
      const sub = url.pathname.slice(base.length) || '/';
      if (s.publicDir && /^\/(ui|app)\//.test(sub) && staticFrom(path.join(dir, s.publicDir), sub, res, base)) return;
      req.url = sub + url.search;
      return handler(req, mountResponse(res, base));
    },
  };
}
