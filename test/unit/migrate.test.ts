// Migrations run each file whole, so triggers and function bodies survive; each runs once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCore } from './helpers.ts';
import { migrate } from '../../core/migrate.ts';

test('a trigger (SQLite) or a $$ function (Postgres) in a migration is applied intact, once', async () => {
  const core = await makeCore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wos-mig-'));
  fs.writeFileSync(path.join(dir, '0001_init.sql'), `-- notes; with a semicolon in a comment
CREATE TABLE IF NOT EXISTS demo_items (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, name TEXT NOT NULL, changes INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS demo_log (item_id TEXT, note TEXT);`);
  fs.writeFileSync(path.join(dir, '0002_log.sqlite.sql'), `CREATE TRIGGER demo_items_log AFTER UPDATE ON demo_items BEGIN
  INSERT INTO demo_log (item_id, note) VALUES (NEW.id, 'changed; again');
  UPDATE demo_items SET changes = changes + 0 WHERE id = NEW.id;
END;`);
  fs.writeFileSync(path.join(dir, '0002_log.postgres.sql'), `CREATE OR REPLACE FUNCTION demo_log_fn() RETURNS trigger AS $$
BEGIN
  INSERT INTO demo_log (item_id, note) VALUES (NEW.id, 'changed; again');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER demo_items_log AFTER UPDATE ON demo_items FOR EACH ROW EXECUTE FUNCTION demo_log_fn();`);
  assert.deepEqual(await migrate(core.db, 'demo', dir), ['0001_init', '0002_log']);
  assert.deepEqual(await migrate(core.db, 'demo', dir), [], 'nothing runs twice');
  await core.db.run('INSERT INTO demo_items (id, team_id, name) VALUES (?, ?, ?)', ['i1', 't1', 'One']);
  await core.db.run('UPDATE demo_items SET name = ? WHERE id = ?', ['Uno', 'i1']);
  const log = await core.db.query<any>('SELECT * FROM demo_log');
  assert.equal(log.length, 1);
  assert.equal(log[0].note, 'changed; again');
  await core.stop();
});
