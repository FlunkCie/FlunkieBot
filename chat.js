import { logger } from './logger.js';
import { searchGif } from './gif.js';

const MIN_TYPING_MS = 500;
const MAX_TYPING_MS = 4000;
const MS_PER_CHAR = 45;
const MIN_GAP_MS = 300;
const MAX_GAP_MS = 900;
const MIN_GIF_PAUSE_MS = 600;
const MAX_GIF_PAUSE_MS = 1500;

// A bubble that's just this directive on its own sends a GIF instead of
// text — see the gifAddendum in prompt.js for how the model is told to use it.
const GIF_DIRECTIVE = /^\[gif:\s*(.+?)\]$/i;

// A single bubble longer than this reads as a wall of text, not a text
// message — force-split it even if the model never used the ||| marker.
const AUTO_SPLIT_THRESHOLD = 220;
const MAX_CHUNK_CHARS = 220;

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The system prompt instructs the LLM that it may split a reply into several
// WhatsApp bubbles by putting "|||" between them, the way a person sends a
// quick burst of texts instead of one block. Models are inconsistent about
// exactly where they place it — sometimes on its own line, sometimes glued
// to the following text on the same line — so split on the literal token
// wherever it appears rather than requiring it to be an isolated line.
function splitOnMarker(reply) {
  return reply
    .split('|||')
    .map((part) => part.trim())
    .filter(Boolean);
}

// Breaks a wall of text into bubble-sized chunks: prefer paragraph breaks
// (blank lines) if the model left any, otherwise fall back to grouping
// sentences until a chunk would exceed the max bubble size.
function autoSplitLongText(text) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragraphs.length > 1) {
    return paragraphs.flatMap((p) => (p.length > MAX_CHUNK_CHARS ? splitBySentences(p) : [p]));
  }

  return splitBySentences(text);
}

function splitBySentences(text) {
  const sentences = (text.match(/[^.!?\n]+[.!?]+(?=\s|$)|[^.!?\n]+$/g) || [text])
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (current && candidate.length > MAX_CHUNK_CHARS) {
      chunks.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}

// The system prompt instructs the LLM that it may split a reply into several
// WhatsApp bubbles by putting a line containing only "|||" between them, the
// way a person sends a quick burst of texts instead of one block. Models
// don't reliably follow that for longer replies (a story tends to come back
// as one giant paragraph), so anything still too long after that split gets
// force-broken into bubble-sized chunks too.
export function splitIntoMessages(reply) {
  return splitOnMarker(reply).flatMap((part) =>
    part.length > AUTO_SPLIT_THRESHOLD ? autoSplitLongText(part) : [part]
  );
}

// Roughly how long a person would take to type this out, capped so a long
// message doesn't leave the other side staring at "typing..." forever.
function typingDelayFor(text) {
  return Math.min(MAX_TYPING_MS, Math.max(MIN_TYPING_MS, text.length * MS_PER_CHAR));
}

// Resolves a "[gif: query]" bubble to a GIPHY gif and sends it as a
// gif-playback video. Search failures (no results, API hiccup) just drop
// that bubble rather than failing the whole reply or falling back to
// awkwardly texting out the raw directive.
async function sendGifPart(sock, jid, query, options) {
  await sleep(randomBetween(MIN_GIF_PAUSE_MS, MAX_GIF_PAUSE_MS));
  let url;
  try {
    url = await searchGif(query);
  } catch (err) {
    logger.warn({ err, query, jid }, 'Failed to find gif, skipping bubble');
    return;
  }
  await sock.sendMessage(jid, { video: { url }, gifPlayback: true }, options);
}

async function sendTextPart(sock, jid, text, options) {
  await sleep(typingDelayFor(text));
  await sock.sendMessage(jid, { text, linkPreview: null }, options);
}

// Sends a (possibly multi-bubble) reply the way a person would: a "composing"
// pause before each bubble, sized to how long it'd take to type, then a short
// breather before the next one. Only the first bubble is quoted, since that's
// the one that ties the reply to the message that triggered it.
export async function sendNaturally(sock, jid, reply, { quoted } = {}) {
  const parts = splitIntoMessages(reply);
  if (parts.length === 0) return;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const options = quoted && i === 0 ? { quoted } : undefined;

    await sock.sendPresenceUpdate('composing', jid).catch((err) => {
      logger.warn({ err, jid }, 'Failed to send composing presence');
    });

    const gifMatch = part.match(GIF_DIRECTIVE);
    if (gifMatch) {
      await sendGifPart(sock, jid, gifMatch[1], options);
    } else {
      await sendTextPart(sock, jid, part, options);
    }

    if (i < parts.length - 1) {
      await sleep(randomBetween(MIN_GAP_MS, MAX_GAP_MS));
    }
  }
}
