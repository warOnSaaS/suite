// Serverless entry (Vercel): the same handle() as the Node server, in reduced mode: no WebSocket (screens poll
// events.poll), no background loop (agents move forward while a screen is open), data in WOS_DATA_DIR or DATABASE_URL.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getCore } from './core.ts';
import { handle } from './http.ts';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const core = await getCore();
  const url = new URL(req.url ?? '/', 'http://x');
  // vercel.json sends every path here as /api/index?__p=<path>; put the real path back.
  const p = url.searchParams.get('__p');
  if (p !== null) {
    url.searchParams.delete('__p');
    req.url = `${p.startsWith('/') ? p : `/${p}`}${url.search}`;
  }
  return handle(core, req, res);
}
