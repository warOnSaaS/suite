// The wOS server: one long-running Node process with the core, every enabled app's server part,
// the shell's files, and a WebSocket at /live for instant updates.
//   npm run dev                       SQLite in ./.data, http://localhost:8080
//   DATABASE_URL=postgres://... npm start
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { getCore } from '../../core/core.ts';
import { handle } from '../../core/http.ts';
import { callerFromRequest } from '../../core/auth.ts';

export async function serve(port = Number(process.env.PORT || 8080)) {
  const core = await getCore();
  const server = http.createServer((req, res) => { handle(core, req, res); });
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/live') return socket.destroy();
    if (url.searchParams.get('team')) req.headers['x-wos-team'] = url.searchParams.get('team')!;
    const caller = await callerFromRequest(core, req).catch(() => null);
    if (!caller?.team || !caller.user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const me = caller.user!.id;
      const off = core.events.onTeam(caller.team!.id, (e) => {
        if (e.to && e.to !== me) return;
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e));
      });
      const ping = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); }, 25_000);
      ws.on('close', () => { off(); clearInterval(ping); });
      ws.send(JSON.stringify({ name: 'live.ready', at: new Date().toISOString() }));
    });
  });

  await new Promise<void>((r) => server.listen(port, r));
  const addr = server.address();
  core.log.info(`wOS on ${core.publicUrl} (listening on ${typeof addr === 'object' && addr ? addr.port : port})`);
  const stop = async () => { server.close(); wss.close(); await core.stop(); process.exit(0); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return { server, core };
}

if (import.meta.url === `file://${process.argv[1]}`) serve();
