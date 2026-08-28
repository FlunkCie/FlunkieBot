import { keywordsOf } from './text.js';
import { resolveParticipantId } from './identity.js';

// How many of the most recent incoming messages contribute retrieval keywords
// on top of the current message.
const KEYWORD_MESSAGE_WINDOW = 5;
const MAX_ASSOCIATED_PARTICIPANTS = 4;

function associatedParticipants(category, row, episodeLinks) {
  if (category === 'participant_claim') return [row.subjectParticipantId];
  if (category === 'interaction_pattern') return [row.participantId];
  const involved = episodeLinks.get(row.id) ?? [];
  return involved.length ? involved : [row.reporterParticipantId];
}

function collectCandidates(store) {
  const episodeLinks = new Map();
  for (const link of store.listEpisodeParticipants()) {
    const list = episodeLinks.get(link.episodeId) ?? [];
    list.push(link.participantId);
    episodeLinks.set(link.episodeId, list);
  }

  const candidates = [];
  const push = (category, row) => {
    candidates.push({
      category,
      id: row.id,
      text: row.text,
      occurredAt: row.occurredAt ?? null,
      createdAt: row.createdAt,
      reporterParticipantId: row.reporterParticipantId ?? null,
      participantIds: associatedParticipants(category, row, episodeLinks),
    });
  };

  for (const row of store.listClaims()) push('participant_claim', row);
  for (const row of store.listEpisodes()) push('episode', row);
  for (const row of store.listInteractionPatterns()) push('interaction_pattern', row);
  return candidates;
}

/**
 * Deterministic keyword-and-recency retrieval. No embeddings, no vector search,
 * no model call: a memory is eligible only when it is associated with a relevant
 * participant and shares at least one normalized keyword with the current
 * message plus the five most recent incoming messages.
 *
 * Returns at most one retrieved memory, or null when nothing is eligible.
 */
export function retrieveMemory(store, { addressedParticipantId, currentText, recentMessages }) {
  const addressedId = addressedParticipantId
    ? resolveParticipantId(store, addressedParticipantId)
    : null;

  const relevantParticipantIds = new Set();
  if (addressedId) relevantParticipantIds.add(addressedId);
  for (const message of recentMessages) {
    if (!message.participantId) continue;
    relevantParticipantIds.add(resolveParticipantId(store, message.participantId));
  }

  const keywords = keywordsOf(currentText);
  const incoming = recentMessages
    .filter((message) => message.direction === 'incoming')
    .slice(-KEYWORD_MESSAGE_WINDOW);
  for (const message of incoming) {
    for (const keyword of keywordsOf(message.text)) keywords.add(keyword);
  }
  if (keywords.size === 0) return null;

  const ranked = [];
  for (const candidate of collectCandidates(store)) {
    const resolvedIds = candidate.participantIds
      .filter(Boolean)
      .map((id) => resolveParticipantId(store, id));
    if (!resolvedIds.some((id) => relevantParticipantIds.has(id))) continue;

    let overlap = 0;
    for (const keyword of keywordsOf(candidate.text)) {
      if (keywords.has(keyword)) overlap += 1;
    }
    if (overlap === 0) continue;

    ranked.push({
      candidate,
      resolvedIds,
      directlyAssociated: addressedId && resolvedIds.includes(addressedId) ? 1 : 0,
      overlap,
    });
  }

  if (ranked.length === 0) return null;

  ranked.sort(
    (a, b) =>
      b.directlyAssociated - a.directlyAssociated ||
      b.overlap - a.overlap ||
      b.candidate.createdAt - a.candidate.createdAt ||
      b.candidate.id - a.candidate.id
  );

  const best = ranked[0];
  const evidence = store.firstEvidence(best.candidate.category, best.candidate.id);

  return {
    category: best.candidate.category,
    text: best.candidate.text,
    participantIds: best.resolvedIds.slice(0, MAX_ASSOCIATED_PARTICIPANTS),
    occurredAt: best.candidate.occurredAt,
    reporterParticipantId: best.candidate.reporterParticipantId,
    evidenceExcerpt: evidence?.excerpt ?? null,
  };
}
