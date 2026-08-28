// Scenarios 13-16.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SEVEN_DAYS_MS } from '../memory/index.js';
import { createClock } from './helpers/clock.js';
import { createMemoryFixture, claimBatch } from './helpers/memory-fixture.js';
import { observation } from './helpers/messages.js';

test('13. prunes messages older than seven days while preserving the exact-boundary case', async (t) => {
  const clock = createClock();
  const { memory } = createMemoryFixture({ clock });
  t.after(() => memory.close());

  const start = clock.now();
  await memory.observeMessage(observation({ id: 'OLD', text: 'ver verleden', addressed: false }));
  clock.advance(1);
  await memory.observeMessage(observation({ id: 'BOUNDARY', text: 'precies op de grens', addressed: false }));
  assert.equal(memory.inspect.messageCount(), 2);

  // BOUNDARY sits exactly seven days back, OLD one millisecond further.
  clock.set(start + 1 + SEVEN_DAYS_MS);
  memory.inspect.prune();

  assert.equal(memory.inspect.messageCount(), 1, 'only the strictly older message expired');

  clock.advance(1);
  memory.inspect.prune();
  assert.equal(memory.inspect.messageCount(), 0, 'the boundary message expires at a later opportunity');
});

test('14. preserves durable memories and evidence snapshots after temporary-message pruning', async (t) => {
  const clock = createClock();
  const fixture = createMemoryFixture({ clock });
  const { memory } = fixture;
  t.after(() => memory.close());

  fixture.setExtraction((packet) => claimBatch(packet, 'Drinkt alleen nog Buzzballz'));
  await fixture.completeTurn({ id: 'K-1', text: 'ik drink alleen nog Buzzballz' });

  assert.equal(memory.inspect.claims().length, 1);
  const evidenceBefore = memory.inspect.evidenceCount();
  assert.ok(evidenceBefore > 0);

  clock.advance(SEVEN_DAYS_MS * 2);
  memory.inspect.prune();

  assert.equal(memory.inspect.messageCount(), 0, 'temporary messages expired');
  assert.equal(memory.inspect.claims().length, 1, 'the durable memory survives');
  assert.equal(memory.inspect.evidenceCount(), evidenceBefore, 'its evidence snapshot survives');
  assert.equal(memory.inspect.turnOutcomes().length, 1, 'turn outcomes do not expire');
});

test('15. keeps memories append-only and treats exact duplicates as successful no-ops', async (t) => {
  const clock = createClock();
  const fixture = createMemoryFixture({ clock });
  const { memory } = fixture;
  t.after(() => memory.close());

  fixture.setExtraction((packet) => claimBatch(packet, 'Drinkt alleen nog Buzzballz'));

  const first = await fixture.completeTurn({ id: 'D-1', text: 'ik drink alleen nog Buzzballz' });
  clock.advance(1000);
  const second = await fixture.completeTurn({ id: 'D-2', text: 'ik drink alleen nog Buzzballz' });

  assert.equal(memory.inspect.claims().length, 1, 'an exact duplicate writes nothing new');
  assert.equal(memory.inspect.runState(first.addressedTurnId), 'succeeded');
  assert.equal(memory.inspect.runState(second.addressedTurnId), 'succeeded', 'a duplicate is a success');

  // Append-only: a different claim is added rather than replacing the first.
  clock.advance(1000);
  fixture.setExtraction((packet) => claimBatch(packet, 'Rookt binnen bij het Cooldown Cafe'));
  await fixture.completeTurn({ id: 'D-3', text: 'ik rook binnen bij het Cooldown Cafe' });

  const texts = memory.inspect.claims().map((claim) => claim.text).sort();
  assert.deepEqual(texts, ['Drinkt alleen nog Buzzballz', 'Rookt binnen bij het Cooldown Cafe']);
});

test('16. preserves contradictory memories and their provenance', async (t) => {
  const clock = createClock();
  const fixture = createMemoryFixture({ clock });
  const { memory } = fixture;
  t.after(() => memory.close());

  fixture.setExtraction((packet) => claimBatch(packet, 'Drinkt nooit meer alcohol'));
  await fixture.completeTurn({ id: 'X-1', text: 'ik drink nooit meer alcohol' });

  clock.advance(60_000);
  fixture.setExtraction((packet) => claimBatch(packet, 'Drinkt elke vrijdag Buzzballz'));
  await fixture.completeTurn({ id: 'X-2', text: 'ik drink elke vrijdag Buzzballz' });

  const claims = memory.inspect.claims();
  assert.equal(claims.length, 2, 'contradictory memories coexist rather than being reconciled');
  // Retrieval may prefer the newer relevant record; both keep their provenance.
  assert.equal(claims[0].text, 'Drinkt elke vrijdag Buzzballz');
  for (const claim of claims) {
    assert.ok(claim.reporterParticipantId, 'each memory keeps its reporter');
    assert.ok(claim.createdAt);
  }
});
