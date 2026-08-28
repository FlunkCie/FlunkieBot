import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, LATEST_SCHEMA_VERSION } from './migrations.js';

export const BUSY_TIMEOUT_MS = 5000;

// A database-open, unknown-newer-schema, or migration failure must be visible
// at startup: FlunkieBot may never degrade into a silent stateless mode.
export class DatabaseStartupError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'DatabaseStartupError';
  }
}

function applyMigrations(db, migrations) {
  const current = db.pragma('user_version', { simple: true });
  const latest = migrations.length
    ? migrations[migrations.length - 1].version
    : 0;

  if (current > latest) {
    throw new DatabaseStartupError(
      `Database schema version ${current} is newer than this build understands ` +
        `(supported up to ${latest}). Refusing to start.`
    );
  }

  for (const migration of migrations) {
    if (migration.version <= current) continue;

    // Each migration is atomic: a throwing `up` rolls back every statement it
    // already ran and leaves user_version untouched.
    const run = db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });

    try {
      run();
    } catch (err) {
      throw new DatabaseStartupError(
        `Migration ${migration.version} (${migration.name}) failed: ${err.message}`,
        { cause: err }
      );
    }
  }
}

export function openDatabase({ path, migrations = MIGRATIONS }) {
  let db;
  try {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    db = new Database(path);
  } catch (err) {
    throw new DatabaseStartupError(
      `Could not open the memory database at ${path}: ${err.message}`,
      { cause: err }
    );
  }

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    applyMigrations(db, migrations);
  } catch (err) {
    db.close();
    throw err instanceof DatabaseStartupError
      ? err
      : new DatabaseStartupError(
          `Could not prepare the memory database at ${path}: ${err.message}`,
          { cause: err }
        );
  }

  return db;
}

export { LATEST_SCHEMA_VERSION };
