import 'dotenv/config';
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';

// Baileys writes Signal Protocol session dumps directly to process.stdout,
// bypassing the pino logger. Filter them at the stream level.
const STDOUT_NOISE = /^Closing session:|^Decrypted message with closed session/;
for (const stream of [process.stdout, process.stderr]) {
  const _write = stream.write.bind(stream);
  stream.write = function (chunk, encoding, callback) {
    const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (STDOUT_NOISE.test(str.trimStart())) {
      if (typeof encoding === 'function') encoding();
      else if (typeof callback === 'function') callback();
      return true;
    }
    return _write(chunk, encoding, callback);
  };
}
import qrcode from 'qrcode-terminal';
import { createChat } from './chat.js';
import { createMemory, DEFAULT_DB_PATH } from './memory/index.js';
import { parseInitiativeSettings } from './memory/initiative.js';
import { createReplyGeneration } from './reply/index.js';
import { createProviders } from './providers/index.js';
import { createGifSearch } from './gif.js';
import { loadPersonality } from './personality.js';
import { createWhatsAppSender, getBotJids, normalizeEnvelope } from './whatsapp.js';
import { logger, baileysLogger } from './logger.js';
import { acquireLock, releaseLock } from './lock.js';

const MAX_RECONNECT_DELAY_MS = 60_000;
let reconnectAttempts = 0;

function scheduleReconnect(startBot) {
  reconnectAttempts += 1;
  const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** reconnectAttempts);
  logger.warn(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  setTimeout(() => {
    startBot().catch((err) => {
      logger.fatal({ err }, 'Failed to restart bot after disconnect');
      scheduleReconnect(startBot);
    });
  }, delay);
}

async function main() {
  const env = process.env;
  const { replyProviders, extractionProviders } = createProviders(env);

  // Failure to configure any reply provider remains fatal.
  if (replyProviders.length === 0) {
    throw new Error(
      'No LLM providers are configured. Set at least one of GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY in your .env file.'
    );
  }
  logger.info(
    {
      reply: replyProviders.map((p) => p.name),
      extraction: extractionProviders.map((p) => p.name),
    },
    'LLM providers configured, in fallback order'
  );

  const retryPasses = Number(env.LLM_RETRY_PASSES) || 2;
  const retryDelayMs = Number(env.LLM_RETRY_DELAY_MS) || 5000;

  // Unprompted messages are off unless the operator turns them on, and a
  // malformed knob is fatal rather than silently falling back to a setting
  // nobody picked.
  const initiative = parseInitiativeSettings(env);
  logger.info(
    {
      mode: initiative.mode,
      minDays: initiative.minDays,
      weeklyCap: initiative.weeklyCap,
      hours: `${initiative.hours.start}-${initiative.hours.end}`,
      excluded: initiative.excludedNumbers.size,
    },
    'Unprompted messages configured'
  );

  // A database-open, unknown-newer-schema, or migration failure is fatal here:
  // FlunkieBot never silently degrades into a stateless mode.
  const memory = createMemory({
    dbPath: env.MEMORY_DB_PATH || DEFAULT_DB_PATH,
    extractionProviders,
    retryPasses,
    retryDelayMs,
    logger,
    initiative,
  });

  // Pending extraction runs are resumed oldest first before new messages are accepted.
  await memory.start();

  // Without a GIPHY key the bot is never told it can send GIFs, so it never
  // emits a directive that would go nowhere.
  const gifSearch = createGifSearch(env.GIPHY_API_KEY);

  const replyGeneration = createReplyGeneration({
    providers: replyProviders,
    personality: loadPersonality(),
    gifsEnabled: Boolean(gifSearch),
    retryPasses,
    retryDelayMs,
    logger,
  });

  process.on('exit', () => {
    try {
      memory.close();
    } catch {
      // already closed, nothing to clean up
    }
  });

  // Chat orchestration, and with it the per-conversation FIFO queues, lives for
  // the whole process. A reconnect only swaps the socket the sender writes to,
  // so work still in flight can never race a replayed message on a fresh queue.
  let socket = null;
  const chat = createChat({
    memory,
    replyGeneration,
    sender: createWhatsAppSender(() => socket, undefined, { gifSearch, logger }),
    logger,
  });

  async function startBot() {
    logger.info('Starting bot...');
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
      auth: state,
      logger: baileysLogger,
      // Baileys' default (60s) can be tight for a background "props" sync
      // query over Docker's network path; give it more headroom so it doesn't
      // spuriously time out (harmless when it happens, but noisy in logs).
      defaultQueryTimeoutMs: 120_000,
    });

    socket = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrcode.generate(qr, { small: true });
        logger.info('Scan the QR code above with WhatsApp to log in.');
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        logger.error({ err: lastDisconnect?.error, statusCode, shouldReconnect }, 'Connection closed');

        if (shouldReconnect) {
          scheduleReconnect(startBot);
        } else {
          logger.fatal(
            'Logged out of WhatsApp. Delete the auth_info directory and restart to re-link with a fresh QR code.'
          );
        }
      } else if (connection === 'open') {
        reconnectAttempts = 0;
        logger.info('Connected to WhatsApp.');
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      const botJids = getBotJids(sock);
      for (const envelope of messages) {
        try {
          const message = normalizeEnvelope(envelope, { botJids, now: Date.now() });
          if (!message) continue;
          // Errors inside one conversation queue never break the upsert loop.
          chat.handleMessage(message).catch((err) => {
            logger.error({ err, key: envelope.key }, 'Unhandled error while processing message');
          });
        } catch (err) {
          logger.error({ err, key: envelope.key }, 'Failed to normalize message');
        }
      }
    });
  }

  await startBot().catch((err) => {
    logger.fatal({ err }, 'Fatal error starting bot');
    scheduleReconnect(startBot);
  });
}

process.on('exit', releaseLock);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception - exiting for a clean restart');
  process.exit(1);
});

try {
  acquireLock();
} catch (err) {
  logger.fatal({ err }, 'Refusing to start');
  process.exit(1);
}

main().catch((err) => {
  logger.fatal({ err }, 'Refusing to start');
  process.exit(1);
});
