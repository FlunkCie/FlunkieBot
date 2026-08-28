// Scenarios 17-24. Extraction is exercised through the memory interface with
// deterministic fake extraction providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemory } from '../memory/index.js';
import { temporaryDatabasePath } from './helpers/temp-database.js';
import { createClock } from './helpers/clock.js';
import { createMemoryFixture, claimBatch, triggerOf } from './helpers/memory-fixture.js';
import { observation } from './helpers/messages.js';

const ALEX = { kind: 'phone', value: '31600000001@s.whatsapp.net' };
const QUIRIJN = { kind: 'phone', value: '31600000002@s.whatsapp.net' };

function episodeFor(packet, text, { reporter, involved } = {}) {
  const trigger = triggerOf(packet);
  return {
    category: 'episode',
    text,
    subject: null,
    reporter: reporter ?? trigger.author,
    involved: involved ?? [trigger.author],
    occurredAt: '2026-01-01T20:00:00.000Z',
    evidence: [{ message: trigger.handle, excerpt: trigger.text.slice(0, 24) }],
  };
}

function patternFor(packet, text) {
  const trigger = triggerOf(packet);
  const exchanges = packet.messages.filter(
    (message) => message.completedExchange && message.author === trigger.author
  );
  return {
    category: 'interaction_pattern',
    text,
    subject: trigger.author,
    reporter: null,
    involved: [],
    occurredAt: null,
    evidence: exchanges.slice(-2).map((message) => ({
      message: message.handle,
      excerpt: message.text.slice(0, 20),
    })),
  };
}

test('17. writes a validated extraction batch atomically', async (t) => {
  const clock = createClock();
  const fixture = createMemoryFixture({ clock });
  const { memory } = fixture;
  t.after(() => memory.close());

  fixture.setExtraction((packet) => ({
    memories: [
      claimBatch(packet, 'Speelt elke vrijdag FlunkyBal').memories[0],
      episodeFor(packet, 'Brak zijn pols tijdens een toernooi'),
    ],
  }));

  const turn = await fixture.completeTurn({ id: 'A-1', text: 'ik speel elke vrijdag FlunkyBal en brak mijn pols' });

  assert.equal(memory.inspect.runState(turn.addressedTurnId), 'succeeded');
  assert.equal(memory.inspect.claims().length, 1);
  assert.equal(memory.inspect.episodes().length, 1);
  assert.equal(memory.inspect.evidenceCount(), 2, 'each durable memory owns its evidence snapshot');
});

test('18. accepts valid participant claims, episodes and interaction patterns', async (t) => {
  const clock = createClock();
  const fixture = createMemoryFixture({ clock });
  const { memory } = fixture;
  t.after(() => memory.close());

  // One completed exchange first, so the pattern has two to cite afterwards.
  fixture.setExtraction(() => ({ memories: [] }));
  await fixture.completeTurn({ id: 'B-1', text: 'oi bot, zeg eens iets aardigs', senderAlias: ALEX });
  clock.advance(1000);

  fixture.setExtraction((packet) => ({
    memories: [
      claimBatch(packet, 'Woont in Amsterdam').memories[0],
      episodeFor(packet, 'Werd uit het Cooldown Cafe gezet'),
      patternFor(packet, 'Vraagt steeds om iets aardigs en krijgt een sneer'),
    ],
  }));
  const turn = await fixture.completeTurn({
    id: 'B-2',
    text: 'oi bot, zeg eens iets aardigs, ik woon in Amsterdam',
    senderAlias: ALEX,
  });

  assert.equal(memory.inspect.runState(turn.addressedTurnId), 'succeeded');
  assert.equal(memory.inspect.claims().length, 1);
  assert.equal(memory.inspect.episodes().length, 1);
  assert.equal(memory.inspect.interactionPatterns().length, 1);
});

test('19. rejects interaction patterns without two distinct completed addressed exchanges', async (t) => {
  const clock = createClock();
  const fixture = createMemoryFixture({ clock });
  const { memory } = fixture;
  t.after(() => memory.close());

  fixture.setExtraction((packet) => {
    const trigger = triggerOf(packet);
    return {
      memories: [
        {
          category: 'interaction_pattern',
          text: 'Krijgt altijd een sneer terug',
          subject: trigger.author,
          reporter: null,
          involved: [],
          occurredAt: null,
          // Two evidence references, but both cite the same single exchange.
          evidence: [
            { message: trigger.handle, excerpt: trigger.text.slice(0, 10) },
            { message: trigger.handle, excerpt: trigger.text.slice(0, 12) },
          ],
        },
      ],
    };
  });

  const turn = await fixture.completeTurn({ id: 'C-1', text: 'oi bot zeg eens wat' });

  assert.equal(memory.inspect.interactionPatterns().length, 0);
  assert.equal(memory.inspect.runState(turn.addressedTurnId), 'failed');
});

test('20. rejects invalid handles, non-verbatim evidence, cardinality, length and semantic violations', async (t) => {
  const clock = createClock();

  const rejections = {
    'unknown participant handle': (packet) => ({
      memories: [{ ...claimBatch(packet).memories[0], subject: 'p99', reporter: 'p99' }],
    }),
    'unknown message handle': (packet) => {
      const memory = claimBatch(packet).memories[0];
      return { memories: [{ ...memory, evidence: [{ message: 'm99', excerpt: 'hoi' }] }] };
    },
    'non-verbatim evidence excerpt': (packet) => {
      const memory = claimBatch(packet).memories[0];
      return {
        memories: [
          { ...memory, evidence: [{ message: triggerOf(packet).handle, excerpt: 'dit stond er nooit' }] },
        ],
      };
    },
    'category cardinality violation': (packet) => ({
      memories: [claimBatch(packet, 'Eerste claim').memories[0], claimBatch(packet, 'Tweede claim').memories[0]],
    }),
    'excessive length': (packet) => ({
      memories: [claimBatch(packet, 'k'.repeat(241)).memories[0]],
    }),
    'more than three entries': (packet) => ({
      memories: [
        claimBatch(packet, 'een').memories[0],
        claimBatch(packet, 'twee').memories[0],
        claimBatch(packet, 'drie').memories[0],
        claimBatch(packet, 'vier').memories[0],
      ],
    }),
    'unknown property': (packet) => ({
      memories: [{ ...claimBatch(packet).memories[0], confidence: 0.9 }],
    }),
    'hearsay presented as a claim': (packet) => {
      const trigger = triggerOf(packet);
      const other = packet.participants.find((p) => p.handle !== trigger.author) ?? trigger;
      return {
        memories: [
          { ...claimBatch(packet).memories[0], subject: other.handle ?? 'p2', reporter: trigger.author },
        ],
      };
    },
    'episode without a reporter': (packet) => ({
      memories: [{ ...episodeFor(packet, 'Iets gebeurde ooit'), reporter: null }],
    }),
    'malformed JSON': () => 'this is not json at all',
  };

  for (const [label, respond] of Object.entries(rejections)) {
    const fixture = createMemoryFixture({ clock: createClock() });
    fixture.setExtraction(() => ({ memories: [] }));
    // A second participant so the hearsay case has somebody to misattribute to.
    await fixture.memory.observeMessage(
      observation({ id: `${label}-ambient`, addressed: false, senderAlias: QUIRIJN, senderLabel: 'Quirijn' })
    );
    fixture.setExtraction(respond);
    const turn = await fixture.completeTurn({ id: `${label}-trigger`, text: 'ik drink alleen nog Buzzballz', senderAlias: ALEX });

    assert.equal(fixture.memory.inspect.claims().length, 0, `${label}: no claim written`);
    assert.equal(fixture.memory.inspect.episodes().length, 0, `${label}: no episode written`);
    assert.equal(fixture.memory.inspect.evidenceCount(), 0, `${label}: no evidence written`);
    assert.equal(fixture.memory.inspect.runState(turn.addressedTurnId), 'failed', `${label}: run failed`);
    fixture.memory.close();
  }
});

test('21. accepts an explicit empty-memory result as a successful no-op', async (t) => {
  const clock = createClock();
  const fixture = createMemoryFixture({ clock });
  const { memory } = fixture;
  t.after(() => memory.close());

  fixture.setExtraction(() => ({ memories: [] }));
  const turn = await fixture.completeTurn({ id: 'E-1', text: 'ha die bot' });

  assert.equal(memory.inspect.runState(turn.addressedTurnId), 'succeeded');
  assert.equal(memory.inspect.claims().length, 0);
  assert.equal(memory.inspect.episodes().length, 0);
  assert.equal(memory.inspect.interactionPatterns().length, 0);
});

test('22. advances extraction fallback after invalid provider output', async (t) => {
  const clock = createClock();
  const calls = [];

  const broken = {
    name: 'broken',
    async generate() {
      calls.push('broken');
      return { text: '{"memories":[{"category":"nonsense"}]}' };
    },
  };
  const healthy = {
    name: 'healthy',
    async generate(request) {
      calls.push('healthy');
      const content = request.messages[0].content;
      const packet = JSON.parse(content.slice(content.indexOf('\n') + 1));
      return { text: JSON.stringify(claimBatch(packet, 'Drinkt alleen nog Buzzballz')) };
    },
  };

  const memory = createMemory({
    dbPath: temporaryDatabasePath(),
    clock: clock.now,
    extractionProviders: [broken, healthy],
    retryPasses: 1,
    sleep: async () => {},
  });
  t.after(() => memory.close());

  const observed = await memory.observeMessage(observation({ id: 'F-1', text: 'ik drink alleen nog Buzzballz' }));
  await memory.finishAddressedTurn(observed.addressedTurnId, {
    kind: 'reply-sent',
    sentMessage: { whatsappMessageId: 'OUT-1', text: 'Kanker.', sentAt: clock.now() },
  });

  assert.deepEqual(calls, ['broken', 'healthy'], 'invalid output advances to the next provider');
  assert.equal(memory.inspect.claims().length, 1);
  assert.equal(memory.inspect.runState(observed.addressedTurnId), 'succeeded');
});

test('23. writes no memories after exhausted extraction fallback and records failure', async (t) => {
  const clock = createClock();
  const fixture = createMemoryFixture({ clock });
  const { memory } = fixture;
  t.after(() => memory.close());

  fixture.setExtraction(() => new Error('provider down'));
  const turn = await fixture.completeTurn({ id: 'G-1', text: 'ik drink alleen nog Buzzballz' });

  assert.equal(memory.inspect.claims().length, 0);
  assert.equal(memory.inspect.evidenceCount(), 0);
  assert.equal(
    memory.inspect.runState(turn.addressedTurnId),
    'failed',
    'exhausted fallback records failure rather than pretending nothing was worthwhile'
  );
  // The already sent reply is untouched by the extraction failure.
  assert.equal(memory.inspect.turnOutcomes()[0].kind, 'reply-sent');
});

test('24. resumes pending extraction runs after a simulated crash and stops retrying exhausted runs', async (t) => {
  const clock = createClock();
  const dbPath = temporaryDatabasePath();

  // A crash: the message and its pending run are stored, the turn never finished.
  const crashing = createMemory({ dbPath, clock: clock.now, extractionProviders: [], retryPasses: 1 });
  await crashing.start();
  const observed = await crashing.observeMessage(observation({ id: 'H-1', text: 'ik woon in Amsterdam' }));
  assert.equal(crashing.inspect.pendingRuns().length, 1);
  crashing.close();

  const calls = [];
  const provider = {
    name: 'resume',
    async generate(request) {
      calls.push(request);
      const content = request.messages[0].content;
      const packet = JSON.parse(content.slice(content.indexOf('\n') + 1));
      return { text: JSON.stringify(claimBatch(packet, 'Woont in Amsterdam')) };
    },
  };

  const resumed = createMemory({
    dbPath,
    clock: clock.now,
    extractionProviders: [provider],
    retryPasses: 1,
    sleep: async () => {},
  });
  await resumed.start();

  assert.equal(calls.length, 1, 'the pending run was resumed at startup');
  assert.equal(resumed.inspect.claims().length, 1);
  assert.equal(resumed.inspect.pendingRuns().length, 0);
  assert.equal(resumed.inspect.runState(observed.addressedTurnId), 'succeeded');
  resumed.close();

  // An exhausted run becomes permanently failed and is not retried forever.
  const failingPath = temporaryDatabasePath();
  const failingCrash = createMemory({ dbPath: failingPath, clock: clock.now, extractionProviders: [], retryPasses: 1 });
  await failingCrash.start();
  const stuck = await failingCrash.observeMessage(observation({ id: 'H-2', text: 'ik woon in Utrecht' }));
  failingCrash.close();

  let attempts = 0;
  const alwaysFails = {
    name: 'always-fails',
    async generate() {
      attempts += 1;
      throw new Error('provider down');
    },
  };
  const options = {
    dbPath: failingPath,
    clock: clock.now,
    extractionProviders: [alwaysFails],
    retryPasses: 1,
    sleep: async () => {},
  };

  const firstBoot = createMemory(options);
  await firstBoot.start();
  assert.equal(attempts, 1);
  assert.equal(firstBoot.inspect.runState(stuck.addressedTurnId), 'failed');
  firstBoot.close();

  const secondBoot = createMemory(options);
  await secondBoot.start();
  assert.equal(attempts, 1, 'an exhausted run is never retried again');
  assert.equal(secondBoot.inspect.pendingRuns().length, 0);
  secondBoot.close();
});

// Supplementary coverage: strict structured-output routes get a projection of
// the one code-owned schema, instruction-style routes get the full schema, and
// every constraint the projection omits stays enforced locally.
test('the extraction request carries a strict-safe projection beside the full schema', async (t) => {
  const clock = createClock();
  const fixture = createMemoryFixture({ clock });
  t.after(() => fixture.memory.close());

  await fixture.completeTurn({ id: 'PS-1', text: 'ik woon in Amsterdam' });

  const { schema, strictSchema } = fixture.requests[0].output;
  const full = JSON.stringify(schema);
  const strict = JSON.stringify(strictSchema);
  for (const keyword of ['maxItems', 'minItems', 'maxLength']) {
    assert.ok(full.includes(keyword), `the code-owned schema still bounds "${keyword}"`);
    assert.ok(!strict.includes(keyword), `strict structured output rejects "${keyword}"`);
  }
  assert.equal(strictSchema.additionalProperties, false, 'the projection keeps the supported core keywords');
  assert.deepEqual(strictSchema.properties.memories.items.properties.category.enum, [
    'participant_claim',
    'episode',
    'interaction_pattern',
  ]);

  // Whatever the provider returns is still held to the full local schema.
  clock.advance(1000);
  fixture.setExtraction((packet) => {
    const trigger = triggerOf(packet);
    return {
      memories: [
        {
          category: 'participant_claim',
          text: 'x'.repeat(400),
          subject: trigger.author,
          reporter: trigger.author,
          involved: [trigger.author],
          occurredAt: null,
          evidence: [{ message: trigger.handle, excerpt: trigger.text.slice(0, 10) }],
        },
      ],
    };
  });
  const observed = await fixture.completeTurn({ id: 'PS-2', text: 'ik woon in Utrecht' });

  assert.equal(fixture.memory.inspect.claims().length, 0, 'an over-long claim is still rejected locally');
  assert.equal(fixture.memory.inspect.runState(observed.addressedTurnId), 'failed');
});
