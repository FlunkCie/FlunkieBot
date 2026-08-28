// Scenarios 52-55 and 58. Deployment configuration and module boundaries are
// verified against the files that ship, entirely offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DB_PATH, createMemory } from '../memory/index.js';
import { temporaryDatabasePath } from './helpers/temp-database.js';
import { createClock } from './helpers/clock.js';
import { observation } from './helpers/messages.js';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (name) => readFileSync(join(ROOT, name), 'utf-8');

/** Every application source file, excluding the memory module and the tests. */
function applicationSourceFiles() {
  const files = [];
  const walk = (relative) => {
    for (const entry of readdirSync(join(ROOT, relative))) {
      const child = relative ? `${relative}/${entry}` : entry;
      if (['node_modules', 'test', 'memory', '.git', 'data', 'auth_info'].includes(entry)) continue;
      if (statSync(join(ROOT, child)).isDirectory()) {
        walk(child);
        continue;
      }
      if (child.endsWith('.js')) files.push(child);
    }
  };
  walk('');
  return files;
}

test('52. verifies the persistent Docker data mount and default database location', () => {
  const compose = read('docker-compose.yml');
  assert.match(compose, /- \.\/data:\/app\/data/, 'the host data directory is mounted into the container');

  // The default database lives inside that mounted directory.
  assert.equal(DEFAULT_DB_PATH, './data/flunkiebot.sqlite');
  assert.match(read('Dockerfile'), /mkdir -p \/app\/data/);

  // The data directory is excluded from version control and the build context.
  assert.match(read('.gitignore'), /^data\/$/m);
  assert.match(read('.dockerignore'), /^data$/m);

  // MEMORY_DB_PATH is the documented configuration point.
  assert.match(read('.env.example'), /MEMORY_DB_PATH/);
  assert.match(read('README.md'), /MEMORY_DB_PATH/);
});

test('53. preserves authentication and read-only personality-prompt mounts', () => {
  const compose = read('docker-compose.yml');
  assert.match(compose, /- \.\/auth_info:\/app\/auth_info/);
  assert.match(compose, /- \.\/system-prompt\.txt:\/app\/system-prompt\.txt:ro/);
  assert.match(read('.dockerignore'), /^auth_info$/m);
});

test('54. verifies removal of the old volatile history configuration', () => {
  assert.ok(!existsSync(join(ROOT, 'history.js')), 'the volatile history implementation is gone');
  assert.ok(!existsSync(join(ROOT, 'llm.js')), 'the old provider orchestrator is gone');

  for (const file of ['.env.example', 'README.md', 'docker-compose.yml', 'package.json']) {
    assert.ok(!read(file).includes('HISTORY_LIMIT'), `${file} still mentions HISTORY_LIMIT`);
  }
  for (const file of applicationSourceFiles()) {
    const source = read(file);
    assert.ok(!source.includes('HISTORY_LIMIT'), `${file} still reads HISTORY_LIMIT`);
    assert.ok(!/from '\.\/history\.js'/.test(source), `${file} still imports history.js`);
  }
});

test('55. confirms that a container restart retains SQLite state', async () => {
  // A container restart is a new process against the same host-mounted database.
  const dbPath = temporaryDatabasePath();
  const clock = createClock();

  const before = createMemory({ dbPath, clock: clock.now });
  await before.start();
  const observed = await before.observeMessage(
    observation({ id: 'RESTART-1', text: 'ik rook binnen bij het Cooldown Cafe' })
  );
  await before.finishAddressedTurn(observed.addressedTurnId, {
    kind: 'reply-sent',
    sentMessage: { whatsappMessageId: 'OUT-1', text: 'Kanker goed.', sentAt: clock.now() },
  });
  const messagesBefore = before.inspect.messageCount();
  before.close();

  const after = createMemory({ dbPath, clock: clock.now });
  await after.start();
  assert.equal(after.inspect.messageCount(), messagesBefore, 'messages survive the restart');
  assert.equal(after.inspect.turnOutcomes().length, 1, 'turn outcomes survive the restart');
  after.close();
});

test('58. confirms that no caller outside the memory module issues SQL or depends on physical storage names', () => {
  const sqlPattern =
    /\b(SELECT\s|INSERT\s+INTO\b|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b|CREATE\s+(TABLE|INDEX)\b|PRAGMA\b)/i;
  const physicalNames = [
    'participant_aliases',
    'participant_redirects',
    'participant_claims',
    'episode_participants',
    'interaction_patterns',
    'evidence_snapshots',
    'extraction_runs',
    'turn_outcomes',
    'alias_pairing_conflicts',
  ];

  const files = applicationSourceFiles();
  assert.ok(files.includes('chat.js') && files.includes('index.js'), 'the boundary scan sees the real sources');

  for (const file of files) {
    const source = read(file);
    assert.ok(!sqlPattern.test(source), `${file} issues SQL outside the memory module`);
    assert.ok(
      !source.includes('better-sqlite3'),
      `${file} opens the database outside the memory module`
    );
    for (const name of physicalNames) {
      assert.ok(!source.includes(name), `${file} depends on the physical storage name "${name}"`);
    }
  }

  // Orchestration builds no prompts, validates no model output and calls no
  // provider adapter directly.
  const chat = read('chat.js');
  assert.ok(!chat.includes('CONTEXT_DATA'), 'chat orchestration constructs no prompt');
  assert.ok(!chat.includes('SILENCE'), 'chat orchestration does not interpret model output');
  assert.ok(!/from '\.\/providers\//.test(chat), 'chat orchestration calls no provider adapter');
  assert.ok(!chat.includes('systemInstruction'));
});
