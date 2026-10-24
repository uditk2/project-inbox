import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

export function openDatabase(path, migrationDir) {
  const connection = new DatabaseSync(path);
  connection.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  connection.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)');
  for (const name of readdirSync(migrationDir).filter(n => n.endsWith('.sql')).sort()) {
    if (connection.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(name)) continue;
    connection.exec('BEGIN');
    try {
      connection.exec(readFileSync(new URL(name, migrationDir), 'utf8'));
      connection.prepare('INSERT INTO schema_migrations VALUES (?)').run(name);
      connection.exec('COMMIT');
    } catch(e) { connection.exec('ROLLBACK'); throw e; }
  }
  const wrap = (sql, values = []) => ({
    bind: (...args) => wrap(sql,args),
    first: async () => connection.prepare(sql).get(...values) || null,
    all: async () => ({ results: connection.prepare(sql).all(...values) }),
    run: async () => ({ success:true, meta:connection.prepare(sql).run(...values) })
  });
  return {
    prepare: sql => wrap(sql),
    batch: async statements => {
      connection.exec('BEGIN');
      try { const results = []; for (const s of statements) results.push(await s.run()); connection.exec('COMMIT'); return results; }
      catch (e) { connection.exec('ROLLBACK'); throw e; }
    },
    close: () => connection.close()
  };
}
