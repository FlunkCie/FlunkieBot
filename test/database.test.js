// Scenarios 1-5. Focused low-level verification is permitted only for
// migrations and database constraints, whose behaviour cannot be diagnosed
// reliably through a higher seam.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { openDatabase, BUSY_TIMEOUT_MS, DatabaseStartupError } from '../memory/database.js';
import { MIGRATIONS, LATEST_SCHEMA_VERSION } from '../memory/migrations.js';
import { createMemory } from '../memory/index.js';
import { temporaryDatabasePath } from './helpers/temp-database.js';
import { createClock } from './helpers/clock.js';
import { observation } from './helpers/messages.js';

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
}

test('1. creates an empty database with all required configuration and constraints', () => {
  const path = temporaryDatabasePath();
  const db = openDatabase({ path });

  assert.equal(db.pragma('user_version', { simple: true }), LATEST_SCHEMA_VERSION);

  const tables = tableNames(db);
  for (const required of [
    'participants',
    'participant_aliases',
    'participant_redirects',
    'conversations',
    'messages',
    'participant_claims',
    'episodes',
    'interaction_patterns',
    'extraction_runs',
    'turn_outcomes',
    'evidence_snapshots',
  ]) {
    assert.ok(tables.includes(required), `expected table ${required}`);
  }

  // The database starts empty: no messages and no durable memories.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM participant_claims').get().n, 0);

  // Idempotent observation, typed alias uniqueness, permanent redirects, one
  // extraction run per addressed message, and valid evidence relationships are
  // enforced by constraints rather than by callers.
  db.prepare('INSERT INTO participants (id, created_at) VALUES (?, ?)').run('p-a', 1);
  db.prepare(
    'INSERT INTO conversations (address, kind, label, created_at) VALUES (?, ?, ?, ?)'
  ).run('c@g.us', 'group', 'FlunkCie', 1);

  const insertMessage = db.prepare(
    `INSERT INTO messages
       (conversation_id, participant_id, whatsapp_message_id, direction, observed_at, addressed, body, author_label)
     VALUES (1, 'p-a', 'W1', 'incoming', 1, 1, 'hoi', 'Alex')`
  );
  insertMessage.run();
  assert.throws(() => insertMessage.run(), /UNIQUE/);

  const insertAlias = db.prepare(
    `INSERT INTO participant_aliases (alias_kind, alias_value, participant_id, created_at)
     VALUES ('phone', '316@s.whatsapp.net', 'p-a', 1)`
  );
  insertAlias.run();
  assert.throws(() => insertAlias.run(), /UNIQUE/);

  const insertRun = db.prepare(
    `INSERT INTO extraction_runs
       (message_id, conversation_id, whatsapp_message_id, state, created_at, updated_at)
     VALUES (1, 1, 'W1', 'pending', 1, 1)`
  );
  insertRun.run();
  assert.throws(() => insertRun.run(), /UNIQUE/);

  // Evidence must belong to exactly one durable memory.
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO evidence_snapshots
             (claim_id, episode_id, interaction_pattern_id, conversation_id,
              whatsapp_message_id, observed_at, reporter_participant_id, excerpt)
           VALUES (NULL, NULL, NULL, 1, 'W1', 1, 'p-a', 'hoi')`
        )
        .run(),
    /CHECK/
  );

  // Foreign keys are enforced, not merely declared.
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO participant_claims
             (subject_participant_id, reporter_participant_id, body, normalized_body,
              occurred_at, created_at, duplicate_key)
           VALUES ('does-not-exist', 'does-not-exist', 'x', 'x', NULL, 1, 'k')`
        )
        .run(),
    /FOREIGN KEY/
  );

  db.close();
});

test('2. preserves records across database closure and application restart', async () => {
  const path = temporaryDatabasePath();
  const clock = createClock();

  const first = createMemory({ dbPath: path, clock: clock.now });
  await first.start();
  const observed = await first.observeMessage(observation({ id: 'W-restart', text: 'ik drink alleen Buzzballz' }));
  assert.ok(observed.addressedTurnId);
  first.close();

  const second = createMemory({ dbPath: path, clock: clock.now });
  await second.start();
  assert.equal(second.inspect.messageCount(), 1);
  const context = await second.prepareAddressedTurn(observed.addressedTurnId);
  assert.equal(context.messageToAnswer.text, 'ik drink alleen Buzzballz');
  second.close();
});

test('3. applies ordered migrations and rolls back a failed migration atomically', () => {
  const path = temporaryDatabasePath();
  const applied = [];

  const migrations = [
    {
      version: 1,
      name: 'first',
      up(db) {
        applied.push(1);
        db.exec('CREATE TABLE alpha (id INTEGER PRIMARY KEY)');
      },
    },
    {
      version: 2,
      name: 'second-fails-halfway',
      up(db) {
        applied.push(2);
        db.exec('CREATE TABLE beta (id INTEGER PRIMARY KEY)');
        throw new Error('deliberate migration failure');
      },
    },
  ];

  assert.throws(() => openDatabase({ path, migrations }), DatabaseStartupError);
  // Ordered: the first migration ran before the second.
  assert.deepEqual(applied, [1, 2]);

  const db = new Database(path);
  const tables = tableNames(db);
  assert.ok(tables.includes('alpha'), 'the committed migration survives');
  assert.ok(!tables.includes('beta'), 'the failed migration rolled back completely');
  assert.equal(db.pragma('user_version', { simple: true }), 1);
  db.close();
});

test('4. enables foreign keys, WAL mode and the configured busy timeout', () => {
  const db = openDatabase({ path: temporaryDatabasePath() });
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('busy_timeout', { simple: true }), BUSY_TIMEOUT_MS);
  db.close();
});

test('5. refuses an unknown newer schema version', () => {
  const path = temporaryDatabasePath();
  const db = openDatabase({ path });
  db.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 7}`);
  db.close();

  assert.throws(
    () => openDatabase({ path, migrations: MIGRATIONS }),
    (err) =>
      err instanceof DatabaseStartupError && /newer than this build understands/.test(err.message)
  );
});
