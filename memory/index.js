import { createStore } from './store.js';
import { resolveParticipant, resolveParticipantId } from './identity.js';
import { retrieveMemory } from './retrieval.js';
import { initiativeSettings, selectInitiativeTarget } from './initiative.js';
import {
  buildExtractionPacket,
  buildExtractionRequest,
  persistExtractionBatch,
  validateExtractionResult,
} from './extraction.js';
import { runWithProviderFallback } from '../provider-fallback.js';

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
export const RECENT_CONTEXT_LIMIT = 25;
export const DEFAULT_DB_PATH = './data/flunkiebot.sqlite';

const BOT_LABEL = 'FlunkieBot';

// Presentation labels are best effort and never identity. A missing name, or a
// name shared by two distinct participants inside this context, falls back to a
// deterministic context-local label.
function assignLabels(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const name = entry.displayName?.trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const labels = new Map();
  entries.forEach((entry, index) => {
    const name = entry.displayName?.trim();
    labels.set(entry.participantId, name && counts.get(name) === 1 ? name : `Participant ${index + 1}`);
  });
  return labels;
}

/**
 * The memory module. It exclusively owns the SQLite connection, participant
 * identity, temporary conversation messages, durable memories, extraction and
 * pruning.
 *
 * It exposes the three addressed-turn operations `observeMessage`,
 * `prepareAddressedTurn` and `finishAddressedTurn`, plus one initiative
 * operation for unprompted messages, split into the same prepare/finish pair:
 * `prepareInitiative` picks a target and delivers its context, and
 * `finishInitiative` records what was actually sent.
 * `start` and `close` are lifecycle hooks, not memory operations.
 *
 * `finishAddressedTurn` commits the visible turn outcome before it yields and
 * only then resolves once extraction has succeeded or exhausted its bounded
 * fallback, so a caller that does not await it still observes the committed
 * outcome immediately.
 */
export function createMemory({
  dbPath = DEFAULT_DB_PATH,
  migrations,
  clock = () => Date.now(),
  extractionProviders = [],
  retryPasses = 2,
  retryDelayMs = 5000,
  sleep,
  logger,
  newParticipantId,
  initiative,
} = {}) {
  const store = createStore({ path: dbPath, migrations });
  const initiativePolicy = initiativeSettings(initiative);

  // Initiatives that have been selected but not yet sent. They already count
  // against both halves of the budget, so two turns finishing at the same time
  // in different conversations can never spend the same slot twice.
  const reservedInitiatives = new Map();
  let nextReservationId = 1;

  function prune() {
    // A pruning failure is logged and retried at the next pruning opportunity:
    // temporary over-retention beats deleting unrelated records.
    try {
      const removed = store.deleteMessagesOlderThan(clock() - SEVEN_DAYS_MS);
      if (removed) logger?.debug?.({ removed }, 'Pruned expired conversation messages');
    } catch (err) {
      logger?.warn?.({ err }, 'Pruning failed, retrying at the next opportunity');
    }
  }

  // Collects the participants that appear in one piece of model context and
  // hands back a label lookup for them. Labels are context-local presentation
  // only: internal participant ids never reach a model.
  function startNaming() {
    const entries = [];
    const seen = new Set();
    return {
      add(participantId, displayName) {
        if (!participantId) return;
        const resolved = resolveParticipantId(store, participantId);
        if (seen.has(resolved)) return;
        seen.add(resolved);
        entries.push({ participantId: resolved, displayName: displayName ?? null });
      },
      resolve() {
        const labels = assignLabels(entries);
        return (participantId) =>
          participantId ? labels.get(resolveParticipantId(store, participantId)) ?? null : null;
      },
    };
  }

  function conversationFor(observation, now) {
    const existing = store.findConversation(observation.conversationAddress);
    if (existing) {
      if (observation.conversationLabel && observation.conversationLabel !== existing.label) {
        store.updateConversationLabel(existing.id, observation.conversationLabel);
        return { ...existing, label: observation.conversationLabel };
      }
      return existing;
    }
    return store.insertConversation(
      observation.conversationAddress,
      observation.conversationKind,
      observation.conversationLabel ?? null,
      now
    );
  }

  async function runExtraction(run) {
    const message = run.messageId ? store.findMessageById(run.messageId) : null;
    const conversation = store.findConversationById(run.conversationId);
    if (!message || !conversation) {
      // The trigger expired before extraction could run; record the failure
      // rather than leaving the run pending forever.
      store.setRunState(run.id, 'failed', clock());
      return;
    }

    const packet = buildExtractionPacket(store, { triggerMessage: message, conversation });
    const request = buildExtractionRequest(packet);

    try {
      const memories = await runWithProviderFallback({
        providers: extractionProviders,
        request,
        label: 'extraction',
        retryPasses,
        retryDelayMs,
        perProviderRetries: 2,
        sleep,
        logger,
        attempt: async (provider, immutableRequest) => {
          const result = await provider.generate(immutableRequest);
          return validateExtractionResult(result.text, packet);
        },
      });

      persistExtractionBatch(store, packet, memories, clock());
      store.setRunState(run.id, 'succeeded', clock());
    } catch (err) {
      // Exhausted fallback writes nothing and records a failed extraction rather
      // than pretending that no memory was worthwhile.
      logger?.warn?.({ err }, 'Extraction failed, no durable memory written');
      store.setRunState(run.id, 'failed', clock());
    }
  }

  return {
    async start() {
      prune();
      // A crash leaves runs pending; resume them oldest first before accepting
      // new messages so recovery is deterministic.
      for (const run of store.listPendingRuns()) {
        await runExtraction(run);
      }
    },

    close() {
      store.close();
    },

    async observeMessage(observation) {
      const now = observation.observedAt ?? clock();
      const conversation = conversationFor(observation, now);

      const addressed = Boolean(observation.addressed) && observation.direction === 'incoming';

      const existing = store.findMessageByKey(conversation.id, observation.whatsappMessageId);
      if (existing) {
        // Observation is idempotent for conversation address plus WhatsApp
        // message id: a replayed message never duplicates its addressed turn.
        const run = store.findRunByMessage(existing.id);
        if (run) {
          // A turn whose outcome is already recorded is finished, so a reconnect
          // replaying it must not produce a second reply or a second extraction
          // run; a turn still pending after a crash is returned so it can finish.
          const finished = store.findTurnOutcome(run.id);
          return { messageId: existing.id, addressedTurnId: finished ? null : String(run.id) };
        }

        // A message first seen as ambient and only now presented as addressed is
        // not a replay: it gets its addressed turn exactly as a first addressed
        // observation would.
        if (!addressed || existing.direction !== 'incoming') {
          return { messageId: existing.id, addressedTurnId: null };
        }

        const promote = store.transaction(() => {
          store.markMessageAddressed(existing.id);
          return store.insertExtractionRun(
            existing.id,
            conversation.id,
            observation.whatsappMessageId,
            now
          );
        });
        return { messageId: existing.id, addressedTurnId: String(promote()) };
      }

      // Identity resolution, the message and its pending extraction run are
      // written in one transaction.
      const write = store.transaction(() => {
        const participantId = resolveParticipant(store, {
          alias: observation.senderAlias ?? null,
          pairedAlias: observation.pairedAlias ?? null,
          now,
          newId: newParticipantId,
        });
        const messageId = store.insertMessage({
          conversationId: conversation.id,
          participantId,
          whatsappMessageId: observation.whatsappMessageId,
          direction: observation.direction,
          observedAt: now,
          addressed,
          text: observation.text,
          authorLabel: observation.senderLabel ?? null,
        });
        const runId = addressed
          ? store.insertExtractionRun(
              messageId,
              conversation.id,
              observation.whatsappMessageId,
              now
            )
          : null;
        // An incoming message in a direct thread answers every unprompted
        // message still waiting for one there. Replied-to initiatives do not
        // count towards the stop rule, exactly as WhatsApp's own limit on
        // unanswered messages works.
        if (participantId && observation.direction === 'incoming' && conversation.kind === 'direct') {
          store.markInitiativesReplied(participantId, conversation.id, now);
        }
        return { messageId, runId };
      });

      const { messageId, runId } = write();

      if (observation.direction === 'incoming') prune();

      return { messageId, addressedTurnId: runId === null ? null : String(runId) };
    },

    async prepareAddressedTurn(addressedTurnId) {
      const run = store.findRunById(Number(addressedTurnId));
      if (!run || !run.messageId) {
        throw new Error(`Unknown addressed turn ${addressedTurnId}`);
      }
      const message = store.findMessageById(run.messageId);
      if (!message) throw new Error(`Addressed turn ${addressedTurnId} has no message`);

      const conversation = store.findConversationById(message.conversationId);
      const recent = store
        .recentMessages(message.conversationId, message.id, RECENT_CONTEXT_LIMIT)
        .reverse();

      const addressedParticipantId = message.participantId
        ? resolveParticipantId(store, message.participantId)
        : null;

      let retrievedMemory = null;
      try {
        retrievedMemory = retrieveMemory(store, {
          addressedParticipantId,
          currentText: message.text,
          recentMessages: recent,
        });
      } catch (err) {
        // A retrieval failure behaves exactly like no retrieved memory and may
        // still yield a personality-only reply.
        logger?.warn?.({ err }, 'Retrieval failed, continuing without a durable memory');
        retrievedMemory = null;
      }

      const naming = startNaming();
      for (const item of recent) {
        if (item.direction === 'outgoing') continue;
        naming.add(item.participantId, item.authorLabel);
      }
      naming.add(addressedParticipantId, message.authorLabel);
      for (const participantId of retrievedMemory?.participantIds ?? []) naming.add(participantId, null);
      if (retrievedMemory?.reporterParticipantId) {
        naming.add(retrievedMemory.reporterParticipantId, null);
      }
      const labelOf = naming.resolve();

      return {
        conversation: { kind: conversation.kind, label: conversation.label ?? null },
        addressedParticipant: {
          id: addressedParticipantId,
          label: labelOf(addressedParticipantId),
        },
        messageToAnswer: { messageId: message.id, text: message.text },
        recentMessages: recent.map((item) => ({
          authorId: item.direction === 'outgoing' ? null : resolveParticipantId(store, item.participantId),
          authorLabel: item.direction === 'outgoing' ? BOT_LABEL : labelOf(item.participantId),
          direction: item.direction,
          text: item.text,
          observedAt: item.observedAt,
          addressedBot: Boolean(item.addressed),
        })),
        retrievedMemory: retrievedMemory && {
          category: retrievedMemory.category,
          text: retrievedMemory.text,
          participantIds: retrievedMemory.participantIds,
          participantLabels: retrievedMemory.participantIds.map(labelOf).filter(Boolean),
          occurredAt: retrievedMemory.occurredAt,
          reporterId: retrievedMemory.reporterParticipantId,
          reporterLabel: labelOf(retrievedMemory.reporterParticipantId),
          evidenceExcerpt: retrievedMemory.evidenceExcerpt,
        },
      };
    },

    async finishAddressedTurn(addressedTurnId, outcome) {
      const run = store.findRunById(Number(addressedTurnId));
      if (!run) throw new Error(`Unknown addressed turn ${addressedTurnId}`);
      const message = run.messageId ? store.findMessageById(run.messageId) : null;

      const storeSent = (sent, forConversationId) =>
        store.insertMessage({
          conversationId: forConversationId,
          participantId: null,
          whatsappMessageId: sent.whatsappMessageId,
          direction: 'outgoing',
          observedAt: sent.sentAt,
          addressed: false,
          text: sent.text,
          authorLabel: BOT_LABEL,
        });

      // Commit the visible outcome first; extraction never delays or retracts it.
      const commit = store.transaction(() => {
        let sentMessageId = null;
        let notificationMessageId = null;

        if (outcome.kind === 'reply-sent') {
          sentMessageId = storeSent(outcome.sentMessage, run.conversationId);
        } else if (outcome.kind === 'failed' && outcome.notificationMessage) {
          notificationMessageId = storeSent(outcome.notificationMessage, run.conversationId);
        }

        store.insertTurnOutcome({
          extractionRunId: run.id,
          messageId: run.messageId,
          kind: outcome.kind,
          stage: outcome.kind === 'failed' ? outcome.stage : null,
          sentMessageId,
          notificationMessageId,
          createdAt: clock(),
        });
      });

      commit();

      if (message) await runExtraction(store.findRunById(run.id));
    },

    /**
     * The first half of the initiative operation: pick at most one participant
     * who may receive an unprompted message right now, and deliver the context
     * for it. Returns null whenever the mode, the send window, either half of
     * the budget, the stop rule or the absence of an occasion says no, which is
     * the overwhelmingly common answer.
     *
     * Selection is deliberately not retrieval. There is no current message to be
     * relevant to, so the rule is "ripe and never used before", not "relevant".
     *
     * The whole body runs synchronously against SQLite, so the budget check and
     * the reservation it hands out can never interleave with another caller.
     */
    async prepareInitiative(afterAddressedTurnId = null) {
      if (initiativePolicy.mode === 'off') return null;

      const now = clock();
      let sourceConversationId = null;
      let sourceParticipantId = null;

      if (afterAddressedTurnId !== null && afterAddressedTurnId !== undefined) {
        const run = store.findRunById(Number(afterAddressedTurnId));
        if (!run) return null;
        sourceConversationId = run.conversationId;
        const message = run.messageId ? store.findMessageById(run.messageId) : null;
        sourceParticipantId = message?.participantId ?? null;
      }

      const target = selectInitiativeTarget(store, {
        now,
        sourceConversationId,
        sourceParticipantId,
        settings: initiativePolicy,
        reserved: [...reservedInitiatives.values()],
      });
      if (!target) return null;

      const conversation = store.findConversationById(target.conversationId);
      const recent = store.recentMessages(target.conversationId, null, RECENT_CONTEXT_LIMIT).reverse();

      const naming = startNaming();
      for (const item of recent) {
        if (item.direction === 'outgoing') continue;
        naming.add(item.participantId, item.authorLabel);
      }
      // The recipient may have said nothing recently enough to still be
      // retained, so their label comes from whatever the store still knows.
      naming.add(
        target.participantId,
        store.authorLabelsOf(target.participantId)[0] ?? conversation.label ?? null
      );
      for (const participantId of target.memory?.participantIds ?? []) naming.add(participantId, null);
      if (target.memory?.reporterParticipantId) naming.add(target.memory.reporterParticipantId, null);
      const labelOf = naming.resolve();

      const initiativeId = String(nextReservationId);
      nextReservationId += 1;
      reservedInitiatives.set(initiativeId, {
        participantId: target.participantId,
        conversationId: target.conversationId,
        occasion: target.occasion,
        memory: target.memory,
      });

      return {
        initiativeId,
        conversationAddress: conversation.address,
        context: {
          conversation: { kind: conversation.kind, label: conversation.label ?? null },
          addressedParticipant: {
            id: target.participantId,
            label: labelOf(target.participantId),
          },
          occasion: target.occasion,
          recentMessages: recent.map((item) => ({
            authorId: item.direction === 'outgoing' ? null : resolveParticipantId(store, item.participantId),
            authorLabel: item.direction === 'outgoing' ? BOT_LABEL : labelOf(item.participantId),
            direction: item.direction,
            text: item.text,
            observedAt: item.observedAt,
            addressedBot: Boolean(item.addressed),
          })),
          retrievedMemory: target.memory && {
            category: target.memory.category,
            text: target.memory.text,
            participantIds: target.memory.participantIds,
            participantLabels: target.memory.participantIds.map(labelOf).filter(Boolean),
            occurredAt: target.memory.occurredAt,
            reporterId: target.memory.reporterParticipantId,
            reporterLabel: labelOf(target.memory.reporterParticipantId),
            evidenceExcerpt:
              store.firstEvidence(target.memory.category, target.memory.id)?.excerpt ?? null,
          },
        },
      };
    },

    /**
     * The second half of the initiative operation: record what was actually
     * sent. Only a delivered message becomes an initiative, because only a
     * delivered message can annoy anyone, can be ignored, or can burn a memory.
     * An abandoned initiative releases its reservation and leaves no trace.
     */
    async finishInitiative(initiativeId, outcome) {
      const reserved = reservedInitiatives.get(String(initiativeId));
      if (!reserved) throw new Error(`Unknown initiative ${initiativeId}`);
      reservedInitiatives.delete(String(initiativeId));

      if (outcome?.kind !== 'sent') return;

      const commit = store.transaction(() => {
        const messageId = store.insertMessage({
          conversationId: reserved.conversationId,
          participantId: null,
          whatsappMessageId: outcome.sentMessage.whatsappMessageId,
          direction: 'outgoing',
          observedAt: outcome.sentMessage.sentAt,
          addressed: false,
          text: outcome.sentMessage.text,
          authorLabel: BOT_LABEL,
        });
        store.insertInitiative({
          // An evidence-backed merge may have absorbed this identity while the
          // message was in flight; the budget must land on the survivor.
          participantId: resolveParticipantId(store, reserved.participantId),
          conversationId: reserved.conversationId,
          occasion: reserved.occasion,
          memoryCategory: reserved.memory?.category ?? null,
          memoryId: reserved.memory?.id ?? null,
          messageId,
          sentAt: outcome.sentMessage.sentAt,
        });
      });

      commit();
    },

    // Test-visible read models. They return domain records, never SQL or
    // physical storage names, so the storage schema stays private.
    inspect: {
      messageCount: () => store.countMessages(),
      claims: () => store.listClaims(),
      episodes: () => store.listEpisodes(),
      episodeParticipants: () => store.listEpisodeParticipants(),
      interactionPatterns: () => store.listInteractionPatterns(),
      evidenceCount: () => store.countEvidence(),
      turnOutcomes: () => store.listTurnOutcomes(),
      initiatives: () => store.listInitiatives(),
      pendingRuns: () => store.listPendingRuns(),
      runState: (turnId) => store.findRunById(Number(turnId))?.state ?? null,
      pairingConflicts: () => store.listPairingConflicts(),
      participantOf: (kind, value) => {
        const alias = store.findAlias(kind, value);
        return alias ? resolveParticipantId(store, alias.participantId) : null;
      },
      aliasesOf: (participantId) => store.aliasesOfParticipant(participantId),
      participantCreatedAt: (participantId) => store.findParticipant(participantId)?.createdAt ?? null,
      completedExchanges: (participantId) => store.countCompletedExchanges(participantId),
      prune: () => prune(),
    },
  };
}

