import { createChat } from '../../chat.js';
import { createMemory } from '../../memory/index.js';
import { createReplyGeneration } from '../../reply/index.js';
import { temporaryDatabasePath } from './temp-database.js';
import { createFakeSender } from './fake-sender.js';

const PERSONALITY = '# IDENTITEIT EN LORE\nFlunkieBot.\n\n# STEM EN GEDRAG\nKanker.';

/**
 * The primary acceptance seam: chat orchestration with normalized WhatsApp
 * messages, a fake WhatsApp sender, real file-backed memory, and reply
 * generation backed by fake providers.
 */
export function createChatFixture({
  clock,
  dbPath = temporaryDatabasePath(),
  reply,
  initiativeReply,
  extraction,
  initiative,
} = {}) {
  let replyResponder = reply ?? (() => ({ text: 'Kanker goed.' }));
  let initiativeResponder = initiativeReply ?? (() => ({ text: 'Ik moest ineens aan je denken.' }));
  let extractionResponder = extraction ?? (() => ({ memories: [] }));

  const replyRequests = [];
  const initiativeRequests = [];

  // One provider serves both reply-generation operations, exactly as in
  // production. An unprompted message is recognizable by its packet: it names
  // an occasion and carries no message to answer.
  const replyProvider = {
    name: 'fake-reply',
    async generate(request) {
      const content = request.messages[0].content;
      const packet = JSON.parse(content.slice(content.indexOf('\n') + 1));

      if (packet.messageToAnswer === undefined) {
        initiativeRequests.push(request);
        const initiated = await initiativeResponder(request, initiativeRequests.length);
        if (initiated instanceof Error) throw initiated;
        return initiated;
      }

      replyRequests.push(request);
      const result = await replyResponder(request, replyRequests.length);
      if (result instanceof Error) throw result;
      return result;
    },
  };

  const extractionProvider = {
    name: 'fake-extraction',
    async generate(request) {
      const content = request.messages[0].content;
      const packet = JSON.parse(content.slice(content.indexOf('\n') + 1));
      const result = await extractionResponder(packet, request);
      if (result instanceof Error) throw result;
      return { text: typeof result === 'string' ? result : JSON.stringify(result) };
    },
  };

  const memory = createMemory({
    dbPath,
    clock: clock.now,
    extractionProviders: [extractionProvider],
    retryPasses: 1,
    sleep: async () => {},
    initiative,
  });

  const replyGeneration = createReplyGeneration({
    providers: [replyProvider],
    personality: PERSONALITY,
    retryPasses: 1,
    sleep: async () => {},
  });

  const sender = createFakeSender({ clock });
  const chat = createChat({ memory, replyGeneration, sender, clock: clock.now });

  return {
    chat,
    memory,
    sender,
    dbPath,
    replyRequests,
    initiativeRequests,
    setReply(next) {
      replyResponder = typeof next === 'function' ? next : () => next;
    },
    setInitiativeReply(next) {
      initiativeResponder = typeof next === 'function' ? next : () => next;
    },
    setExtraction(next) {
      extractionResponder = typeof next === 'function' ? next : () => next;
    },
  };
}
