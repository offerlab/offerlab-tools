/**
 * A D1-shaped handle over Node's built-in SQLite, for the Express dev server.
 *
 * shared/db.js is written against the D1 client API (prepare/bind/first/all/run/batch). In
 * production that is the `DB` binding; locally this wraps `node:sqlite` in the same subset, so
 * the store runs unchanged against a file on disk. Node 22.5+ ships node:sqlite behind an
 * experimental warning; nothing else is needed.
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// node:sqlite binds null, number, bigint, string and Uint8Array. D1 also takes booleans and
// treats undefined as null; keep that contract so the store does not have to care.
function bindable(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function statement(db, sql, params) {
  const run = () => db.prepare(sql).run(...params);
  return {
    bind: (...next) => statement(db, sql, next.map(bindable)),
    async first(column) {
      const row = db.prepare(sql).get(...params) ?? null;
      if (column === undefined) return row;
      return row ? row[column] ?? null : null;
    },
    async all() {
      const results = db.prepare(sql).all(...params);
      return { results, success: true, meta: { rows_read: results.length } };
    },
    async run() {
      const info = run();
      return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
    },
    _run: run
  };
}

/** Opens (or creates) the database file and returns a D1-shaped client. */
export function openLocalD1(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return {
    prepare: (sql) => statement(db, sql, []),
    // D1 runs a batch as one transaction: all of it lands or none of it does.
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = statements.map(s => {
          const info = s._run();
          return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
        });
        db.exec('COMMIT');
        return results;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    async exec(sql) {
      db.exec(sql);
    },
    close: () => db.close()
  };
}

/**
 * Applies the SQL files in `dir` that have not run yet, in name order, recording each in the
 * same d1_migrations table wrangler uses, so the local file and `wrangler d1 migrations apply`
 * agree on what has been applied.
 */
export async function applyMigrations(client, dir) {
  await client.exec(
    'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)'
  );
  const { results } = await client.prepare('SELECT name FROM d1_migrations').all();
  const applied = new Set(results.map(row => row.name));
  const files = readdirSync(dir).filter(name => name.endsWith('.sql')).sort();
  const ran = [];
  for (const name of files) {
    if (applied.has(name)) continue;
    await client.exec(readFileSync(join(dir, name), 'utf8'));
    await client.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(name).run();
    ran.push(name);
  }
  return ran;
}
