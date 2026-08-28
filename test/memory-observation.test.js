// Scenarios 6-12. Focused memory tests use only the three-operation memory
// interface, temporary file-backed SQLite databases and injected clocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemory } from '../memory/index.js';
import { extractText, normalizeEnvelope } from '../whatsapp.js';
import { temporaryDatabasePath } from './helpers/temp-database.js';
import { createClock } from './helpers/clock.js';
import { observation } from './helpers/messages.js';

function newMemory(clock) {
  return createMemory({ dbPath: temporaryDatabasePath(), clock: clock.now });
}

test('6. observes ambient and addressed direct and group messages idempotently', async (t) => {
  const clock = createClock();
  const memory = newMemory(clock);
  t.after(() => memory.close());

  const ambient = await memory.observeMessage(
    observation({
      address: 'flunkcie@g.us',
      kind: 'group',
      id: 'G-1',
      addressed: false,
      text: 'gewoon geouwehoer',
    })
  );
  assert.equal(ambient.addressedTurnId, null, 'an ambient group message creates no addressed turn');

  const tagged = await memory.observeMessage(
    observation({ address: 'flunkcie@g.us', kind: 'group', id: 'G-2', addressed: true, text: 'oi bot' })
  );
  assert.ok(tagged.addressedTurnId, 'a tagged group message creates an addressed turn');

  const direct = await memory.observeMessage(observation({ id: 'D-1', text: 'hoi' }));
  assert.ok(direct.addressedTurnId, 'every direct message addresses FlunkieBot');

  // Replaying a WhatsApp message returns its existing records and never
  // duplicates the message or its addressed turn.
  const replayedAmbient = await memory.observeMessage(
    observation({ address: 'flunkcie@g.us', kind: 'group', id: 'G-1', addressed: false, text: 'gewoon geouwehoer' })
  );
  const replayedTagged = await memory.observeMessage(
    observation({ address: 'flunkcie@g.us', kind: 'group', id: 'G-2', addressed: true, text: 'oi bot' })
  );

  assert.deepEqual(replayedAmbient, ambient);
  assert.deepEqual(replayedTagged, tagged);
  assert.equal(memory.inspect.messageCount(), 3);
  assert.equal(memory.inspect.pendingRuns().length, 2);
});

test('7. observes supported text, image captions and video captions', async (t) => {
  const clock = createClock();
  const memory = newMemory(clock);
  t.after(() => memory.close());

  // Chat orchestration normalizes text, image captions and video captions into
  // the same provider-neutral text before observation.
  assert.equal(extractText({ conversation: 'gewone tekst' }), 'gewone tekst');
  assert.equal(extractText({ extendedTextMessage: { text: 'getagde tekst' } }), 'getagde tekst');
  assert.equal(extractText({ imageMessage: { caption: 'onderschrift bij foto' } }), 'onderschrift bij foto');
  assert.equal(extractText({ videoMessage: { caption: 'onderschrift bij video' } }), 'onderschrift bij video');
  assert.equal(extractText({ audioMessage: {} }), null, 'unsupported formats contribute no context');

  const normalized = normalizeEnvelope(
    {
      key: { remoteJid: '31600000001@s.whatsapp.net', id: 'CAP-1' },
      message: { imageMessage: { caption: 'onderschrift bij foto' } },
      pushName: 'Alex',
    },
    { botJids: new Set(), now: 1 }
  );
  assert.equal(normalized.text, 'onderschrift bij foto');
  assert.equal(normalized.addressed, true, 'a direct message always addresses FlunkieBot');

  // The memory module stores all three identically.
  const plain = await memory.observeMessage(observation({ id: 'T-1', text: 'gewone tekst' }));
  const imageCaption = await memory.observeMessage(observation({ id: 'T-2', text: 'onderschrift bij foto' }));
  const videoCaption = await memory.observeMessage(observation({ id: 'T-3', text: 'onderschrift bij video' }));

  for (const stored of [plain, imageCaption, videoCaption]) assert.ok(stored.messageId);

  const context = await memory.prepareAddressedTurn(videoCaption.addressedTurnId);
  assert.equal(context.messageToAnswer.text, 'onderschrift bij video');
  assert.deepEqual(
    context.recentMessages.map((message) => message.text),
    ['gewone tekst', 'onderschrift bij foto']
  );
});

test('8. preserves PN-only and LID-only participants independently', async (t) => {
  const clock = createClock();
  const memory = newMemory(clock);
  t.after(() => memory.close());

  await memory.observeMessage(
    observation({ id: 'P-1', senderAlias: { kind: 'phone', value: '31600000001@s.whatsapp.net' } })
  );
  clock.advance(1000);
  await memory.observeMessage(
    observation({ id: 'P-2', senderAlias: { kind: 'lid', value: '9990001@lid' } })
  );

  const pnParticipant = memory.inspect.participantOf('phone', '31600000001@s.whatsapp.net');
  const lidParticipant = memory.inspect.participantOf('lid', '9990001@lid');

  assert.ok(pnParticipant && lidParticipant);
  assert.notEqual(pnParticipant, lidParticipant, 'unpaired aliases stay separate participants');
});

test('9. merges aliases from explicit envelope pairing evidence', async (t) => {
  const clock = createClock();
  const memory = newMemory(clock);
  t.after(() => memory.close());

  await memory.observeMessage(
    observation({ id: 'M-1', senderAlias: { kind: 'phone', value: '31600000001@s.whatsapp.net' } })
  );
  clock.advance(1000);
  await memory.observeMessage(
    observation({ id: 'M-2', senderAlias: { kind: 'lid', value: '9990001@lid' } })
  );

  const pnParticipant = memory.inspect.participantOf('phone', '31600000001@s.whatsapp.net');

  clock.advance(1000);
  await memory.observeMessage(
    observation({
      id: 'M-3',
      senderAlias: { kind: 'lid', value: '9990001@lid' },
      pairedAlias: { kind: 'phone', value: '31600000001@s.whatsapp.net' },
    })
  );

  assert.equal(memory.inspect.participantOf('lid', '9990001@lid'), pnParticipant);
  assert.equal(memory.inspect.participantOf('phone', '31600000001@s.whatsapp.net'), pnParticipant);
  assert.deepEqual(
    memory.inspect.aliasesOf(pnParticipant).map((alias) => `${alias.kind}:${alias.value}`),
    ['lid:9990001@lid', 'phone:31600000001@s.whatsapp.net']
  );
  assert.equal(memory.inspect.pairingConflicts().length, 0);
});

test('10. treats replayed identity evidence idempotently', async (t) => {
  const clock = createClock();
  const memory = newMemory(clock);
  t.after(() => memory.close());

  const pairing = {
    senderAlias: { kind: 'phone', value: '31600000001@s.whatsapp.net' },
    pairedAlias: { kind: 'lid', value: '9990001@lid' },
  };

  await memory.observeMessage(observation({ id: 'R-1', ...pairing }));
  const participant = memory.inspect.participantOf('phone', '31600000001@s.whatsapp.net');

  clock.advance(1000);
  await memory.observeMessage(observation({ id: 'R-2', ...pairing }));
  clock.advance(1000);
  await memory.observeMessage(observation({ id: 'R-3', ...pairing }));

  assert.equal(memory.inspect.participantOf('lid', '9990001@lid'), participant);
  assert.equal(memory.inspect.aliasesOf(participant).length, 2);
  assert.equal(memory.inspect.pairingConflicts().length, 0);
});

test('11. preserves conflicting alias evidence without automatic merge', async (t) => {
  const clock = createClock();
  const memory = newMemory(clock);
  t.after(() => memory.close());

  await memory.observeMessage(
    observation({
      id: 'C-1',
      senderAlias: { kind: 'phone', value: '31600000001@s.whatsapp.net' },
      pairedAlias: { kind: 'lid', value: '9990001@lid' },
    })
  );
  const participant = memory.inspect.participantOf('phone', '31600000001@s.whatsapp.net');

  clock.advance(1000);
  // A second envelope claims the same phone alias pairs with a different LID.
  await memory.observeMessage(
    observation({
      id: 'C-2',
      senderAlias: { kind: 'phone', value: '31600000001@s.whatsapp.net' },
      pairedAlias: { kind: 'lid', value: '9990002@lid' },
    })
  );

  const conflicts = memory.inspect.pairingConflicts();
  assert.equal(conflicts.length, 1, 'the conflicting evidence is preserved and visible');
  assert.equal(conflicts[0].counterpartValue, '9990002@lid');
  assert.equal(memory.inspect.participantOf('lid', '9990001@lid'), participant);
  assert.equal(memory.inspect.participantOf('lid', '9990002@lid'), null, 'no automatic merge happened');
  assert.equal(memory.inspect.aliasesOf(participant).length, 2);
});

test('12. keeps the oldest participant identity after a merge and resolves absorbed identities through redirects', async (t) => {
  const clock = createClock();
  const memory = newMemory(clock);
  t.after(() => memory.close());

  await memory.observeMessage(
    observation({ id: 'O-1', senderAlias: { kind: 'phone', value: '31600000001@s.whatsapp.net' } })
  );
  const oldest = memory.inspect.participantOf('phone', '31600000001@s.whatsapp.net');

  clock.advance(60_000);
  await memory.observeMessage(
    observation({ id: 'O-2', senderAlias: { kind: 'lid', value: '9990001@lid' } })
  );
  const newer = memory.inspect.participantOf('lid', '9990001@lid');
  assert.notEqual(oldest, newer);

  clock.advance(60_000);
  const merged = await memory.observeMessage(
    observation({
      id: 'O-3',
      senderAlias: { kind: 'lid', value: '9990001@lid' },
      pairedAlias: { kind: 'phone', value: '31600000001@s.whatsapp.net' },
    })
  );

  assert.equal(memory.inspect.participantOf('lid', '9990001@lid'), oldest, 'the oldest identity survives');

  // Every durable reference keeps resolving through the surviving participant.
  const context = await memory.prepareAddressedTurn(merged.addressedTurnId);
  assert.equal(context.addressedParticipant.id, oldest);
  for (const message of context.recentMessages) {
    if (message.authorId) assert.equal(message.authorId, oldest);
  }
});

// Supplementary coverage: presentation labels are best effort and never
// identity, so missing and colliding display names must fall back to
// deterministic context-local labels.
test('assigns deterministic context-local labels for missing and duplicate names', async (t) => {
  const clock = createClock();
  const memory = newMemory(clock);
  t.after(() => memory.close());

  const group = { address: 'flunkcie@g.us', kind: 'group' };

  // Two different participants presenting the same display name.
  await memory.observeMessage(
    observation({
      ...group,
      id: 'L-1',
      addressed: false,
      text: 'eerste Alex',
      senderLabel: 'Alex',
      senderAlias: { kind: 'phone', value: '31600000001@s.whatsapp.net' },
    })
  );
  clock.advance(1000);
  await memory.observeMessage(
    observation({
      ...group,
      id: 'L-2',
      addressed: false,
      text: 'tweede Alex',
      senderLabel: 'Alex',
      senderAlias: { kind: 'phone', value: '31600000002@s.whatsapp.net' },
    })
  );
  clock.advance(1000);
  // A participant with no display name at all.
  await memory.observeMessage(
    observation({
      ...group,
      id: 'L-3',
      addressed: false,
      text: 'naamloos',
      senderLabel: null,
      senderAlias: { kind: 'phone', value: '31600000003@s.whatsapp.net' },
    })
  );
  clock.advance(1000);
  const turn = await memory.observeMessage(
    observation({
      ...group,
      id: 'L-4',
      addressed: true,
      text: 'oi bot',
      senderLabel: 'Quirijn',
      senderAlias: { kind: 'phone', value: '31600000004@s.whatsapp.net' },
    })
  );

  const context = await memory.prepareAddressedTurn(turn.addressedTurnId);
  const labels = context.recentMessages.map((message) => message.authorLabel);

  assert.deepEqual(labels, ['Participant 1', 'Participant 2', 'Participant 3']);
  assert.equal(context.addressedParticipant.label, 'Quirijn', 'a unique name is used as-is');

  // Stable across repeated preparation of the same turn.
  const again = await memory.prepareAddressedTurn(turn.addressedTurnId);
  assert.deepEqual(
    again.recentMessages.map((message) => message.authorLabel),
    labels
  );
});
