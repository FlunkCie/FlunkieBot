import { jidDecode } from '@whiskeysockets/baileys';
import { sendNaturally } from './natural-send.js';

// WhatsApp normalization: everything Baileys-shaped is translated here into the
// provider-neutral message the rest of the application works with.

// Drop the device suffix (":12") but keep the server (@s.whatsapp.net vs @lid).
// WhatsApp hands out both PN- and LID-style jids for the same account, and
// mentions can arrive in either form, so the bot needs to know all of its jids.
export function normalizeJid(jid) {
  if (!jid) return null;
  const decoded = jidDecode(jid);
  if (!decoded) return jid;
  return `${decoded.user}@${decoded.server}`;
}

export function aliasKindOf(jid) {
  if (!jid) return null;
  return jid.endsWith('@lid') ? 'lid' : 'phone';
}

export function toAlias(jid) {
  const value = normalizeJid(jid);
  if (!value) return null;
  return { kind: aliasKindOf(value), value };
}

export function getBotJids(sock) {
  const candidates = [sock.user?.id, sock.user?.lid, sock.user?.phoneNumber];
  return new Set(candidates.filter(Boolean).map(normalizeJid));
}

// Supported message formats: plain text, extended text, and image or video
// captions. Anything else contributes no context.
export function extractText(message) {
  if (!message) return null;
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    null
  );
}

export function isBotMentioned(message, botJids) {
  const mentionedJids =
    message?.extendedTextMessage?.contextInfo?.mentionedJid ||
    message?.imageMessage?.contextInfo?.mentionedJid ||
    message?.videoMessage?.contextInfo?.mentionedJid ||
    [];
  return mentionedJids.some((jid) => botJids.has(normalizeJid(jid)));
}

/**
 * Translates one Baileys envelope into a normalized message, or null when the
 * message is not supported. Group replies still require an @FlunkieBot tag:
 * ambient group messages are observed but never answered spontaneously.
 */
export function normalizeEnvelope(envelope, { botJids, now }) {
  if (!envelope?.message) return null;
  if (envelope.key?.fromMe) return null;
  if (envelope.key?.remoteJid === 'status@broadcast') return null;

  const conversationAddress = normalizeJid(envelope.key?.remoteJid);
  if (!conversationAddress) return null;

  const isGroup = conversationAddress.endsWith('@g.us');
  const raw = extractText(envelope.message);
  if (!raw) return null;

  // Strip the raw "@<number>" mention token so it never reaches a model as text.
  const text = raw.replace(/@\d+/g, '').trim();
  if (!text) return null;

  const senderJid = isGroup ? envelope.key?.participant : envelope.key?.remoteJid;
  const senderAlias = toAlias(senderJid);
  // Baileys exposes the opposite-namespace jid on the same envelope when
  // WhatsApp supplies it; that is the only accepted alias pairing evidence.
  const pairedJid = isGroup
    ? envelope.key?.participantAlt ?? envelope.key?.participantPn ?? envelope.key?.participantLid
    : envelope.key?.remoteJidAlt ?? envelope.key?.remoteJidPn ?? envelope.key?.remoteJidLid;
  const pairedCandidate = toAlias(pairedJid);
  const pairedAlias =
    pairedCandidate && senderAlias && pairedCandidate.kind !== senderAlias.kind
      ? pairedCandidate
      : null;

  return {
    conversationAddress,
    conversationKind: isGroup ? 'group' : 'direct',
    conversationLabel: isGroup ? envelope.groupSubject ?? null : envelope.pushName ?? null,
    whatsappMessageId: envelope.key?.id,
    text,
    observedAt: envelope.messageTimestamp ? Number(envelope.messageTimestamp) * 1000 : now,
    // A direct message always addresses FlunkieBot; a group message only when tagged.
    addressed: isGroup ? isBotMentioned(envelope.message, botJids) : true,
    senderLabel: envelope.pushName ?? null,
    senderAlias,
    pairedAlias,
    quoted: isGroup ? envelope : null,
  };
}

/**
 * Wraps a Baileys socket in the small sender interface orchestration needs.
 * One reply text may reach WhatsApp as several bubbles; that is transport
 * presentation and stays entirely inside this adapter. The turn is correlated
 * with the first bubble, and the whole reply text is what gets remembered.
 */
export function createWhatsAppSender(sock, clock = () => Date.now(), { gifSearch, logger } = {}) {
  return {
    async sendText(conversationAddress, text, { quoted } = {}) {
      const sent = await sendNaturally(sock, conversationAddress, text, {
        quoted,
        gifSearch,
        logger,
      });
      return {
        whatsappMessageId: sent?.key?.id ?? `local-${clock()}`,
        text,
        sentAt: clock(),
      };
    },
    async sendPresence(conversationAddress, state) {
      await sock.sendPresenceUpdate(state, conversationAddress);
    },
  };
}
