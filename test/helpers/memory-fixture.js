import { createMemory } from '../../memory/index.js';
import { temporaryDatabasePath } from './temp-database.js';
import { observation } from './messages.js';

/** Reads the extraction packet back out of a provider-neutral request. */
export function parsePacket(request) {
  const content = request.messages[0].content;
  return JSON.parse(content.slice(content.indexOf('\n') + 1));
}

export function triggerOf(packet) {
  return packet.messages.find((message) => message.handle === packet.trigger);
}

/**
 * A memory module wired to one programmable fake extraction provider, plus the
 * small amount of turn choreography most memory tests need.
 */
export function createMemoryFixture({ clock, dbPath = temporaryDatabasePath(), respond } = {}) {
  let responder = respond ?? (() => ({ memories: [] }));
  const requests = [];

  const provider = {
    name: 'fake-extraction',
    async generate(request) {
      requests.push(request);
      const packet = parsePacket(request);
      const result = await responder(packet, requests.length, request);
      if (result instanceof Error) throw result;
      return { text: typeof result === 'string' ? result : JSON.stringify(result) };
    },
  };

  const memory = createMemory({
    dbPath,
    clock: clock.now,
    extractionProviders: [provider],
    retryPasses: 1,
    sleep: async () => {},
  });

  return {
    memory,
    provider,
    requests,
    dbPath,
    setExtraction(next) {
      responder = typeof next === 'function' ? next : () => next;
    },
    /** Observes an addressed message and finishes the turn with a sent reply. */
    async completeTurn(overrides = {}, replyText = 'Kanker goed.') {
      const observed = await memory.observeMessage(observation(overrides));
      await memory.prepareAddressedTurn(observed.addressedTurnId);
      clock.advance(10);
      await memory.finishAddressedTurn(observed.addressedTurnId, {
        kind: 'reply-sent',
        sentMessage: {
          whatsappMessageId: `OUT-${observed.addressedTurnId}`,
          text: replyText,
          sentAt: clock.now(),
        },
      });
      return observed;
    },
  };
}

/** A well-formed participant claim referencing the trigger of the packet. */
export function claimBatch(packet, text = 'Drinkt alleen nog Buzzballz') {
  const trigger = triggerOf(packet);
  return {
    memories: [
      {
        category: 'participant_claim',
        text,
        subject: trigger.author,
        reporter: trigger.author,
        involved: [trigger.author],
        occurredAt: null,
        evidence: [{ message: trigger.handle, excerpt: trigger.text.slice(0, 24) }],
      },
    ],
  };
}
