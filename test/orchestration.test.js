// Scenarios 44-51, 56 and 57. The orchestration seam verifies routing, ambient
// observation, ordering, replies, intentional silence, failures and persistence
// behaviour at the highest practical level.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FAILURE_NOTIFICATION_TEXT } from '../chat.js';
import { SILENCE_TOKEN } from '../reply/index.js';
import { createWhatsAppSender } from '../whatsapp.js';
import { createClock } from './helpers/clock.js';
import { createChatFixture } from './helpers/chat-fixture.js';
import { incoming } from './helpers/messages.js';
import { temporaryDatabasePath } from './helpers/temp-database.js';

const GROUP = { address: 'flunkcie@g.us', kind: 'group', conversationLabel: 'FlunkCie' };

/** Lets pending microtasks run until a condition holds, instead of forever. */
async function waitFor(condition, message) {
  for (let tick = 0; tick < 1000; tick += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test('44. processes one conversation in FIFO order', async (t) => {
  const clock = createClock();
  const fixture = createChatFixture({ clock });
  t.after(() => fixture.memory.close());

  const started = [];
  const releases = [];
  fixture.setReply((request) => {
    const content = request.messages[0].content;
    const packet = JSON.parse(content.slice(content.indexOf('\n') + 1));
    started.push(packet.messageToAnswer.text);
    return new Promise((resolve) => {
      releases.push(() => resolve({ text: `antwoord op ${packet.messageToAnswer.text}` }));
    });
  });

  const first = fixture.chat.handleMessage(incoming({ id: 'F-1', text: 'eerste' }));
  const second = fixture.chat.handleMessage(incoming({ id: 'F-2', text: 'tweede' }));
  const third = fixture.chat.handleMessage(incoming({ id: 'F-3', text: 'derde' }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['eerste'], 'the second message waits for the first');

  const releaseNext = async () => {
    while (releases.length === 0) await new Promise((resolve) => setImmediate(resolve));
    releases.shift()();
  };

  await releaseNext();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['eerste', 'tweede'], 'the queue releases the next message only after the first');

  await releaseNext();
  await second;
  await releaseNext();
  await third;

  assert.deepEqual(
    fixture.sender.sent.map((message) => message.text),
    ['antwoord op eerste', 'antwoord op tweede', 'antwoord op derde'],
    'replies never race or reorder inside one conversation'
  );
});

test('45. allows independent conversations to make concurrent provider calls', async (t) => {
  const clock = createClock();
  const fixture = createChatFixture({ clock });
  t.after(() => fixture.memory.close());

  const inFlight = [];
  const releases = new Map();
  fixture.setReply((request) => {
    const content = request.messages[0].content;
    const packet = JSON.parse(content.slice(content.indexOf('\n') + 1));
    inFlight.push(packet.messageToAnswer.text);
    return new Promise((resolve) => {
      releases.set(packet.messageToAnswer.text, () => resolve({ text: `antwoord ${packet.messageToAnswer.text}` }));
    });
  });

  const alex = fixture.chat.handleMessage(
    incoming({ address: 'alex@s.whatsapp.net', id: 'C-1', text: 'alex-vraag' })
  );
  const quirijn = fixture.chat.handleMessage(
    incoming({
      address: 'quirijn@s.whatsapp.net',
      id: 'C-2',
      text: 'quirijn-vraag',
      senderAlias: { kind: 'phone', value: '31600000002@s.whatsapp.net' },
    })
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    inFlight.sort(),
    ['alex-vraag', 'quirijn-vraag'],
    'a slow provider call in one conversation does not serialize the other'
  );

  releases.get('quirijn-vraag')();
  releases.get('alex-vraag')();
  await Promise.all([alex, quirijn]);
  assert.equal(fixture.sender.sent.length, 2);
});

test('46. observes incoming messages before routing or reply generation', async (t) => {
  const clock = createClock();
  const fixture = createChatFixture({ clock });
  t.after(() => fixture.memory.close());

  fixture.setReply(() => {
    // By the time reply generation runs, the trigger is already persisted.
    assert.equal(fixture.memory.inspect.messageCount(), 1);
    return { text: 'Kanker goed.' };
  });

  await fixture.chat.handleMessage(incoming({ id: 'O-1', text: 'hoi' }));
  assert.equal(fixture.replyRequests.length, 1);
});

test('47. records outgoing messages only after a successful send', async (t) => {
  const clock = createClock();
  const fixture = createChatFixture({ clock });
  t.after(() => fixture.memory.close());

  fixture.sender.failSend = true;
  await fixture.chat.handleMessage(incoming({ id: 'S-1', text: 'hoi' }));

  assert.equal(fixture.sender.sent.length, 0);
  assert.equal(fixture.memory.inspect.messageCount(), 1, 'a failed send stores no outgoing message');
  const failedOutcome = fixture.memory.inspect.turnOutcomes().at(-1);
  assert.equal(failedOutcome.kind, 'failed');
  assert.equal(failedOutcome.stage, 'send');

  fixture.sender.failSend = false;
  clock.advance(1000);
  await fixture.chat.handleMessage(incoming({ id: 'S-2', text: 'nog een keer' }));

  assert.equal(fixture.sender.sent.length, 1);
  assert.equal(fixture.memory.inspect.messageCount(), 3, 'the successful reply is stored');
  const sentOutcome = fixture.memory.inspect.turnOutcomes().at(-1);
  assert.equal(sentOutcome.kind, 'reply-sent');
  assert.ok(sentOutcome.sentMessageId);
});

test('48. degrades to a current-message-only reply when persistence or retrieval permits it', async (t) => {
  const clock = createClock();
  const fixture = createChatFixture({ clock });
  t.after(() => fixture.memory.close());

  // Persistence is unavailable for this message, so no turn can be prepared.
  const original = fixture.memory.observeMessage;
  fixture.memory.observeMessage = async () => {
    throw new Error('database is unavailable');
  };

  await fixture.chat.handleMessage(incoming({ id: 'P-1', text: 'toch antwoorden' }));

  assert.equal(fixture.sender.sent.length, 1, 'the participant still gets a personality-only reply');
  assert.equal(fixture.replyRequests.length, 1);

  const content = fixture.replyRequests[0].messages[0].content;
  const packet = JSON.parse(content.slice(content.indexOf('\n') + 1));
  assert.equal(packet.messageToAnswer.text, 'toch antwoorden');
  assert.deepEqual(packet.recentMessages, []);
  assert.equal(packet.retrievedMemory, null, 'no memory is ever fabricated');

  fixture.memory.observeMessage = original;
  assert.equal(fixture.memory.inspect.messageCount(), 0, 'no in-memory durable state was created');
});

test('49. sends and records the fixed failure notification after exhausted reply fallback', async (t) => {
  const clock = createClock();
  const fixture = createChatFixture({ clock });
  t.after(() => fixture.memory.close());

  fixture.setReply(() => new Error('provider down'));
  await fixture.chat.handleMessage(incoming({ id: 'N-1', text: 'hoi' }));

  assert.equal(fixture.sender.sent.length, 1);
  assert.equal(fixture.sender.sent[0].text, FAILURE_NOTIFICATION_TEXT);

  const outcome = fixture.memory.inspect.turnOutcomes().at(-1);
  assert.equal(outcome.kind, 'failed', 'the notification is part of a generation failure, not generated text');
  assert.equal(outcome.stage, 'generation');
  assert.ok(outcome.notificationMessageId);
  assert.equal(outcome.sentMessageId, null);
});

test('50. records notification send failure without misclassifying it as silence', async (t) => {
  const clock = createClock();
  const fixture = createChatFixture({ clock });
  t.after(() => fixture.memory.close());

  fixture.setReply(() => new Error('provider down'));
  fixture.sender.failSend = true;

  await fixture.chat.handleMessage(incoming({ id: 'NF-1', text: 'hoi' }));

  assert.equal(fixture.sender.sent.length, 0);
  const outcome = fixture.memory.inspect.turnOutcomes().at(-1);
  assert.equal(outcome.kind, 'failed');
  assert.equal(outcome.stage, 'generation');
  assert.equal(outcome.notificationMessageId, null);
  assert.notEqual(outcome.kind, 'intentional-silence');
});

test('51. keeps intentional silence distinct from generation and send failures', async (t) => {
  const clock = createClock();
  const dbPath = temporaryDatabasePath();
  const fixture = createChatFixture({ clock, dbPath });
  t.after(() => fixture.memory.close());

  // Two completed exchanges first, so an interaction pattern can be learned.
  await fixture.chat.handleMessage(incoming({ id: 'I-1', text: 'oi bot zeg eens iets aardigs' }));
  clock.advance(1000);

  fixture.setExtraction((packet) => {
    const trigger = packet.messages.find((message) => message.handle === packet.trigger);
    const exchanges = packet.messages.filter(
      (message) => message.completedExchange && message.author === trigger.author
    );
    return {
      memories: [
        {
          category: 'interaction_pattern',
          text: 'Vraagt steeds om iets aardigs, zwijgen is de grap',
          subject: trigger.author,
          reporter: null,
          involved: [],
          occurredAt: null,
          evidence: exchanges.slice(-2).map((message) => ({
            message: message.handle,
            excerpt: message.text.slice(0, 20),
          })),
        },
      ],
    };
  });
  await fixture.chat.handleMessage(incoming({ id: 'I-2', text: 'oi bot zeg eens iets aardigs' }));
  assert.equal(fixture.memory.inspect.interactionPatterns().length, 1);

  clock.advance(1000);
  fixture.setExtraction(() => ({ memories: [] }));
  fixture.setReply(() => ({ text: SILENCE_TOKEN }));

  const sentBefore = fixture.sender.sent.length;
  await fixture.chat.handleMessage(incoming({ id: 'I-3', text: 'oi bot zeg eens iets aardigs' }));

  assert.equal(fixture.sender.sent.length, sentBefore, 'the silence token is never sent as message text');
  for (const message of fixture.sender.sent) {
    assert.notEqual(message.text, SILENCE_TOKEN);
  }

  const outcomes = fixture.memory.inspect.turnOutcomes();
  const silence = outcomes.at(-1);
  assert.equal(silence.kind, 'intentional-silence');
  assert.equal(silence.stage, null);

  // A generation failure and a send failure stay separate outcome kinds.
  clock.advance(1000);
  fixture.setReply(() => new Error('provider down'));
  await fixture.chat.handleMessage(incoming({ id: 'I-4', text: 'oi bot' }));
  assert.equal(fixture.memory.inspect.turnOutcomes().at(-1).kind, 'failed');

  clock.advance(1000);
  fixture.setReply(() => ({ text: 'Kanker goed.' }));
  fixture.sender.failSend = true;
  await fixture.chat.handleMessage(incoming({ id: 'I-5', text: 'oi bot' }));
  const sendFailure = fixture.memory.inspect.turnOutcomes().at(-1);
  assert.equal(sendFailure.kind, 'failed');
  assert.equal(sendFailure.stage, 'send');

  const kinds = fixture.memory.inspect.turnOutcomes().map((outcome) => outcome.kind);
  assert.ok(kinds.includes('intentional-silence'));
  assert.ok(kinds.includes('reply-sent'));
  assert.ok(kinds.includes('failed'));
});

// Supplementary coverage for replay idempotency across reconnects, which
// underpins the ordering and persistence scenarios above.
test('replayed WhatsApp messages are handled idempotently', async (t) => {
  const clock = createClock();
  const fixture = createChatFixture({ clock });
  t.after(() => fixture.memory.close());

  const replayed = incoming({ id: 'RE-1', text: 'hoi' });
  await fixture.chat.handleMessage(replayed);

  assert.equal(fixture.sender.sent.length, 1);
  const messagesAfterFirst = fixture.memory.inspect.messageCount();
  const outcomesAfterFirst = fixture.memory.inspect.turnOutcomes().length;

  // A reconnect delivers the very same envelope again.
  await fixture.chat.handleMessage(replayed);
  await fixture.chat.handleMessage(replayed);

  assert.equal(fixture.sender.sent.length, 1, 'a replay never produces a second reply');
  assert.equal(fixture.memory.inspect.messageCount(), messagesAfterFirst, 'no duplicated messages');
  assert.equal(fixture.memory.inspect.turnOutcomes().length, outcomesAfterFirst, 'no duplicated turns');
  assert.equal(fixture.memory.inspect.pendingRuns().length, 0, 'no duplicated extraction work');
});

// Supplementary coverage: an envelope first observed as ambient and only later
// presented as addressed is a genuine addressed turn, not a replay.
test('an ambient message that turns out to be addressed is still answered', async (t) => {
  const clock = createClock();
  const fixture = createChatFixture({ clock });
  t.after(() => fixture.memory.close());

  const envelope = incoming({ ...GROUP, id: 'AM-1', addressed: false, text: 'oi wat vind jij' });
  await fixture.chat.handleMessage(envelope);

  assert.equal(fixture.sender.sent.length, 0, 'ambient observation never replies');
  assert.equal(fixture.memory.inspect.turnOutcomes().length, 0);

  clock.advance(1000);
  await fixture.chat.handleMessage({ ...envelope, addressed: true });

  assert.equal(fixture.sender.sent.length, 1, 'the addressed observation of the same envelope is answered');
  assert.equal(fixture.memory.inspect.messageCount(), 2, 'the observed message is not stored twice');
  assert.equal(fixture.memory.inspect.turnOutcomes().at(-1).kind, 'reply-sent');

  // From there on the envelope is a true replay again.
  clock.advance(1000);
  await fixture.chat.handleMessage({ ...envelope, addressed: true });
  assert.equal(fixture.sender.sent.length, 1, 'a finished turn is never replayed into a second reply');
  assert.equal(fixture.memory.inspect.turnOutcomes().length, 1);
});

// Supplementary coverage: remembering happens behind the conversation's FIFO
// slot, so it costs the next message in that conversation no latency.
test('extraction never delays the next message in the same conversation', async (t) => {
  const clock = createClock();
  const fixture = createChatFixture({ clock });
  t.after(() => fixture.memory.close());

  let releaseExtraction;
  const blocked = new Promise((resolve) => {
    releaseExtraction = () => resolve({ memories: [] });
  });
  let extractions = 0;
  fixture.setExtraction(() => {
    extractions += 1;
    return extractions === 1 ? blocked : { memories: [] };
  });

  const first = fixture.chat.handleMessage(incoming({ id: 'B-1', text: 'eerste' }));
  await waitFor(() => fixture.sender.sent.length === 1, 'the first reply was never sent');
  assert.equal(extractions, 1, 'extraction for the first turn is in flight');

  clock.advance(1000);
  const second = fixture.chat.handleMessage(incoming({ id: 'B-2', text: 'tweede' }));
  await waitFor(
    () => fixture.sender.sent.length === 2,
    'the next message waited for the previous extraction'
  );
  assert.deepEqual(
    fixture.sender.sent.map((message) => message.text),
    ['Kanker goed.', 'Kanker goed.'],
    'replies still leave in order'
  );

  releaseExtraction();
  await Promise.all([first, second]);
  assert.equal(fixture.memory.inspect.pendingRuns().length, 0, 'the released extraction still completes');
});

// Supplementary coverage: the freed queue slot only stays safe while the turn
// outcome is committed before the turn yields to extraction. A replay arriving
// mid-extraction must therefore still find a finished turn and be skipped.
test('a replay arriving while extraction is in flight finds a committed outcome', async (t) => {
  const clock = createClock();
  const fixture = createChatFixture({ clock });
  t.after(() => fixture.memory.close());

  let releaseExtraction;
  const blocked = new Promise((resolve) => {
    releaseExtraction = () => resolve({ memories: [] });
  });
  let extractions = 0;
  fixture.setExtraction(() => {
    extractions += 1;
    return extractions === 1 ? blocked : { memories: [] };
  });

  // A reconnect replays the same envelope, so the replay takes the queue slot
  // the moment the first turn releases it and its extraction is still running.
  const envelope = incoming({ id: 'RC-1', text: 'hoi' });
  const first = fixture.chat.handleMessage(envelope);
  const replay = fixture.chat.handleMessage(envelope);

  await replay;

  assert.equal(
    fixture.memory.inspect.turnOutcomes().length,
    1,
    'the outcome is committed before the queue slot is released'
  );
  assert.equal(fixture.sender.sent.length, 1, 'a replay during extraction never produces a second reply');
  assert.equal(fixture.memory.inspect.turnOutcomes().length, 1, 'no second turn outcome');
  assert.equal(extractions, 1, 'no duplicated extraction work');

  releaseExtraction();
  await first;
  assert.equal(fixture.memory.inspect.pendingRuns().length, 0);
});

// Supplementary coverage: one sender outlives every reconnect, so the chat and
// its per-conversation queues can too.
test('the sender keeps writing to the current connection across a reconnect', async () => {
  const sends = [];
  const socketNamed = (name) => ({
    async sendMessage(address, content) {
      sends.push({ name, address, text: content.text });
      return { key: { id: `${name}-1` } };
    },
    async sendPresenceUpdate() {},
  });

  let connection = socketNamed('first');
  // The typing pacing between bubbles is real time in production; the suite
  // injects an instant one so it stays deterministic and offline.
  const sender = createWhatsAppSender(() => connection, () => 0, { sleep: async () => {} });

  await sender.sendText('3120000@s.whatsapp.net', 'voor de reconnect');
  connection = socketNamed('second');
  await sender.sendText('3120000@s.whatsapp.net', 'na de reconnect');

  assert.deepEqual(
    sends.map((entry) => entry.name),
    ['first', 'second'],
    'a reconnect never leaves the sender on the dead socket'
  );

  connection = null;
  await assert.rejects(
    () => sender.sendText('3120000@s.whatsapp.net', 'zonder verbinding'),
    /No WhatsApp connection/
  );
});

test('56. confirms that direct-message and tagged-group routing still work', async (t) => {
  const clock = createClock();
  const fixture = createChatFixture({ clock });
  t.after(() => fixture.memory.close());

  await fixture.chat.handleMessage(incoming({ id: 'D-1', text: 'hoi bot' }));
  assert.equal(fixture.sender.sent.length, 1, 'every direct message is answered');

  clock.advance(1000);
  await fixture.chat.handleMessage(
    incoming({ ...GROUP, id: 'G-1', addressed: true, text: 'oi @FlunkieBot' })
  );
  assert.equal(fixture.sender.sent.length, 2, 'a tagged group message is answered');
  assert.deepEqual(
    fixture.sender.presence.map((entry) => entry.state),
    ['composing', 'paused', 'composing', 'paused']
  );
});

test('57. confirms that ambient group messages persist without causing spontaneous replies', async (t) => {
  const clock = createClock();
  const fixture = createChatFixture({ clock });
  t.after(() => fixture.memory.close());

  await fixture.chat.handleMessage(
    incoming({ ...GROUP, id: 'A-1', addressed: false, text: 'gewoon geouwehoer' })
  );
  clock.advance(1000);
  await fixture.chat.handleMessage(
    incoming({ ...GROUP, id: 'A-2', addressed: false, text: 'nog meer geouwehoer' })
  );

  assert.equal(fixture.sender.sent.length, 0, 'FlunkieBot never replies spontaneously in a group');
  assert.equal(fixture.replyRequests.length, 0, 'no provider is called for an ambient message');
  assert.deepEqual(fixture.sender.presence, [], 'no typing indicator for ambient observation');
  assert.equal(fixture.memory.inspect.messageCount(), 2, 'ambient messages are observed for context');
  assert.equal(fixture.memory.inspect.pendingRuns().length, 0, 'ambient messages create no addressed turn');

  clock.advance(1000);
  await fixture.chat.handleMessage(
    incoming({ ...GROUP, id: 'A-3', addressed: true, text: 'oi @FlunkieBot wat vind jij' })
  );

  const content = fixture.replyRequests[0].messages[0].content;
  const packet = JSON.parse(content.slice(content.indexOf('\n') + 1));
  assert.deepEqual(
    packet.recentMessages.map((message) => message.text),
    ['gewoon geouwehoer', 'nog meer geouwehoer'],
    'the observed ambient context reaches the reply'
  );
});
