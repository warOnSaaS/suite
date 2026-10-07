// Events: what happened, for the team's live screens and for other apps. Stored for a while so a screen
// that polls (the reduced Vercel mode) or reconnects can catch up. Between server copies on Postgres,
// LISTEN/NOTIFY carries them; one SQLite server needs nothing.
import type { Database } from './db.ts';
import type { Actor } from './types.ts';
import { id, now, parse } from './util.ts';

export interface WosEvent { id: string; team_id: string; name: string; data: any; actor?: Pick<Actor, 'kind' | 'id' | 'name'>; at: string; to?: string }

type Fn = (e: WosEvent) => void | Promise<void>;
const SERVER = id('srv');

export class Events {
  db: Database;
  private subs = new Map<string, Set<Fn>>();
  private teamSubs = new Map<string, Set<Fn>>();
  private log: (s: string) => void;

  constructor(db: Database, log: (s: string) => void = () => {}) {
    this.db = db;
    this.log = log;
  }

  async start() {
    if (this.db.listen) {
      await this.db.listen('wos_events', (payload) => {
        const p = parse<{ s: string; e: WosEvent }>(payload, null as any);
        if (p && p.s !== SERVER) this.deliver(p.e);
      });
    }
    // Keep two weeks of events.
    await this.db.run('DELETE FROM events WHERE at < ?', [new Date(Date.now() - 14 * 864e5).toISOString()]).catch(() => {});
  }

  /** `to` limits live delivery to one person (their conversation stream, their alerts). */
  /** Event handlers still running. Serverless hosts freeze a function once its response is sent, so the
   *  request waits for these first (see idle()); otherwise an answer could resume an agent only half way. */
  private inflight = new Set<Promise<void>>();
  async idle(maxMs = 20000) {
    const until = Date.now() + maxMs;
    while (this.inflight.size && Date.now() < until) await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => setTimeout(r, Math.max(0, until - Date.now())))]);
  }

  publish(teamId: string, name: string, data: unknown = {}, actor?: Actor, to?: string) {
    const e: WosEvent = { id: id('ev'), team_id: teamId, name, data, actor: actor ? { kind: actor.kind, id: actor.id, name: actor.name } : undefined, at: now(), to };
    // Streaming deltas are live only; everything else is stored.
    if (!name.endsWith('.delta')) {
      this.db.run('INSERT INTO events (id, team_id, name, data, actor_kind, actor_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)', [e.id, teamId, name, JSON.stringify({ d: data, to, an: actor?.name }), actor?.kind ?? null, actor?.id ?? null, e.at]).catch((err) => this.log(`event store: ${err.message}`));
    }
    this.db.notify?.('wos_events', JSON.stringify({ s: SERVER, e })).catch(() => {});
    this.deliver(e);
    return e;
  }

  private deliver(e: WosEvent) {
    for (const [pattern, fns] of this.subs) {
      if (pattern === e.name || (pattern.endsWith('.*') && e.name.startsWith(pattern.slice(0, -1))) || pattern === '*') {
        for (const fn of fns) {
          const job: Promise<void> = Promise.resolve().then(() => fn(e)).catch((err) => this.log(`event handler ${pattern}: ${err.message}`)).finally(() => this.inflight.delete(job));
          this.inflight.add(job);
        }
      }
    }
    for (const fn of this.teamSubs.get(e.team_id) ?? []) { try { fn(e); } catch {} }
  }

  on(name: string, fn: Fn) {
    if (!this.subs.has(name)) this.subs.set(name, new Set());
    this.subs.get(name)!.add(fn);
    return () => { this.subs.get(name)?.delete(fn); };
  }

  /** Live feed for one team (the WebSocket uses this). */
  onTeam(teamId: string, fn: Fn) {
    if (!this.teamSubs.has(teamId)) this.teamSubs.set(teamId, new Set());
    this.teamSubs.get(teamId)!.add(fn);
    return () => { this.teamSubs.get(teamId)?.delete(fn); };
  }

  /** Stored events after a cursor (an event id's time), for polling screens. */
  async since(teamId: string, after: string | undefined, personId: string, limit = 200): Promise<WosEvent[]> {
    const rows = await this.db.query<any>('SELECT * FROM events WHERE team_id = ? AND at > ? ORDER BY at ASC LIMIT ?', [teamId, after || new Date(Date.now() - 60_000).toISOString(), limit]);
    return rows
      .map((r) => {
        const x = parse<any>(r.data, {});
        return { id: r.id, team_id: r.team_id, name: r.name, data: x.d, to: x.to, actor: r.actor_kind ? { kind: r.actor_kind, id: r.actor_id, name: x.an } : undefined, at: r.at } as WosEvent;
      })
      .filter((e) => !e.to || e.to === personId);
  }
}
