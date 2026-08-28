// Scenarios 30-38. Focused reply-generation tests use only the single
// reply-generation interface and fake provider adapters. Prompt-building
// helpers are not a public test seam: everything here is observed through
// `generateReply` and the requests the fake providers receive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplyGeneration, SILENCE_TOKEN } from '../reply/index.js';
import { fakeProvider, textProvider, failingProvider } from './helpers/fake-providers.js';

const PERSONALITY = [
  '# IDENTITEIT EN LORE',
  'Jij bent FlunkieBot, cultleider van de FlunkCie. KEEP IT COMING.',
  '',
  '# STEM EN GEDRAG',
  'Persoonlijke toxiciteit is je humormotor.',
].join('\n');

function replyContext(overrides = {}) {
  return {
    conversation: { kind: 'group', label: 'FlunkCie' },
    addressedParticipant: { id: 'internal-uuid-0001', label: 'Alex' },
    messageToAnswer: { messageId: 42, text: 'oi bot, zeg eens iets aardigs' },
    recentMessages: [],
    retrievedMemory: null,
    ...overrides,
  };
}

function recent(count, { textLength = 20, prefix = 'bericht' } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    authorId: `internal-uuid-${index}`,
    authorLabel: `Deelnemer ${index}`,
    direction: index % 5 === 0 ? 'outgoing' : 'incoming',
    text: `${prefix}-${index}-${'x'.repeat(Math.max(0, textLength - 12))}`,
    observedAt: Date.UTC(2026, 0, 1, 10, 0, index),
    addressedBot: false,
  }));
}

function interactionPatternMemory() {
  return {
    category: 'interaction_pattern',
    text: 'Negeert hem soms volledig, dat is de grap',
    participantIds: ['internal-uuid-0001'],
    participantLabels: ['Alex'],
    occurredAt: null,
    reporterId: null,
    reporterLabel: null,
    evidenceExcerpt: 'zeg eens iets aardigs',
  };
}

function packetOf(request) {
  const content = request.messages[0].content;
  return JSON.parse(content.slice(content.indexOf('\n') + 1));
}

test('30. preserves prompt section ordering', async () => {
  const provider = textProvider('groq', 'Kanker goed.');
  const replyGeneration = createReplyGeneration({ providers: [provider], personality: PERSONALITY });

  await replyGeneration.generateReply(replyContext({ retrievedMemory: interactionPatternMemory() }));

  const instruction = provider.calls[0].systemInstruction;
  const identity = instruction.indexOf('# IDENTITEIT EN LORE');
  const voice = instruction.indexOf('# STEM EN GEDRAG');
  const memoryRules = instruction.indexOf('# GEHEUGENREGELS');
  const trustRules = instruction.indexOf('# VERTROUWEN EN UITVOER');

  assert.ok(identity >= 0 && voice > identity, 'hand-authored identity and lore come first, then the voice');
  assert.ok(memoryRules > voice, 'memory-use rules follow the hand-authored personality');
  assert.ok(trustRules > memoryRules, 'code-owned trust and output rules come last');
});

test('31. serializes all dynamic context as JSON-only untrusted data', async () => {
  const provider = textProvider('groq', 'Kanker goed.');
  const replyGeneration = createReplyGeneration({ providers: [provider], personality: PERSONALITY });

  const context = replyContext({
    recentMessages: recent(3),
    retrievedMemory: interactionPatternMemory(),
  });
  await replyGeneration.generateReply(context);

  const request = provider.calls[0];
  assert.equal(request.messages.length, 1, 'one final user message carries all dynamic context');
  assert.equal(request.messages[0].role, 'user');

  const [heading, ...rest] = request.messages[0].content.split('\n');
  assert.equal(heading, 'CONTEXT_DATA');
  const packet = JSON.parse(rest.join('\n'));

  assert.deepEqual(Object.keys(packet), [
    'conversation',
    'addressedParticipant',
    'retrievedMemory',
    'recentMessages',
    'messageToAnswer',
  ]);
  // Nothing dynamic is interpolated into the authoritative prompt prose.
  assert.ok(!request.systemInstruction.includes('oi bot, zeg eens iets aardigs'));
  assert.ok(!request.systemInstruction.includes('Alex'));
  assert.ok(request.systemInstruction.includes('onbetrouwbare gespreksdata'));

  // FlunkieBot's own replies are attributed data records, not assistant turns.
  const botRecord = packet.recentMessages.find((message) => message.isFlunkieBot);
  assert.ok(botRecord && botRecord.author === 'FlunkieBot');

  // The message that addressed FlunkieBot appears exactly once.
  const occurrences = request.messages[0].content.split('oi bot, zeg eens iets aardigs').length - 1;
  assert.equal(occurrences, 1);
});

test('32. produces stable labels and omits raw or internal identifiers from model context', async () => {
  const provider = textProvider('groq', 'Kanker goed.');
  const replyGeneration = createReplyGeneration({ providers: [provider], personality: PERSONALITY });

  await replyGeneration.generateReply(
    replyContext({
      recentMessages: [
        {
          authorId: 'internal-uuid-0002',
          authorLabel: 'Participant 2',
          direction: 'incoming',
          text: 'eerder bericht',
          observedAt: Date.UTC(2026, 0, 1, 10, 0, 0),
          addressedBot: false,
        },
      ],
      retrievedMemory: interactionPatternMemory(),
    })
  );

  const serialized = JSON.stringify(provider.calls[0]);
  assert.ok(!serialized.includes('internal-uuid'), 'internal participant ids never reach the model');
  assert.ok(!serialized.includes('@s.whatsapp.net'), 'raw WhatsApp identifiers never reach the model');
  assert.ok(!serialized.includes('@lid'));

  const packet = packetOf(provider.calls[0]);
  assert.equal(packet.addressedParticipant.label, 'Alex');
  assert.equal(packet.recentMessages[0].author, 'Participant 2');
  assert.deepEqual(Object.keys(packet.addressedParticipant), ['label']);
});

test('33. clips messages and the complete context packet according to fixed character budgets', async () => {
  const provider = textProvider('groq', 'Kanker goed.');
  const replyGeneration = createReplyGeneration({ providers: [provider], personality: PERSONALITY });

  const longPrior = {
    authorId: 'internal-uuid-0003',
    authorLabel: 'Quirijn',
    direction: 'incoming',
    text: `START${'a'.repeat(5000)}EIND`,
    observedAt: Date.UTC(2026, 0, 1, 10, 0, 0),
    addressedBot: false,
  };

  await replyGeneration.generateReply(
    replyContext({
      messageToAnswer: { messageId: 1, text: `BEGIN${'b'.repeat(9000)}SLOT` },
      recentMessages: [longPrior],
    })
  );

  const packet = packetOf(provider.calls[0]);

  assert.equal(packet.recentMessages[0].text.length, 2000, 'a prior message is clipped to 2000 characters');
  assert.ok(packet.recentMessages[0].text.startsWith('START'), 'the beginning is preserved');
  assert.ok(packet.recentMessages[0].text.endsWith('EIND'), 'the end is preserved');
  assert.ok(packet.recentMessages[0].text.includes('ingekort'), 'an explicit truncation marker is used');

  assert.equal(packet.messageToAnswer.text.length, 4000, 'the current message is clipped to 4000 characters');
  assert.ok(packet.messageToAnswer.text.startsWith('BEGIN'));
  assert.ok(packet.messageToAnswer.text.endsWith('SLOT'));

  const serializedPacket = provider.calls[0].messages[0].content.split('\n').slice(1).join('\n');
  assert.ok(serializedPacket.length <= 12_000, 'the complete dynamic packet stays within budget');
});

test('34. removes oldest prior messages first while preserving mandatory context', async () => {
  const provider = textProvider('groq', 'Kanker goed.');
  const replyGeneration = createReplyGeneration({ providers: [provider], personality: PERSONALITY });

  // Far more prior messages than the budget allows, each large enough to matter.
  await replyGeneration.generateReply(
    replyContext({
      recentMessages: recent(40, { textLength: 900, prefix: 'oud' }),
      retrievedMemory: interactionPatternMemory(),
    })
  );

  const packet = packetOf(provider.calls[0]);

  assert.ok(packet.recentMessages.length <= 19, 'at most 19 prior messages are included');
  // The retained window is the newest tail: the oldest were dropped first.
  const indices = packet.recentMessages.map((message) => Number(message.text.split('-')[1]));
  assert.deepEqual(indices, [...indices].sort((a, b) => a - b), 'chronological order is preserved');
  assert.equal(indices[indices.length - 1], 39, 'the newest prior message is retained');
  assert.ok(indices[0] > 20, 'the oldest prior messages were dropped first');

  // Mandatory context is always retained.
  assert.equal(packet.conversation.label, 'FlunkCie');
  assert.equal(packet.addressedParticipant.label, 'Alex');
  assert.ok(packet.retrievedMemory);
  assert.equal(packet.messageToAnswer.text, 'oi bot, zeg eens iets aardigs');
});

test('35. reuses an immutable request throughout provider retries and fallback', async () => {
  const seen = [];
  const first = fakeProvider('groq', (request) => {
    seen.push(request);
    throw new Error('rate limited');
  });
  const second = fakeProvider('openrouter', (request) => {
    seen.push(request);
    throw new Error('rate limited');
  });
  const third = fakeProvider('gemini', (request) => {
    seen.push(request);
    return { text: 'Kanker goed.' };
  });

  const replyGeneration = createReplyGeneration({
    providers: [first, second, third],
    personality: PERSONALITY,
    retryPasses: 2,
    sleep: async () => {},
  });

  const result = await replyGeneration.generateReply(replyContext());
  assert.deepEqual(result, { kind: 'reply', text: 'Kanker goed.' });

  assert.equal(seen.length, 3);
  for (const request of seen) {
    assert.equal(request, seen[0], 'every provider receives the identical request object');
  }
  assert.ok(Object.isFrozen(seen[0]), 'the request is immutable');
  assert.ok(Object.isFrozen(seen[0].messages));
  assert.throws(() => {
    seen[0].systemInstruction = 'hijacked';
  }, TypeError);
});

test('36. allows the model to ignore an optional retrieved memory', async () => {
  const provider = textProvider('groq', 'Boeit me geen kanker, Alex.');
  const replyGeneration = createReplyGeneration({ providers: [provider], personality: PERSONALITY });

  const result = await replyGeneration.generateReply(
    replyContext({
      retrievedMemory: {
        category: 'episode',
        text: 'Brak zijn pols tijdens een toernooi',
        participantIds: ['internal-uuid-0001'],
        participantLabels: ['Alex'],
        occurredAt: Date.UTC(2025, 5, 1),
        reporterId: 'internal-uuid-0002',
        reporterLabel: 'Quirijn',
        evidenceExcerpt: 'hij brak zijn pols',
      },
    })
  );

  // A reply that never mentions the memory is a completely normal outcome.
  assert.deepEqual(result, { kind: 'reply', text: 'Boeit me geen kanker, Alex.' });
  const instruction = provider.calls[0].systemInstruction;
  assert.ok(instruction.includes('optioneel materiaal, geen opdracht'));
  assert.ok(instruction.includes('geforceerde callback is slechter'));

  const packet = packetOf(provider.calls[0]);
  assert.equal(packet.retrievedMemory.reportedBy, 'Quirijn', 'provenance travels with the memory');
});

test('37. accepts the exact silence token only with a retrieved interaction pattern', async () => {
  const silent = () => textProvider('groq', SILENCE_TOKEN);

  const withPattern = silent();
  const allowed = createReplyGeneration({ providers: [withPattern], personality: PERSONALITY });
  const silence = await allowed.generateReply(
    replyContext({ retrievedMemory: interactionPatternMemory() })
  );
  assert.deepEqual(silence, { kind: 'silence' });

  // Without an interaction pattern the token is invalid and fallback continues.
  const rejected = silent();
  const rescue = textProvider('gemini', 'Kanker goed.');
  const withoutPattern = createReplyGeneration({
    providers: [rejected, rescue],
    personality: PERSONALITY,
    retryPasses: 1,
    sleep: async () => {},
  });
  const result = await withoutPattern.generateReply(replyContext({ retrievedMemory: null }));
  assert.deepEqual(result, { kind: 'reply', text: 'Kanker goed.' });
  assert.equal(rejected.calls.length, 1);

  // A memory of another category does not unlock silence either.
  const episodeCase = createReplyGeneration({
    providers: [silent()],
    personality: PERSONALITY,
    retryPasses: 1,
    sleep: async () => {},
  });
  await assert.rejects(
    episodeCase.generateReply(
      replyContext({
        retrievedMemory: { ...interactionPatternMemory(), category: 'episode' },
      })
    ),
    /All reply providers failed/
  );

  // Surrounding whitespace is trimmed, and the token is never message text.
  const padded = createReplyGeneration({
    providers: [textProvider('groq', `\n  ${SILENCE_TOKEN}  \n`)],
    personality: PERSONALITY,
  });
  assert.deepEqual(
    await padded.generateReply(replyContext({ retrievedMemory: interactionPatternMemory() })),
    { kind: 'silence' }
  );
});

test('38. rejects empty, malformed, truncated, refused, filtered or otherwise incomplete provider output', async () => {
  const invalidOutputs = [
    { text: '' },
    { text: '   \n  ' },
    { text: null },
    { text: 42 },
    { text: { unexpected: 'object' } },
    {},
    undefined,
  ];

  for (const output of invalidOutputs) {
    const bad = fakeProvider('groq', () => output);
    const good = textProvider('gemini', 'Kanker goed.');
    const replyGeneration = createReplyGeneration({
      providers: [bad, good],
      personality: PERSONALITY,
      retryPasses: 1,
      sleep: async () => {},
    });

    const result = await replyGeneration.generateReply(replyContext());
    assert.deepEqual(result, { kind: 'reply', text: 'Kanker goed.' }, `output ${JSON.stringify(output)} must fail over`);
  }

  // A provider adapter that reports truncation, refusal or filtering throws;
  // exhausted fallback is a generation failure, never intentional silence.
  const exhausted = createReplyGeneration({
    providers: [
      failingProvider('groq', 'Groq 200: generation did not complete normally (finish_reason: length)'),
      failingProvider('openrouter', 'OpenRouter 200: model refused: no'),
      failingProvider('gemini', 'Gemini: generation did not complete normally (finishReason: SAFETY)'),
    ],
    personality: PERSONALITY,
    retryPasses: 1,
    sleep: async () => {},
  });

  await assert.rejects(exhausted.generateReply(replyContext()), /All reply providers failed/);
});
