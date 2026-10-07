// One small SQL layer for Postgres (DATABASE_URL) and SQLite (everything else).
// Write `?` placeholders; they become $1, $2 for Postgres. See packages/manifest/README.md for the portable column rules.
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../packages/manifest/index.d.ts';

export type { Db };

export interface Database extends Db {
  close(): Promise<void>;
  /** Postgres only: LISTEN on a channel. SQLite runs in one process and needs none. */
  listen?(channel: string, fn: (payload: string) => void): Promise<void>;
  notify?(channel: string, payload: string): Promise<void>;
  describe: string;
}

const toPg = (sql: string) => {
  let n = 0;
  let out = '';
  let q: string | null = null;
  for (const ch of sql) {
    if (q) { out += ch; if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; out += ch; continue; }
    out += ch === '?' ? `$${++n}` : ch;
  }
  return out;
};

const norm = (v: unknown) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

export async function openDb(env: NodeJS.ProcessEnv = process.env, dataDir = defaultDataDir(env)): Promise<Database> {
  if (env.DATABASE_URL && /^postgres(ql)?:\/\//.test(env.DATABASE_URL)) return openPostgres(env.DATABASE_URL);
  const file = env.WOS_SQLITE_FILE || (env.WOS_DB === 'memory' ? ':memory:' : path.join(dataDir, 'wos.sqlite'));
  return openSqlite(file);
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env) {
  const dir = env.WOS_DATA_DIR || (env.VERCEL ? '/tmp/wos' : path.resolve('.data'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function openSqlite(file: string): Promise<Database> {
  const { DatabaseSync } = await import('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  // node:sqlite is synchronous; a queue keeps transactions from interleaving across awaits.
  let chain: Promise<unknown> = Promise.resolve();
  let inTx = false;
  const self: Database = {
    dialect: 'sqlite',
    describe: file === ':memory:' ? 'SQLite in memory' : `SQLite file ${file}`,
    async query(sql, params = []) {
      if (/^\s*(create|alter|drop)\s/i.test(sql) && !params.length && sql.includes(';')) { db.exec(sql); return []; }
      return db.prepare(sql).all(...(params.map(norm) as any[])) as any[];
    },
    async get(sql, params = []) {
      return db.prepare(sql).get(...(params.map(norm) as any[])) as any;
    },
    async run(sql, params = []) {
      if (!params.length && sql.trim().split(';').filter((s) => s.trim()).length > 1) { db.exec(sql); return { changes: 0 }; }
      const r = db.prepare(sql).run(...(params.map(norm) as any[]));
      return { changes: Number(r.changes) };
    },
    async tx(fn) {
      if (inTx) return fn(self);
      const run = async () => {
        inTx = true;
        db.exec('BEGIN');
        try {
          const out = await fn(self);
          db.exec('COMMIT');
          return out;
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        } finally {
          inTx = false;
        }
      };
      const p = chain.then(run, run);
      chain = p.catch(() => {});
      return p as any;
    },
    async close() { db.close(); },
  };
  return self;
}

async function openPostgres(url: string): Promise<Database> {
  const pg = (await import('pg')).default;
  const ssl = /sslmode=require|neon\.tech|supabase\.co/.test(url) ? { rejectUnauthorized: false } : undefined;
  const pool = new pg.Pool({ connectionString: url, ssl, max: Number(process.env.WOS_PG_POOL || 10) });
  const wrap = (c: { query: (s: string, p?: unknown[]) => Promise<any> }, root: boolean): Db => ({
    dialect: 'postgres',
    async query(sql, params = []) { return (await c.query(toPg(sql), params.map(norm))).rows; },
    async get(sql, params = []) { return (await c.query(toPg(sql), params.map(norm))).rows[0]; },
    async run(sql, params = []) {
      const r = await c.query(params.length ? toPg(sql) : sql, params.map(norm));
      return { changes: Array.isArray(r) ? 0 : r.rowCount ?? 0 };
    },
    async tx(fn) {
      if (!root) return fn(wrap(c, false));
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrap(client, false));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  });
  const base = wrap(pool, true);
  let listener: any = null;
  const handlers = new Map<string, (p: string) => void>();
  return {
    ...base,
    describe: `Postgres at ${new URL(url).hostname}`,
    async close() { await listener?.end().catch(() => {}); await pool.end(); },
    async listen(channel, fn) {
      if (!listener) {
        listener = new pg.Client({ connectionString: url, ssl });
        await listener.connect();
        listener.on('notification', (m: any) => handlers.get(m.channel)?.(m.payload ?? ''));
      }
      handlers.set(channel, fn);
      await listener.query(`LISTEN ${channel}`);
    },
    async notify(channel, payload) {
      await pool.query('SELECT pg_notify($1, $2)', [channel, payload.length > 7900 ? JSON.stringify({ big: true }) : payload]);
    },
  };
}
