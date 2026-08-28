// Scenarios 59-70. Unprompted personal messages, verified end to end through
// chat orchestration with a fake WhatsApp sender, real file-backed memory and
// reply generation backed by fake providers, exactly like the addressed-turn
// scenarios. Nothing here touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplyGeneration, SILENCE_TOKEN } from '../reply/index.js';
import { textProvider } from './helpers/fake-providers.js';
import { createClock } from './helpers/clock.js';
import { createChatFixture } from './helpers/chat-fixture.js';
import { incoming } from './helpers/messages.js';

const GROUP = 'flunkcie@g.us';

const ALEX = { label: 'Alex', alias: { kind: 'phone', value: '31600000001@s.whatsapp.net' } };
const QUIRIJN = { label: 'Quirijn', alias: { kind: 'phone', value: '31600000002@s.whatsapp.net' } };
const SANNE = { label: 'Sanne', alias: { kind: 'phone', value: '31600000003@s.whatsapp.net' } };
const TIJMEN = { label: 'Tijmen', alias: { kind: 'phone', value: '31600000004@s.whatsapp.net' } };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The send window is wall-clock, so every clock in this file is anchored to a
 * local time. That keeps these scenarios identical in every timezone.
 */
function localClock(hour = 12, day = 5) {
  return createClock(new Date(2026, 0, day, hour, 0, 0).getTime());
}

function localTime(day, hour) {
  return new Date(2026, 0, day, hour, 0, 0).getTime();
}

/** A direct message: its conversation address is the sender's own alias. */
function dm(person, id, text = 'hoi flunkie') {
  return incoming({
    address: person.alias.value,
    kind: 'direct',
    id,
    text,
    // WhatsApp normalization labels a direct conversation with the sender's
    // push name, exactly as `normalizeEnvelope` does.
    conversationLabel: person.label,
    senderAlias: person.alias,
    senderLabel: person.label,
  });
}

function groupMessage(person, id, text, { addressed = true } = {}) {
  return incoming({
    address: GROUP,
    kind: 'group',
    conversationLabel: 'FlunkCie',
    id,
    text,
    addressed,
    senderAlias: person.alias,
    senderLabel: person.label,
  });
}

/** An extraction batch that stores one episode about whoever sent the trigger. */
function episodeAbout(text, occurredAt = null) {
  return (packet) => {
    const trigger = packet.messages.find((message) => message.handle === packet.trigger);
    return {
      memories: [
        {
          category: 'episode',
          text,
          subject: null,
          reporter: trigger.author,
          involved: [trigger.author],
          occurredAt,
          evidence: [{ message: trigger.handle, excerpt: trigger.text.slice(0, 24) }],
        },
      ],
    };
  };
}

const DM_ONLY = { mode: 'dm-only' };

/** Lets pending microtasks run until a condition holds, instead of forever. */
async function waitFor(condition, message) {
  for (let tick = 0; tick < 1000; tick += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test('59. restricts unprompted messages to participants with an existing direct-message thread', async (t) => {
  const clock = localClock();
  const fixture = createChatFixture({ clock, initiative: DM_ONLY });
  t.after(() => fixture.memory.close());
  fixture.setInitiativeReply({ text: 'POKE alex' });

  // Alex started a direct-message thread; Sanne only ever appeared in the group.
  await fixture.chat.handleMessage(dm(ALEX, 'A-DM-1', 'hoi flunkie'));
  await fixture.chat.handleMessage(groupMessage(SANNE, 'S-G-1', 'ik zeg niets tegen de bot', { addressed: false }));

  clock.advance(2 * DAY_MS);

  // Both are discussed while absent, but only one of them has ever chosen to
  // talk to FlunkieBot privately.
  await fixture.chat.handleMessage(
    groupMessage(QUIRIJN, 'Q-G-1', 'waar zijn Alex en Sanne eigenlijk gebleven, bot?')
  );

  assert.equal(fixture.initiativeRequests.length, 1, 'exactly one unprompted message is generated');
  const sentTo = fixture.sender.sent.filter((message) => message.text === 'POKE alex');
  assert.equal(sentTo.length, 1);
  assert.equal(sentTo[0].conversationAddress, ALEX.alias.value, 'it lands in the existing direct thread');

  const initiatives = fixture.memory.inspect.initiatives();
  assert.equal(initiatives.length, 1);
  assert.equal(initiatives[0].occasion, 'discussed-while-absent');
});

test('60. sends at most one unprompted message per participant per fourteen days', async (t) => {
  const clock = localClock();
  const fixture = createChatFixture({ clock, initiative: DM_ONLY });
  t.after(() => fixture.memory.close());
  fixture.setInitiativeReply({ text: 'POKE alex' });

  await fixture.chat.handleMessage(dm(ALEX, 'A-DM-1'));
  clock.advance(2 * DAY_MS);
  await fixture.chat.handleMessage(groupMessage(QUIRIJN, 'Q-G-1', 'hebben jullie Alex nog gezien, bot?'));
  assert.equal(fixture.memory.inspect.initiatives().length, 1);

  // Thirteen days later the occasion is just as valid, and the budget still says no.
  clock.advance(13 * DAY_MS);
  await fixture.chat.handleMessage(groupMessage(QUIRIJN, 'Q-G-2', 'Alex is nog steeds zoek, bot'));
  assert.equal(fixture.memory.inspect.initiatives().length, 1, 'the personal cooldown binds');

  // One more day and the cooldown has passed.
  clock.advance(1 * DAY_MS + 1);
  await fixture.chat.handleMessage(groupMessage(QUIRIJN, 'Q-G-3', 'nog steeds niks van Alex, bot'));
  assert.equal(fixture.memory.inspect.initiatives().length, 2);
});

test('61. sends at most two unprompted messages per week across the whole group', async (t) => {
  const clock = localClock();
  const fixture = createChatFixture({ clock, initiative: DM_ONLY });
  t.after(() => fixture.memory.close());
  fixture.setInitiativeReply({ text: 'POKE' });

  for (const [person, id] of [
    [ALEX, 'A-DM-1'],
    [SANNE, 'S-DM-1'],
    [TIJMEN, 'T-DM-1'],
  ]) {
    await fixture.chat.handleMessage(dm(person, id));
  }

  clock.advance(2 * DAY_MS);

  // Three valid occasions in three separate turns, one day apart.
  await fixture.chat.handleMessage(groupMessage(QUIRIJN, 'Q-G-1', 'waar is Alex, bot'));
  clock.advance(DAY_MS);
  await fixture.chat.handleMessage(groupMessage(QUIRIJN, 'Q-G-2', 'en waar is Sanne, bot'));
  clock.advance(DAY_MS);
  await fixture.chat.handleMessage(groupMessage(QUIRIJN, 'Q-G-3', 'en Tijmen dan, bot'));

  assert.equal(fixture.memory.inspect.initiatives().length, 2, 'the weekly group cap binds');

  // A week after the first one, the rolling window has room again.
  clock.advance(6 * DAY_MS);
  await fixture.chat.handleMessage(groupMessage(QUIRIJN, 'Q-G-4', 'echt niks van Tijmen gehoord, bot'));
  assert.equal(fixture.memory.inspect.initiatives().length, 3);
});

test('62. sends unprompted messages only between 10:00 and 23:00', async (t) => {
  const clock = localClock(12, 5);
  const fixture = createChatFixture({ clock, initiative: DM_ONLY });
  t.after(() => fixture.memory.close());
  fixture.setInitiativeReply({ text: 'POKE alex' });

  await fixture.chat.handleMessage(dm(ALEX, 'A-DM-1'));

  clock.set(localTime(8, 9));
  await fixture.chat.handleMessage(groupMessage(QUIRIJN, 'Q-G-1', 'waar is Alex, bot'));
  assert.equal(fixture.memory.inspect.initiatives().length, 0, 'nothing before 10:00');

  clock.set(localTime(8, 23));
  await fixture.chat.handleMessage(groupMessage(QUIRIJN, 'Q-G-2', 'nog steeds niks van Alex, bot'));
  assert.equal(fixture.memory.inspect.initiatives().length, 0, 'nothing from 23:00 onwards');

  clock.set(localTime(8, 10));
  await fixture.chat.handleMessage(groupMessage(QUIRIJN, 'Q-G-3', 'serieus waar is Alex, bot'));
  assert.equal(fixture.memory.inspect.initiatives().length, 1, 'inside the window it goes out');
});

test('63. stops for thirty days after two unprompted messages in a row without a reply', async (t) => {
  const clock = localClock();
  const fixture = createChatFixture({ clock, initiative: DM_ONLY });
  t.after(() => fixture.memory.close());
  fixture.setInitiativeReply({ text: 'POKE alex' });

  await fixture.chat.handleMessage(dm(ALEX, 'A-DM-1'));

  clock.advance(2 * DAY_MS);
  await fixture.chat.handleMessage(groupMessage(QUIRIJN, 'Q-G-1', 'waar is Alex, bot'));
  assert.equal(fixture.memory.inspect.initiatives().length, 1);

  clock.advance(15 * DAY_MS);
  await fixture.chat.handleMessage(groupMessage(QUIRIJN, 'Q-G-2', 'nog steeds niks van Alex, bot'));
  assert.equal(fixture.memory.inspect.initiatives().length, 2, 'one ignored message is not yet a pattern');

  // Two ignored in a row: Alex goes dark for thirty days, even though the
  // personal cooldown itself has long expired.
  clock.advance(20 * DAY_MS);
  await fixture.chat.handleMessage(groupMessage(QUIRIJN, 'Q-G-3', 'iemand nog iets van Alex gehoord, bot'));
  assert.equal(fixture.memory.inspect.initiatives().length, 2, 'the stop rule holds');

  clock.advance(11 * DAY_MS);
  await fixture.chat.handleMessage(groupMessage(QUIRIJN, 'Q-G-4', 'en Alex dan, bot'));
  assert.equal(fixture.memory.inspect.initiatives().length, 3, 'after thirty days the hold lifts');
});

test('64. lets a reply clear the stop rule instead of counting as an ignored message', async (t) => {
  const clock = localClock();
  const fixture = createChatFixture({ clock, initiative: DM_ONLY });
  t.after(() => fixture.memory.close());
  fixture.setInitiativeReply({ text: 'POKE alex' });

  await fixture.chat.handleMessage(dm(ALEX, 'A-DM-1'));

  clock.advance(2 * DAY_MS);
  await fixture.chat.handleMessage(groupMessage(QUIRIJN, 'Q-G-1', 'waar is Alex, bot'));

  // Alex answers the poke. That message is not an ignored one any more.
  clock.advance(60 * 60 * 1000);
  await fixture.chat.handleMessage(dm(ALEX, 'A-DM-2', 'kankerbot laat me met rust'));
  assert.equal(fixture.memory.inspect.initiatives()[0].repliedAt, clock.now());

  clock.advance(15 * DAY_MS);
  await fixture.chat.handleMessage(groupMessage(QUIRIJN, 'Q-G-2', 'is Alex weer weg, bot'));
  clock.advance(15 * DAY_MS);
  await fixture.chat.handleMessage(groupMessage(QUIRIJN, 'Q-G-3', 'nog steeds geen Alex, bot'));

  assert.equal(
    fixture.memory.inspect.initiatives().length,
    3,
    'only two unanswered messages in a row trigger the hold'
  );
});

test('65. pokes someone about a mention only after they have been silent for a day', async (t) => {
  const clock = localClock();
  const fixture = createChatFixture({ clock, initiative: DM_ONLY });
  t.after(() => fixture.memory.close());
  fixture.setInitiativeReply({ text: 'POKE alex' });

  await fixture.chat.handleMessage(dm(ALEX, 'A-DM-1'));

  // Alex spoke twenty-three hours ago: he is present, not absent.
  clock.advance(23 * 60 * 60 * 1000);
  await fixture.chat.handleMessage(groupMessage(QUIRIJN, 'Q-G-1', 'waar is Alex, bot'));
  assert.equal(fixture.memory.inspect.initiatives().length, 0);

  clock.advance(2 * 60 * 60 * 1000);
  await fixture.chat.handleMessage(groupMessage(QUIRIJN, 'Q-G-2', 'nou, waar is Alex, bot'));
  assert.equal(fixture.memory.inspect.initiatives().length, 1);
  assert.equal(fixture.memory.inspect.initiatives()[0].occasion, 'discussed-while-absent');
});

test('66. computes episode ripeness on storage time, never on the model-supplied occurrence time', async (t) => {
  const clock = localClock();
  const fixture = createChatFixture({ clock, initiative: DM_ONLY });
  t.after(() => fixture.memory.close());
  fixture.setInitiativeReply({ text: 'POKE alex' });

  // An episode the model dates a year ago, but that FlunkieBot only learned now.
  fixture.setExtraction(episodeAbout('Sloeg zijn pols aan gort in het Cooldown Cafe', '2025-01-05T20:00:00.000Z'));
  await fixture.chat.handleMessage(dm(ALEX, 'A-DM-1', 'ik brak mijn pols in het Cooldown Cafe'));
  fixture.setExtraction({ memories: [] });

  assert.equal(fixture.memory.inspect.episodes().length, 1);
  assert.ok(fixture.memory.inspect.episodes()[0].occurredAt < clock.now() - 300 * DAY_MS);

  // Thirteen days after storage the episode is not ripe, however old the model
  // thinks the occurrence itself is.
  clock.advance(13 * DAY_MS);
  await fixture.chat.handleMessage(dm(QUIRIJN, 'Q-DM-1', 'yo'));
  assert.equal(fixture.memory.inspect.initiatives().length, 0, 'occurred_at cannot make an episode ripe');

  clock.advance(2 * DAY_MS);
  await fixture.chat.handleMessage(dm(QUIRIJN, 'Q-DM-2', 'yo'));
  const initiatives = fixture.memory.inspect.initiatives();
  assert.equal(initiatives.length, 1, 'created_at decides ripeness');
  assert.equal(initiatives[0].occasion, 'ripe-episode');
  assert.equal(initiatives[0].memoryCategory, 'episode');
});

test('67. never reuses a durable memory for a second unprompted message', async (t) => {
  const clock = localClock();
  const fixture = createChatFixture({ clock, initiative: DM_ONLY });
  t.after(() => fixture.memory.close());
  fixture.setInitiativeReply({ text: 'POKE alex' });

  fixture.setExtraction(episodeAbout('Sloeg zijn pols aan gort in het Cooldown Cafe'));
  await fixture.chat.handleMessage(dm(ALEX, 'A-DM-1', 'ik brak mijn pols in het Cooldown Cafe'));
  fixture.setExtraction({ memories: [] });

  clock.advance(15 * DAY_MS);
  await fixture.chat.handleMessage(dm(QUIRIJN, 'Q-DM-1', 'yo'));
  const first = fixture.memory.inspect.initiatives();
  assert.equal(first.length, 1);
  const usedEpisodeId = first[0].memoryId;
  assert.ok(usedEpisodeId);

  // The same episode is now even riper, and the personal cooldown has expired,
  // but that callback has already been spent.
  clock.advance(20 * DAY_MS);
  await fixture.chat.handleMessage(dm(QUIRIJN, 'Q-DM-2', 'yo'));
  assert.equal(fixture.memory.inspect.initiatives().length, 1, 'a spent memory is never picked again');
});

test('68. sends an unprompted message in the FIFO slot of its recipient', async (t) => {
  const clock = localClock();
  const fixture = createChatFixture({ clock, initiative: DM_ONLY });
  t.after(() => fixture.memory.close());

  fixture.setExtraction(episodeAbout('Sloeg zijn pols aan gort in het Cooldown Cafe'));
  await fixture.chat.handleMessage(dm(ALEX, 'A-DM-1', 'ik brak mijn pols in het Cooldown Cafe'));
  fixture.setExtraction({ memories: [] });

  clock.advance(15 * DAY_MS);

  // Alex is mid-turn: his own message is waiting on a slow provider.
  let releaseAlex;
  fixture.setReply((request) => {
    const content = request.messages[0].content;
    const packet = JSON.parse(content.slice(content.indexOf('\n') + 1));
    if (packet.messageToAnswer.text !== 'ben ik er weer') return { text: 'ANTWOORD quirijn' };
    return new Promise((resolve) => {
      releaseAlex = () => resolve({ text: 'ANTWOORD alex' });
    });
  });
  fixture.setInitiativeReply({ text: 'POKE alex' });

  const alexTurn = fixture.chat.handleMessage(dm(ALEX, 'A-DM-2', 'ben ik er weer'));
  await waitFor(() => releaseAlex !== undefined, 'Alex’ turn reaches the provider');

  // Quirijn's turn completes while Alex is still being answered, and selects
  // Alex as the target of an unprompted message.
  const quirijnTurn = fixture.chat.handleMessage(dm(QUIRIJN, 'Q-DM-1', 'yo'));
  await waitFor(
    () => fixture.sender.sent.some((message) => message.text === 'ANTWOORD quirijn'),
    'Quirijn is answered independently'
  );

  assert.deepEqual(
    fixture.sender.sent.map((message) => message.text).filter((text) => text.startsWith('POKE')),
    [],
    'the unprompted message waits in the recipient’s queue instead of cutting in'
  );

  releaseAlex();
  await Promise.all([alexTurn, quirijnTurn]);

  assert.deepEqual(
    fixture.sender.sent
      .map((message) => message.text)
      .filter((text) => text.startsWith('ANTWOORD alex') || text.startsWith('POKE')),
    ['ANTWOORD alex', 'POKE alex'],
    'the reply to the recipient goes out before the message FlunkieBot started himself'
  );
});

test('69. never sends an unprompted message to a number on the exclusion list', async (t) => {
  const clock = localClock();
  const fixture = createChatFixture({
    clock,
    initiative: { mode: 'dm-only', excludedNumbers: ['+31 6 00000001'] },
  });
  t.after(() => fixture.memory.close());
  fixture.setInitiativeReply({ text: 'POKE' });

  await fixture.chat.handleMessage(dm(ALEX, 'A-DM-1'));
  await fixture.chat.handleMessage(dm(SANNE, 'S-DM-1'));

  clock.advance(2 * DAY_MS);
  await fixture.chat.handleMessage(groupMessage(QUIRIJN, 'Q-G-1', 'waar zijn Alex en Sanne, bot'));

  const initiatives = fixture.memory.inspect.initiatives();
  assert.equal(initiatives.length, 1, 'only the participant who is not excluded is poked');
  assert.equal(fixture.sender.sent.at(-1).conversationAddress, SANNE.alias.value);
});

test('70. sends no unprompted message at all when the mode is off', async (t) => {
  const clock = localClock();
  // No initiative settings at all: the default is off.
  const fixture = createChatFixture({ clock });
  t.after(() => fixture.memory.close());
  fixture.setInitiativeReply({ text: 'POKE' });

  fixture.setExtraction(episodeAbout('Sloeg zijn pols aan gort in het Cooldown Cafe'));
  await fixture.chat.handleMessage(dm(ALEX, 'A-DM-1', 'ik brak mijn pols in het Cooldown Cafe'));
  fixture.setExtraction({ memories: [] });

  clock.advance(15 * DAY_MS);
  await fixture.chat.handleMessage(groupMessage(QUIRIJN, 'Q-G-1', 'waar is Alex, bot'));
  await fixture.chat.handleMessage(dm(QUIRIJN, 'Q-DM-1', 'yo'));

  assert.equal(fixture.initiativeRequests.length, 0, 'no unprompted message is even generated');
  assert.equal(fixture.memory.inspect.initiatives().length, 0);
  assert.ok(
    fixture.sender.sent.every((message) => !message.text.startsWith('POKE')),
    'nothing unprompted reaches WhatsApp'
  );
});

test('71. never accepts the silence token for an unprompted message', async () => {
  const personality = '# IDENTITEIT EN LORE\nFlunkieBot.\n\n# STEM EN GEDRAG\nKanker.';
  const silent = textProvider('groq', SILENCE_TOKEN);
  const talkative = textProvider('gemini', 'Ik moest ineens aan je denken, kankerlijer.');

  const replyGeneration = createReplyGeneration({
    providers: [silent, talkative],
    personality,
    retryPasses: 1,
    sleep: async () => {},
  });

  const context = {
    conversation: { kind: 'direct', label: 'Alex' },
    addressedParticipant: { id: 'internal-uuid-0001', label: 'Alex' },
    occasion: 'ripe-episode',
    recentMessages: [],
    retrievedMemory: {
      category: 'interaction_pattern',
      text: 'Negeert hem soms volledig, dat is de grap',
      participantIds: ['internal-uuid-0001'],
      participantLabels: ['Alex'],
      occurredAt: null,
      reporterId: null,
      reporterLabel: null,
      evidenceExcerpt: 'zeg eens iets aardigs',
    },
  };

  // Even with the one retrieved memory that would license silence in a reply,
  // the token is invalid here and only advances provider fallback.
  const outcome = await replyGeneration.generateInitiative(context);
  assert.deepEqual(outcome, { kind: 'reply', text: 'Ik moest ineens aan je denken, kankerlijer.' });
  assert.equal(talkative.calls.length, 1, 'fallback advanced past the silent provider');

  const packet = JSON.parse(
    talkative.calls[0].messages[0].content.slice(
      talkative.calls[0].messages[0].content.indexOf('\n') + 1
    )
  );
  assert.equal(packet.messageToAnswer, undefined, 'an unprompted message answers nothing');
  assert.equal(packet.occasion, 'ripe-episode');
  assert.ok(talkative.calls[0].systemInstruction.includes('# ONGEVRAAGD BERICHT'));

  const onlySilence = createReplyGeneration({
    providers: [textProvider('groq', SILENCE_TOKEN)],
    personality,
    retryPasses: 1,
    sleep: async () => {},
  });
  await assert.rejects(
    () => onlySilence.generateInitiative(context),
    /All initiative providers failed/,
    'exhausted fallback is a generation failure, never a silent bot'
  );
});
