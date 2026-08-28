import { randomUUID } from 'node:crypto';

// Participant identity is application-owned and evidence-driven. Aliases are
// joined only from explicit pairing evidence carried by one WhatsApp envelope;
// digits, display names, group membership and timing are never used to guess.

// A permanent redirect chain is walked so that absorbed identities keep
// resolving to their surviving participant forever.
export function resolveParticipantId(store, participantId) {
  let current = participantId;
  const seen = new Set();
  for (;;) {
    if (current === null || seen.has(current)) return current;
    seen.add(current);
    const redirect = store.findRedirect(current);
    if (!redirect) return current;
    current = redirect.survivingParticipantId;
  }
}

function participantForAlias(store, alias, now, newId) {
  const existing = store.findAlias(alias.kind, alias.value);
  if (existing) return resolveParticipantId(store, existing.participantId);

  const id = newId();
  store.insertParticipant(id, now);
  store.insertAlias(alias.kind, alias.value, id, now);
  return id;
}

function heldAliasOfKind(store, participantId, kind) {
  return store.aliasesOfParticipant(participantId).find((a) => a.kind === kind) ?? null;
}

function recordConflict(store, alias, counterpart, heldBy, conflicting, now) {
  store.insertPairingConflict({
    aliasKind: alias.kind,
    aliasValue: alias.value,
    counterpartKind: counterpart.kind,
    counterpartValue: counterpart.value,
    heldByParticipantId: heldBy,
    conflictingParticipantId: conflicting,
    observedAt: now,
  });
}

/**
 * Resolves the participant behind one envelope's aliases, joining or merging
 * only where the envelope itself supplies explicit pairing evidence.
 *
 * Participant creation, alias pairing and merging all happen inside one
 * transaction, so an interrupted resolution leaves no half-joined identity.
 *
 * Returns the resolved participant id, or null when the envelope carries no
 * usable alias at all.
 */
export function resolveParticipant(store, { alias, pairedAlias, now, newId = randomUUID }) {
  if (!alias) return null;
  const resolve = store.transaction(() => resolveWithinTransaction(store, { alias, pairedAlias, now, newId }));
  return resolve();
}

function resolveWithinTransaction(store, { alias, pairedAlias, now, newId }) {
  const participantId = participantForAlias(store, alias, now, newId);
  if (!pairedAlias || pairedAlias.kind === alias.kind) return participantId;

  const pairedExisting = store.findAlias(pairedAlias.kind, pairedAlias.value);
  const pairedParticipantId = pairedExisting
    ? resolveParticipantId(store, pairedExisting.participantId)
    : null;

  // Replayed evidence for an already-joined pair is a no-op.
  if (pairedParticipantId === participantId) return participantId;

  const heldByPrimary = heldAliasOfKind(store, participantId, pairedAlias.kind);
  if (heldByPrimary && heldByPrimary.value !== pairedAlias.value) {
    // This alias already carries different pairing evidence for that namespace.
    recordConflict(store, alias, pairedAlias, participantId, pairedParticipantId, now);
    return participantId;
  }

  if (pairedParticipantId === null) {
    store.insertAlias(pairedAlias.kind, pairedAlias.value, participantId, now);
    return participantId;
  }

  const heldByPaired = heldAliasOfKind(store, pairedParticipantId, alias.kind);
  if (heldByPaired && heldByPaired.value !== alias.value) {
    recordConflict(store, alias, pairedAlias, pairedParticipantId, participantId, now);
    return participantId;
  }

  return mergeParticipants(store, participantId, pairedParticipantId, now);
}

// The oldest identity survives an evidence-backed merge; the absorbed identity
// becomes a permanent redirect so every durable reference still resolves.
export function mergeParticipants(store, aId, bId, now) {
  const a = store.findParticipant(aId);
  const b = store.findParticipant(bId);
  if (!a || !b) return aId;

  const [survivor, absorbed] =
    a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id <= b.id) ? [a, b] : [b, a];

  store.absorbParticipant(absorbed.id, survivor.id, now);
  return survivor.id;
}
