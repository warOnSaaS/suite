// Migrations apply themselves when the server starts (and when an app is first turned on).
// Each scope (core, or an app id) has a folder of NNNN_label.sql files; applied ones are recorded in wos_migrations.
import fs from 'node:fs';
import path from 'node:path';
import { migrationOrder } from '../packages/manifest/index.mjs';
import type { Database } from './db.ts';

export async function migrate(db: Database, scope: string, dir: string, log: (s: string) => void = () => {}) {
  await db.run('CREATE TABLE IF NOT EXISTS wos_migrations (scope TEXT NOT NULL, id TEXT NOT NULL, applied_at TEXT NOT NULL, PRIMARY KEY (scope, id))');
  if (!fs.existsSync(dir)) return [];
  const done = new Set((await db.query<{ id: string }>('SELECT id FROM wos_migrations WHERE scope = ?', [scope])).map((r) => r.id));
  const applied: string[] = [];
  for (const { id, file } of migrationOrder(fs.readdirSync(dir), db.dialect)) {
    if (done.has(id)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await db.tx(async (t) => {
      // The whole file in one call (SQLite exec, Postgres simple query), so triggers, BEGIN...END blocks and
      // $$-quoted function bodies arrive intact.
      await t.run(sql);
      await t.run('INSERT INTO wos_migrations (scope, id, applied_at) VALUES (?, ?, ?)', [scope, id, new Date().toISOString()]);
    });
    applied.push(id);
    log(`migrated ${scope} ${id}`);
  }
  return applied;
}

// Split on semicolons outside quotes and comments. Enough for the plain DDL migrations use.
// Kept for tools that need statements one by one; migrations run whole files.
export function splitSql(sql: string) {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (!q && ch === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; cur += '\n'; continue; }
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
