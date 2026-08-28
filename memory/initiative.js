import { resolveParticipantId } from './identity.js';
import { normalizeText } from './text.js';

// Selection of an unprompted personal message: who may receive one, whether the
// budget still allows it, and which occasion is on the table right now.
//
// The budget is the control here, not the trigger. There are far more valid
// occasions in a week than the budget will ever spend, so these rules mainly
// decide *which* moment gets picked, not how many are sent.

const INITIATIVE_MODES = ['off', 'dm-only'];
const DEFAULT_INITIATIVE_MODE = 'off';
const DEFAULT_INITIATIVE_MIN_DAYS = 14;
const DEFAULT_INITIATIVE_WEEKLY_CAP = 2;
const DEFAULT_INITIATIVE_HOURS = '10-23';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** An episode is ripe once it has been stored for this long. */
const EPISODE_RIPENESS_MS = 14 * DAY_MS;

/** How long someone must have been silent before being poked about a mention. */
const ABSENT_SILENCE_MS = 24 * 60 * 60 * 1000;

/** How far back a mention in the source conversation still counts as "just now". */
const MENTION_WINDOW_MS = 60 * 60 * 1000;

/** Two ignored initiatives in a row put a participant on hold for this long. */
const IGNORED_INITIATIVE_LIMIT = 2;
const IGNORED_BACKOFF_MS = 30 * DAY_MS;

export class InitiativeConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InitiativeConfigurationError';
  }
}

function digitsOf(value) {
  if (typeof value !== 'string') return null;
  const user = value.split('@')[0];
  const digits = user.replace(/\D/g, '');
  return digits.length ? digits : null;
}

function parseHours(raw) {
  const value = String(raw ?? DEFAULT_INITIATIVE_HOURS).trim();
  const match = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(value);
  if (!match) {
    throw new InitiativeConfigurationError(
      `INITIATIVE_HOURS must look like "10-23", not "${value}".`
    );
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start > 23 || end > 23 || start >= end) {
    throw new InitiativeConfigurationError(
      `INITIATIVE_HOURS must be two hours between 0 and 23 with the start before the end, not "${value}".`
    );
  }
  return { start, end };
}

function parsePositiveNumber(raw, fallback, name) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new InitiativeConfigurationError(`${name} must be a number of at least 0, not "${raw}".`);
  }
  return value;
}

/**
 * Reads the initiative knobs out of a plain environment object. A malformed
 * value fails loudly at startup rather than silently degrading into a setting
 * nobody chose.
 */
export function parseInitiativeSettings(env = {}) {
  const mode = String(env.INITIATIVE_MODE ?? DEFAULT_INITIATIVE_MODE).trim() || DEFAULT_INITIATIVE_MODE;
  if (!INITIATIVE_MODES.includes(mode)) {
    throw new InitiativeConfigurationError(
      `INITIATIVE_MODE must be one of ${INITIATIVE_MODES.join(', ')}, not "${mode}".`
    );
  }

  const excludedNumbers = new Set(
    String(env.INITIATIVE_EXCLUDED_NUMBERS ?? '')
      .split(',')
      .map((entry) => digitsOf(entry.trim()))
      .filter(Boolean)
  );

  return {
    mode,
    minDays: parsePositiveNumber(env.INITIATIVE_MIN_DAYS, DEFAULT_INITIATIVE_MIN_DAYS, 'INITIATIVE_MIN_DAYS'),
    weeklyCap: parsePositiveNumber(
      env.INITIATIVE_WEEKLY_CAP,
      DEFAULT_INITIATIVE_WEEKLY_CAP,
      'INITIATIVE_WEEKLY_CAP'
    ),
    hours: parseHours(env.INITIATIVE_HOURS),
    excludedNumbers,
  };
}

/**
 * Normalizes whatever a caller handed in into complete, validated settings, so
 * the same validation covers the environment and a programmatic caller.
 */
export function initiativeSettings(settings = {}) {
  const hours = settings.hours;
  const excluded = settings.excludedNumbers;
  return parseInitiativeSettings({
    INITIATIVE_MODE: settings.mode,
    INITIATIVE_MIN_DAYS: settings.minDays,
    INITIATIVE_WEEKLY_CAP: settings.weeklyCap,
    INITIATIVE_HOURS:
      hours && typeof hours === 'object' ? `${hours.start}-${hours.end}` : hours,
    INITIATIVE_EXCLUDED_NUMBERS:
      excluded && typeof excluded !== 'string' ? [...excluded].join(',') : excluded,
  });
}

/**
 * The send window is expressed in wall-clock hours of the machine FlunkieBot
 * runs on, because that is the hour its participants are living in. Set `TZ` in
 * the environment when the container is not already in the group's timezone.
 */
function withinSendWindow(now, hours) {
  const hour = new Date(now).getHours();
  return hour >= hours.start && hour < hours.end;
}

/** Everyone who already started a direct-message thread with FlunkieBot. */
function directThreadsByParticipant(store) {
  const threads = new Map();
  for (const row of store.listDirectThreads()) {
    const participantId = resolveParticipantId(store, row.participantId);
    // A participant recognized under two aliases can own two direct threads;
    // the newest one is where FlunkieBot last spoke with them.
    if (!threads.has(participantId)) {
      threads.set(participantId, {
        participantId,
        conversationId: row.conversationId,
        address: row.address,
        label: row.label ?? null,
      });
    }
  }
  return threads;
}

function isExcluded(store, thread, excludedNumbers) {
  if (excludedNumbers.size === 0) return false;
  const candidates = [digitsOf(thread.address)];
  for (const alias of store.aliasesOfParticipant(thread.participantId)) {
    candidates.push(digitsOf(alias.value));
  }
  return candidates.some((number) => number && excludedNumbers.has(number));
}

/**
 * The per-person half of the budget: the 14-day cooldown plus the stop rule.
 * Two unprompted messages in a row that nobody answered put this participant on
 * hold for thirty days. That is a technical mitigation, not politeness:
 * unanswered messages are the one WhatsApp mechanism this design actually
 * touches, and a human blocking the bot is the only realistic ban path.
 */
function personalBudgetAllows(store, participantId, now, settings) {
  const recent = store.latestInitiatives(participantId, IGNORED_INITIATIVE_LIMIT);
  if (recent.length === 0) return true;

  if (now - recent[0].sentAt < settings.minDays * DAY_MS) return false;

  const ignored = recent.filter((initiative) => initiative.repliedAt === null);
  if (
    ignored.length >= IGNORED_INITIATIVE_LIMIT &&
    now - recent[0].sentAt < IGNORED_BACKOFF_MS
  ) {
    return false;
  }

  return true;
}

/** The group half of the budget: at most `weeklyCap` initiatives per week. */
function weeklyBudgetAllows(store, now, settings, reservedCount) {
  return store.countInitiativesSince(now - WEEK_MS) + reservedCount < settings.weeklyCap;
}

// Name recognition runs on the presentation labels already stored beside each
// message. No provider call, and deliberately no keyword selection: the
// character investigation measured keyword-driven occasion picking at 6 out of
// 10 on favourable material, which is too unreliable for a message that arrives
// uninvited.
function mentionsLabel(text, label) {
  // The same deterministic normalization retrieval uses, so "José," and "jose"
  // are one name. Whole-word only: "Bo" must not match inside "boter".
  const needle = normalizeText(label);
  if (needle.length < 3) return false;
  return ` ${normalizeText(text)} `.includes(` ${needle} `);
}

/**
 * Occasion 1: someone was discussed *in the group* while they had been silent
 * themselves for at least a day. The strongest occasion on content, and the one
 * most likely to be answered.
 *
 * Only a group counts as a place where someone is discussed. A name dropped in
 * a one-on-one thread is a private remark, and passing it on to a third person
 * is not something FlunkieBot may do.
 */
function discussedWhileAbsent(store, candidates, { now, sourceConversationId }) {
  if (!sourceConversationId) return [];

  const source = store.findConversationById(sourceConversationId);
  if (source?.kind !== 'group') return [];

  const spoken = store.messagesInConversationSince(
    sourceConversationId,
    now - MENTION_WINDOW_MS
  );
  if (spoken.length === 0) return [];

  const found = [];
  for (const candidate of candidates) {
    const lastSeenAt = store.lastIncomingMessageAt(candidate.participantId);
    if (lastSeenAt !== null && now - lastSeenAt < ABSENT_SILENCE_MS) continue;

    // Names must survive the seven-day message retention, or the trigger would
    // silently stop working for exactly the people it is meant for. The label
    // of someone's own direct thread is kept alongside the conversation, which
    // never expires; retained messages only add to it.
    const labels = [
      ...new Set([candidate.label, ...store.authorLabelsOf(candidate.participantId)].filter(Boolean)),
    ];
    if (labels.length === 0) continue;

    const mentioned = spoken.some((message) => {
      if (
        message.participantId &&
        resolveParticipantId(store, message.participantId) === candidate.participantId
      ) {
        return false;
      }
      return labels.some((label) => mentionsLabel(message.text, label));
    });
    if (!mentioned) continue;

    found.push({
      ...candidate,
      occasion: 'discussed-while-absent',
      memory: null,
      silentSince: lastSeenAt ?? 0,
    });
  }

  // The longest silence first, then a stable tie-break on identity.
  found.sort(
    (a, b) => a.silentSince - b.silentSince || (a.participantId < b.participantId ? -1 : 1)
  );
  return found;
}

/** Identifies a durable memory across categories, so reservations can name one. */
function memoryKey(category, id) {
  return `${category}:${id}`;
}

/**
 * Occasion 2: a stored episode has been sitting there for at least a fortnight
 * and has never been used for an initiative. Selection here is ripeness and
 * novelty, not relevance: there is no current message to be relevant to.
 */
function ripeEpisode(store, candidates, { now, reservedMemories }) {
  const byParticipant = new Map();
  for (const candidate of candidates) byParticipant.set(candidate.participantId, candidate);
  if (byParticipant.size === 0) return [];

  const involved = new Map();
  for (const link of store.listEpisodeParticipants()) {
    const list = involved.get(link.episodeId) ?? [];
    list.push(resolveParticipantId(store, link.participantId));
    involved.set(link.episodeId, list);
  }

  const found = [];
  for (const episode of store.listRipeUnusedEpisodes(now - EPISODE_RIPENESS_MS)) {
    // A memory that is already spoken for by a selected-but-not-yet-sent
    // initiative is as spent as one the ledger already records.
    if (reservedMemories.has(memoryKey('episode', episode.id))) continue;

    const participantIds =
      involved.get(episode.id) ??
      (episode.reporterParticipantId
        ? [resolveParticipantId(store, episode.reporterParticipantId)]
        : []);

    for (const participantId of participantIds) {
      const candidate = byParticipant.get(participantId);
      if (!candidate) continue;
      found.push({
        ...candidate,
        occasion: 'ripe-episode',
        memory: {
          category: 'episode',
          id: episode.id,
          text: episode.text,
          occurredAt: episode.occurredAt ?? null,
          reporterParticipantId: episode.reporterParticipantId ?? null,
          participantIds,
        },
      });
      break;
    }
  }

  // Oldest ripe episode first: the stock is worked off in the order it aged.
  return found;
}

/**
 * Picks at most one target for one unprompted message, or null when nothing
 * qualifies. The occasions are tried in the decided order and the budget is
 * checked before either of them: no occasion can spend more than the budget.
 */
export function selectInitiativeTarget(
  store,
  { now, sourceConversationId = null, sourceParticipantId = null, settings, reserved = [] }
) {
  if (settings.mode === 'off') return null;
  if (!withinSendWindow(now, settings.hours)) return null;
  if (!weeklyBudgetAllows(store, now, settings, reserved.length)) return null;

  const reservedParticipants = new Set(reserved.map((entry) => entry.participantId));
  // A reservation holds its recipient, its weekly slot *and* the memory it is
  // about to spend, so two turns finishing concurrently cannot burn the same
  // callback on two different people.
  const reservedMemories = new Set(
    reserved
      .filter((entry) => entry.memory)
      .map((entry) => memoryKey(entry.memory.category, entry.memory.id))
  );
  const excludedSource = sourceParticipantId ? resolveParticipantId(store, sourceParticipantId) : null;

  const candidates = [];
  for (const thread of directThreadsByParticipant(store).values()) {
    if (thread.participantId === excludedSource) continue;
    if (reservedParticipants.has(thread.participantId)) continue;
    if (isExcluded(store, thread, settings.excludedNumbers)) continue;
    if (!personalBudgetAllows(store, thread.participantId, now, settings)) continue;
    candidates.push(thread);
  }
  if (candidates.length === 0) return null;

  const discussed = discussedWhileAbsent(store, candidates, { now, sourceConversationId });
  if (discussed.length > 0) return discussed[0];

  const ripe = ripeEpisode(store, candidates, { now, reservedMemories });
  if (ripe.length > 0) return ripe[0];

  return null;
}
