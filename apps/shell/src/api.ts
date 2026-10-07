// The only way the screens talk to the server: callTool() posts to /api/tools/<name>, the same handler
// agents use over MCP. Live events come over the /live socket, or from events.poll when there is none.

export class ToolError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) { super(message); this.code = code; this.status = status; }
}

let teamId: string | null = null;
export const setTeam = (id: string | null) => { teamId = id; };

export async function callTool<T = any>(name: string, input: unknown = {}): Promise<T> {
  const r = await fetch(`/api/tools/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-wos': '1', ...(teamId ? { 'x-wos-team': teamId } : {}) },
    body: JSON.stringify(input ?? {}),
    credentials: 'same-origin',
  });
  if (r.status === 401) { location.href = `/auth/sign-in?next=${encodeURIComponent(location.pathname)}`; throw new ToolError('sign_in', 'Sign in again.', 401); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 202) return { pending: j.pending } as T;
  if (!r.ok) throw new ToolError(j.error?.code ?? 'error', j.error?.message ?? `Something went wrong (${r.status}).`, r.status);
  return j.result as T;
}

// ---------- live events ----------

export interface LiveEvent { id?: string; name: string; data: any; at: string; actor?: { kind: string; id: string; name: string } }
type Fn = (e: LiveEvent) => void;
const subs = new Map<string, Set<Fn>>();
let started = false;
let since = new Date().toISOString();

export function on(name: string, fn: Fn) {
  if (!subs.has(name)) subs.set(name, new Set());
  subs.get(name)!.add(fn);
  return () => { subs.get(name)?.delete(fn); };
}

function deliver(e: LiveEvent) {
  if (e.at && e.at > since && !e.name.endsWith('.delta')) since = e.at;
  for (const [pattern, fns] of subs) {
    if (pattern === e.name || pattern === '*' || (pattern.endsWith('.*') && e.name.startsWith(pattern.slice(0, -1)))) for (const fn of fns) { try { fn(e); } catch (err) { console.error(err); } }
  }
}

export function startLive(opts: { socket: boolean }) {
  if (started) return;
  started = true;
  if (!opts.socket) return poll();
  let tries = 0;
  const connect = () => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/live${teamId ? `?team=${encodeURIComponent(teamId)}` : ''}`);
    ws.onmessage = (m) => { try { deliver(JSON.parse(m.data)); } catch {} };
    ws.onopen = () => { tries = 0; deliver({ name: 'live.connected', data: {}, at: '' }); };
    ws.onclose = () => {
      deliver({ name: 'live.disconnected', data: {}, at: '' });
      if (++tries > 4) return poll();
      setTimeout(connect, Math.min(10000, 800 * 2 ** tries));
    };
  };
  connect();
}

// Serverless hosts have no socket: ask for what changed every few seconds while the page is visible.
function poll() {
  const tick = async () => {
    if (document.visibilityState === 'visible') {
      try {
        const r = await callTool<{ now: string; events: LiveEvent[] }>('events.poll', { since });
        for (const e of r.events) deliver(e);
        if (r.now > since) since = r.now;
      } catch {}
    }
    setTimeout(tick, document.visibilityState === 'visible' ? 2000 : 8000);
  };
  tick();
}
