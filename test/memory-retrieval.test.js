// Scenarios 25-29. Retrieval is observed through `prepareAddressedTurn`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClock } from './helpers/clock.js';
import { createMemoryFixture, claimBatch, triggerOf } from './helpers/memory-fixture.js';
import { observation } from './helpers/messages.js';

const ALEX = { kind: 'phone', value: '31600000001@s.whatsapp.net' };
const QUIRIJN = { kind: 'phone', value: '31600000002@s.whatsapp.net' };

/** Stores one claim about the sender of the given message and returns nothing. */
async function rememberClaim(fixture, { id, text, claimText, senderAlias = ALEX, senderLabel = 'Alex' }) {
  fixture.setExtraction((packet) => claimBatch(packet, claimText));
  await fixture.completeTurn({ id, text, senderAlias, senderLabel });
  fixture.setExtraction(() => ({ memories: [] }));
}

/**
 * Probes retrieval from a fresh conversation, so the only retrieval keywords
 * are the ones in the probe itself rather than the source message that created
 * the memory.
 */
async function retrieveFor(fixture, overrides) {
  const observed = await fixture.memory.observeMessage(
    observation({ address: `probe-${overrides.id}@s.whatsapp.net`, ...overrides })
  );
  const context = await fixture.memory.prepareAddressedTurn(observed.addressedTurnId);
  return context.retrievedMemory;
}

test('25. normalizes Unicode and punctuation deterministically during retrieval', async (t) => {
  const clock = createClock();
  const fixture = createMemoryFixture({ clock });
  t.after(() => fixture.memory.close());

  await rememberClaim(fixture, {
    id: 'U-1',
    text: 'ik hang altijd in het Cooldown Café rond',
    claimText: 'Hangt altijd rond in het Cooldown Café',
  });

  clock.advance(1000);
  // Written without the diacritic and with heavy punctuation: still matches.
  const retrieved = await retrieveFor(fixture, {
    id: 'U-2',
    text: '...COOLDOWN, cafe!!! (weer?)',
    senderAlias: ALEX,
  });

  assert.ok(retrieved, 'normalization folds diacritics, case and punctuation');
  assert.equal(retrieved.text, 'Hangt altijd rond in het Cooldown Café');
});

test('26. removes the fixed Dutch-and-English stop words and ignores tokens shorter than three characters', async (t) => {
  const clock = createClock();
  const fixture = createMemoryFixture({ clock });
  t.after(() => fixture.memory.close());

  await rememberClaim(fixture, {
    id: 'S-1',
    text: 'ik ga met de fiets naar Utrecht',
    claimText: 'Gaat met de fiets naar Utrecht',
  });

  clock.advance(1000);
  // Only stop words and short tokens overlap, so nothing is eligible.
  const stopWordsOnly = await retrieveFor(fixture, {
    id: 'S-2',
    text: 'ik ga met de en ik zo op te',
    senderAlias: ALEX,
  });
  assert.equal(stopWordsOnly, null, 'stop words and short tokens carry no relevance');

  clock.advance(1000);
  const contentWord = await retrieveFor(fixture, { id: 'S-3', text: 'utrecht dan maar', senderAlias: ALEX });
  assert.ok(contentWord, 'a real content word makes the memory eligible');
});

test('27. enforces participant association and minimum keyword overlap', async (t) => {
  const clock = createClock();
  const fixture = createMemoryFixture({ clock });
  t.after(() => fixture.memory.close());

  await rememberClaim(fixture, {
    id: 'A-1',
    text: 'ik verzamel Buzzballz blikjes',
    claimText: 'Verzamelt Buzzballz blikjes',
    senderAlias: ALEX,
    senderLabel: 'Alex',
  });

  clock.advance(1000);
  // Quirijn shares the keyword but is not associated with Alex's claim.
  const unrelatedParticipant = await retrieveFor(fixture, {
    id: 'A-2',
    text: 'wie heeft er nog Buzzballz',
    senderAlias: QUIRIJN,
    senderLabel: 'Quirijn',
  });
  assert.equal(unrelatedParticipant, null, 'a memory needs an associated relevant participant');

  clock.advance(1000);
  // Alex, but nothing in common with the stored claim.
  const noOverlap = await retrieveFor(fixture, {
    id: 'A-3',
    text: 'wanneer vertrekt de trein precies',
    senderAlias: ALEX,
  });
  assert.equal(noOverlap, null, 'at least one shared keyword is required');

  clock.advance(1000);
  const eligible = await retrieveFor(fixture, { id: 'A-4', text: 'nog Buzzballz over?', senderAlias: ALEX });
  assert.ok(eligible);
  assert.equal(eligible.category, 'participant_claim');
});

test('28. ranks eligible memories deterministically and returns no more than one', async (t) => {
  const clock = createClock();
  const fixture = createMemoryFixture({ clock });
  t.after(() => fixture.memory.close());

  await rememberClaim(fixture, {
    id: 'R-1',
    text: 'ik drink Buzzballz',
    claimText: 'Drinkt Buzzballz',
  });
  clock.advance(60_000);
  await rememberClaim(fixture, {
    id: 'R-2',
    text: 'ik drink Buzzballz op de borrel',
    claimText: 'Drinkt Buzzballz op de borrel',
  });

  clock.advance(1000);
  const retrieved = await retrieveFor(fixture, {
    id: 'R-3',
    text: 'Buzzballz op de borrel weer?',
    senderAlias: ALEX,
  });

  assert.ok(retrieved);
  // Higher distinct keyword overlap wins; only one memory is ever returned.
  assert.equal(retrieved.text, 'Drinkt Buzzballz op de borrel');
  assert.ok(Array.isArray(retrieved.participantIds));
  assert.ok(retrieved.participantIds.length <= 4);

  clock.advance(1000);
  // Equal overlap: the newest relevant record wins.
  const newest = await retrieveFor(fixture, { id: 'R-4', text: 'drinkt Buzzballz?', senderAlias: ALEX });
  assert.equal(newest.text, 'Drinkt Buzzballz op de borrel');
});

test('29. returns no memory when no record is eligible', async (t) => {
  const clock = createClock();
  const fixture = createMemoryFixture({ clock });
  t.after(() => fixture.memory.close());

  const empty = await retrieveFor(fixture, { id: 'N-1', text: 'volledig leeg geheugen', senderAlias: ALEX });
  assert.equal(empty, null);

  await rememberClaim(fixture, {
    id: 'N-2',
    text: 'ik speel FlunkyBal',
    claimText: 'Speelt FlunkyBal',
  });

  clock.advance(1000);
  const nothingRelevant = await retrieveFor(fixture, {
    id: 'N-3',
    text: 'heeft iemand een oplader voor mijn telefoon',
    senderAlias: ALEX,
  });
  assert.equal(nothingRelevant, null, 'nothing sufficiently relevant means no forced callback');
});
