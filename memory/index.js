import { createStore } from './store.js';
import { resolveParticipant, resolveParticipantId } from './identity.js';
import { retrieveMemory } from './retrieval.js';
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
 * pruning, and exposes exactly three asynchronous memory operations:
 * `observeMessage`, `prepareAddressedTurn` and `finishAddressedTurn`.
 * `start` and `close` are lifecycle hooks, not memory operations.
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
} = {}) {
  const store = createStore({ path: dbPath, migrations });

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

      const existing = store.findMessageByKey(conversation.id, observation.whatsappMessageId);
      if (existing) {
        // Observation is idempotent for conversation address plus WhatsApp
        // message id: a replayed message never duplicates its addressed turn.
        const run = store.findRunByMessage(existing.id);
        return { messageId: existing.id, addressedTurnId: run ? String(run.id) : null };
      }

      const participantId = resolveParticipant(store, {
        alias: observation.senderAlias ?? null,
        pairedAlias: observation.pairedAlias ?? null,
        now,
        newId: newParticipantId,
      });

      const addressed = Boolean(observation.addressed) && observation.direction === 'incoming';

      // The addressed incoming message and its pending extraction run are
      // created in one transaction.
      const write = store.transaction(() => {
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

      const labelEntries = [];
      const seen = new Set();
      const addEntry = (participantId, displayName) => {
        if (!participantId) return;
        const resolved = resolveParticipantId(store, participantId);
        if (seen.has(resolved)) return;
        seen.add(resolved);
        labelEntries.push({ participantId: resolved, displayName: displayName ?? null });
      };
      for (const item of recent) {
        if (item.direction === 'outgoing') continue;
        addEntry(item.participantId, item.authorLabel);
      }
      addEntry(addressedParticipantId, message.authorLabel);
      for (const participantId of retrievedMemory?.participantIds ?? []) addEntry(participantId, null);
      if (retrievedMemory?.reporterParticipantId) {
        addEntry(retrievedMemory.reporterParticipantId, null);
      }

      const labels = assignLabels(labelEntries);
      const labelOf = (participantId) =>
        participantId ? labels.get(resolveParticipantId(store, participantId)) ?? null : null;

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

