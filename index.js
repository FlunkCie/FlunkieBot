import 'dotenv/config';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  jidDecode,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { askLLM } from './llm.js';
import { getHistory, appendHistory } from './history.js';
import { logger, baileysLogger } from './logger.js';
import { acquireLock, releaseLock } from './lock.js';
import { sendNaturally } from './chat.js';

const MAX_RECONNECT_DELAY_MS = 60_000;
let reconnectAttempts = 0;

// Drop the device suffix (":12") but keep the server (@s.whatsapp.net vs @lid) —
// WhatsApp now hands out both PN- and LID-style jids for the same account, and
// mentions can arrive in either form, so the bot needs to know all of its own jids.
function normalizeJid(jid) {
  const decoded = jidDecode(jid);
  if (!decoded) return jid;
  return `${decoded.user}@${decoded.server}`;
}

function getBotJids(sock) {
  const candidates = [sock.user?.id, sock.user?.lid, sock.user?.phoneNumber];
  return new Set(candidates.filter(Boolean).map(normalizeJid));
}

function extractText(message) {
  if (!message) return null;
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    null
  );
}

function isBotMentioned(message, botJids) {
  const mentionedJids = message.extendedTextMessage?.contextInfo?.mentionedJid || [];
  return mentionedJids.some((jid) => botJids.has(normalizeJid(jid)));
}

function scheduleReconnect() {
  reconnectAttempts += 1;
  const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** reconnectAttempts);
  logger.warn(`Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
  setTimeout(() => {
    startBot().catch((err) => {
      logger.fatal({ err }, 'Failed to restart bot after disconnect');
      scheduleReconnect();
    });
  }, delay);
}

async function handleMessage(sock, msg) {
  if (!msg.message) return;
  if (msg.key.fromMe) return;
  if (msg.key.remoteJid === 'status@broadcast') return;

  const jid = msg.key.remoteJid;
  const isGroup = jid.endsWith('@g.us');

  if (isGroup) {
    const botJids = getBotJids(sock);
    const mentioned = isBotMentioned(msg.message, botJids);
    logger.debug(
      { botJids: [...botJids], mentionedJid: msg.message.extendedTextMessage?.contextInfo?.mentionedJid, mentioned },
      'Checked group mention'
    );
    if (!mentioned) return;
  }

  const text = extractText(msg.message);
  if (!text) return;

  // Strip the raw "@<number>" mention token so it isn't sent to Gemini as part of the prompt.
  const prompt = text.replace(/@\d+/g, '').trim();
  if (!prompt) return;

  try {
    await sock.sendPresenceUpdate('composing', jid).catch((err) => {
      logger.warn({ err, jid }, 'Failed to send composing presence');
    });

    const messages = [...getHistory(jid), { role: 'user', content: prompt }];
    const reply = await askLLM(messages);

    // askLLM already guarantees a valid non-empty string, but never send
    // anything to WhatsApp on the strength of an assumption alone.
    if (typeof reply !== 'string' || reply.trim().length === 0) {
      throw new Error(`Refusing to send invalid LLM reply: ${JSON.stringify(reply)}`);
    }

    appendHistory(jid, 'user', prompt);
    appendHistory(jid, 'assistant', reply);
    // Quoting only matters in groups, where it ties the reply to the message
    // that mentioned the bot. In a 1:1 chat it's just noise.
    await sendNaturally(sock, jid, reply, { quoted: isGroup ? msg : undefined });
  } catch (err) {
    logger.error({ err, jid }, 'Failed to get/send LLM reply');
    try {
      await sock.sendMessage(
        jid,
        { text: "Sorry, I couldn't process that right now.", linkPreview: null },
        isGroup ? { quoted: msg } : undefined
      );
    } catch (sendErr) {
      logger.error({ err: sendErr, jid }, 'Failed to send fallback error message');
    }
  } finally {
    await sock.sendPresenceUpdate('paused', jid).catch((err) => {
      logger.warn({ err, jid }, 'Failed to send paused presence');
    });
  }
}

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
      logger.error(
        { err: lastDisconnect?.error, statusCode, shouldReconnect },
        'Connection closed'
      );

      if (shouldReconnect) {
        scheduleReconnect();
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

    for (const msg of messages) {
      try {
        await handleMessage(sock, msg);
      } catch (err) {
        logger.error({ err, key: msg.key }, 'Unhandled error while processing message');
      }
    }
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

startBot().catch((err) => {
  logger.fatal({ err }, 'Fatal error starting bot');
  scheduleReconnect();
});
