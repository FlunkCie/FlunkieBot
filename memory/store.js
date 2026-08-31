import { openDatabase } from './database.js';

// Every SQL statement in FlunkieBot lives inside the memory module, and every
// statement inside the memory module lives in this file. Callers work with
// named domain operations and never see a table or column name.
export function createStore({ path, migrations }) {
  const db = openDatabase({ path, migrations });

  const statements = {
    insertParticipant: db.prepare(
      'INSERT INTO participants (id, created_at) VALUES (?, ?)'
    ),
    findParticipant: db.prepare(
      'SELECT id, created_at AS createdAt FROM participants WHERE id = ?'
    ),
    findAlias: db.prepare(
      `SELECT alias_kind AS kind, alias_value AS value,
              participant_id AS participantId, created_at AS createdAt
         FROM participant_aliases WHERE alias_kind = ? AND alias_value = ?`
    ),
    insertAlias: db.prepare(
      `INSERT INTO participant_aliases (alias_kind, alias_value, participant_id, created_at)
       VALUES (?, ?, ?, ?)`
    ),
    aliasesOfParticipant: db.prepare(
      `SELECT alias_kind AS kind, alias_value AS value
         FROM participant_aliases WHERE participant_id = ? ORDER BY alias_kind, alias_value`
    ),
    insertRedirect: db.prepare(
      `INSERT INTO participant_redirects
         (absorbed_participant_id, surviving_participant_id, created_at)
       VALUES (?, ?, ?)`
    ),
    findRedirect: db.prepare(
      `SELECT surviving_participant_id AS survivingParticipantId
         FROM participant_redirects WHERE absorbed_participant_id = ?`
    ),
    insertConflict: db.prepare(
      `INSERT INTO alias_pairing_conflicts
         (alias_kind, alias_value, counterpart_kind, counterpart_value,
          held_by_participant_id, conflicting_participant_id, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ),
    listConflicts: db.prepare(
      `SELECT id, alias_kind AS aliasKind, alias_value AS aliasValue,
              counterpart_kind AS counterpartKind, counterpart_value AS counterpartValue,
              held_by_participant_id AS heldByParticipantId,
              conflicting_participant_id AS conflictingParticipantId,
              observed_at AS observedAt
         FROM alias_pairing_conflicts ORDER BY id`
    ),

    findConversation: db.prepare(
      `SELECT id, address, kind, label FROM conversations WHERE address = ?`
    ),
    findConversationById: db.prepare(
      `SELECT id, address, kind, label FROM conversations WHERE id = ?`
    ),
    insertConversation: db.prepare(
      `INSERT INTO conversations (address, kind, label, created_at) VALUES (?, ?, ?, ?)`
    ),
    updateConversationLabel: db.prepare(
      'UPDATE conversations SET label = ? WHERE id = ?'
    ),

    findMessageByKey: db.prepare(
      `SELECT id, conversation_id AS conversationId, participant_id AS participantId,
              whatsapp_message_id AS whatsappMessageId, direction,
              observed_at AS observedAt, addressed, body AS text,
              author_label AS authorLabel
         FROM messages WHERE conversation_id = ? AND whatsapp_message_id = ?`
    ),
    findMessageById: db.prepare(
      `SELECT id, conversation_id AS conversationId, participant_id AS participantId,
              whatsapp_message_id AS whatsappMessageId, direction,
              observed_at AS observedAt, addressed, body AS text,
              author_label AS authorLabel
         FROM messages WHERE id = ?`
    ),
    insertMessage: db.prepare(
      `INSERT INTO messages
         (conversation_id, participant_id, whatsapp_message_id, direction,
          observed_at, addressed, body, author_label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    markMessageAddressed: db.prepare(
      'UPDATE messages SET addressed = 1 WHERE id = ?'
    ),
    recentMessages: db.prepare(
      `SELECT id, conversation_id AS conversationId, participant_id AS participantId,
              whatsapp_message_id AS whatsappMessageId, direction,
              observed_at AS observedAt, addressed, body AS text,
              author_label AS authorLabel
         FROM messages
        WHERE conversation_id = ? AND id <> ?
        ORDER BY observed_at DESC, id DESC
        LIMIT ?`
    ),
    latestAddressedExchanges: db.prepare(
      `SELECT m.id AS addressedMessageId, o.sent_message_id AS replyMessageId
         FROM turn_outcomes o
         JOIN extraction_runs r ON r.id = o.extraction_run_id
         JOIN messages m ON m.id = r.message_id
        WHERE m.participant_id = ? AND o.kind IN ('reply-sent', 'intentional-silence')
        ORDER BY m.observed_at DESC, m.id DESC
        LIMIT ?`
    ),
    countCompletedExchanges: db.prepare(
      `SELECT COUNT(*) AS total
         FROM turn_outcomes o
         JOIN extraction_runs r ON r.id = o.extraction_run_id
         JOIN messages m ON m.id = r.message_id
        WHERE m.participant_id = ? AND o.kind IN ('reply-sent', 'intentional-silence')`
    ),
    deleteMessagesOlderThan: db.prepare(
      'DELETE FROM messages WHERE observed_at < ?'
    ),
    countMessages: db.prepare('SELECT COUNT(*) AS total FROM messages'),

    insertClaim: db.prepare(
      `INSERT INTO participant_claims
         (subject_participant_id, reporter_participant_id, body, normalized_body,
          occurred_at, created_at, duplicate_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ),
    insertEpisode: db.prepare(
      `INSERT INTO episodes
         (reporter_participant_id, body, normalized_body, occurred_at, created_at, duplicate_key)
       VALUES (?, ?, ?, ?, ?, ?)`
    ),
    insertEpisodeParticipant: db.prepare(
      'INSERT INTO episode_participants (episode_id, participant_id) VALUES (?, ?)'
    ),
    insertInteractionPattern: db.prepare(
      `INSERT INTO interaction_patterns
         (participant_id, body, normalized_body, occurred_at, created_at, duplicate_key)
       VALUES (?, ?, ?, ?, ?, ?)`
    ),
    findDuplicateClaim: db.prepare(
      'SELECT id FROM participant_claims WHERE duplicate_key = ?'
    ),
    findDuplicateEpisode: db.prepare(
      'SELECT id FROM episodes WHERE duplicate_key = ?'
    ),
    findDuplicatePattern: db.prepare(
      'SELECT id FROM interaction_patterns WHERE duplicate_key = ?'
    ),
    insertEvidence: db.prepare(
      `INSERT INTO evidence_snapshots
         (claim_id, episode_id, interaction_pattern_id, conversation_id,
          whatsapp_message_id, observed_at, reporter_participant_id, excerpt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    insertEvidenceParticipant: db.prepare(
      'INSERT INTO evidence_snapshot_participants (evidence_id, participant_id) VALUES (?, ?)'
    ),

    listClaims: db.prepare(
      `SELECT c.id, c.subject_participant_id AS subjectParticipantId,
              c.reporter_participant_id AS reporterParticipantId,
              c.body AS text, c.occurred_at AS occurredAt, c.created_at AS createdAt
         FROM participant_claims c ORDER BY c.created_at DESC, c.id DESC`
    ),
    listEpisodes: db.prepare(
      `SELECT e.id, e.reporter_participant_id AS reporterParticipantId,
              e.body AS text, e.occurred_at AS occurredAt, e.created_at AS createdAt
         FROM episodes e ORDER BY e.created_at DESC, e.id DESC`
    ),
    listEpisodeParticipants: db.prepare(
      `SELECT episode_id AS episodeId, participant_id AS participantId
         FROM episode_participants ORDER BY episode_id, participant_id`
    ),
    listInteractionPatterns: db.prepare(
      `SELECT p.id, p.participant_id AS participantId, p.body AS text,
              p.occurred_at AS occurredAt, p.created_at AS createdAt
         FROM interaction_patterns p ORDER BY p.created_at DESC, p.id DESC`
    ),
    firstEvidenceForClaim: db.prepare(
      `SELECT excerpt, whatsapp_message_id AS whatsappMessageId, observed_at AS observedAt
         FROM evidence_snapshots WHERE claim_id = ? ORDER BY id LIMIT 1`
    ),
    firstEvidenceForEpisode: db.prepare(
      `SELECT excerpt, whatsapp_message_id AS whatsappMessageId, observed_at AS observedAt
         FROM evidence_snapshots WHERE episode_id = ? ORDER BY id LIMIT 1`
    ),
    firstEvidenceForPattern: db.prepare(
      `SELECT excerpt, whatsapp_message_id AS whatsappMessageId, observed_at AS observedAt
         FROM evidence_snapshots WHERE interaction_pattern_id = ? ORDER BY id LIMIT 1`
    ),
    countEvidence: db.prepare('SELECT COUNT(*) AS total FROM evidence_snapshots'),

    insertExtractionRun: db.prepare(
      `INSERT INTO extraction_runs
         (message_id, conversation_id, whatsapp_message_id, state, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`
    ),
    findRunById: db.prepare(
      `SELECT id, message_id AS messageId, conversation_id AS conversationId,
              whatsapp_message_id AS whatsappMessageId, state,
              created_at AS createdAt
         FROM extraction_runs WHERE id = ?`
    ),
    findRunByMessage: db.prepare(
      `SELECT id, message_id AS messageId, conversation_id AS conversationId,
              whatsapp_message_id AS whatsappMessageId, state,
              created_at AS createdAt
         FROM extraction_runs WHERE message_id = ?`
    ),
    listPendingRuns: db.prepare(
      `SELECT id, message_id AS messageId, conversation_id AS conversationId,
              whatsapp_message_id AS whatsappMessageId, state,
              created_at AS createdAt
         FROM extraction_runs WHERE state = 'pending' ORDER BY created_at, id`
    ),
    setRunState: db.prepare(
      'UPDATE extraction_runs SET state = ?, updated_at = ? WHERE id = ?'
    ),

    insertTurnOutcome: db.prepare(
      `INSERT INTO turn_outcomes
         (extraction_run_id, message_id, kind, stage, sent_message_id,
          notification_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ),
    findTurnOutcome: db.prepare(
      `SELECT id, extraction_run_id AS extractionRunId, message_id AS messageId,
              kind, stage, sent_message_id AS sentMessageId,
              notification_message_id AS notificationMessageId,
              created_at AS createdAt
         FROM turn_outcomes WHERE extraction_run_id = ?`
    ),
    listTurnOutcomes: db.prepare(
      `SELECT id, extraction_run_id AS extractionRunId, message_id AS messageId,
              kind, stage, sent_message_id AS sentMessageId,
              notification_message_id AS notificationMessageId,
              created_at AS createdAt
         FROM turn_outcomes ORDER BY id`
    ),

    reassignAliases: db.prepare(
      'UPDATE participant_aliases SET participant_id = ? WHERE participant_id = ?'
    ),
    reassignMessages: db.prepare(
      'UPDATE messages SET participant_id = ? WHERE participant_id = ?'
    ),
    reassignClaimSubjects: db.prepare(
      'UPDATE participant_claims SET subject_participant_id = ? WHERE subject_participant_id = ?'
    ),
    reassignClaimReporters: db.prepare(
      'UPDATE participant_claims SET reporter_participant_id = ? WHERE reporter_participant_id = ?'
    ),
    reassignEpisodeReporters: db.prepare(
      'UPDATE episodes SET reporter_participant_id = ? WHERE reporter_participant_id = ?'
    ),
    reassignPatternParticipants: db.prepare(
      'UPDATE interaction_patterns SET participant_id = ? WHERE participant_id = ?'
    ),
    reassignEvidenceReporters: db.prepare(
      'UPDATE evidence_snapshots SET reporter_participant_id = ? WHERE reporter_participant_id = ?'
    ),
    reassignRedirects: db.prepare(
      'UPDATE participant_redirects SET surviving_participant_id = ? WHERE surviving_participant_id = ?'
    ),
    // The link tables are keyed on (parent, participant), so a merge can collide
    // with a row the survivor already owns. Drop those duplicates first, then move
    // what is left across.
    dropDuplicateEpisodeLinks: db.prepare(
      `DELETE FROM episode_participants
        WHERE participant_id = ?
          AND episode_id IN (SELECT episode_id FROM episode_participants WHERE participant_id = ?)`
    ),
    reassignEpisodeLinks: db.prepare(
      'UPDATE episode_participants SET participant_id = ? WHERE participant_id = ?'
    ),
    dropDuplicateEvidenceLinks: db.prepare(
      `DELETE FROM evidence_snapshot_participants
        WHERE participant_id = ?
          AND evidence_id IN (SELECT evidence_id FROM evidence_snapshot_participants WHERE participant_id = ?)`
    ),
    reassignEvidenceLinks: db.prepare(
      'UPDATE evidence_snapshot_participants SET participant_id = ? WHERE participant_id = ?'
    ),

    // Dashboard reads
    listAllConversations: db.prepare(
      `SELECT id, address, kind, label, created_at AS createdAt FROM conversations ORDER BY created_at DESC`
    ),
    listMessagesPageAll: db.prepare(
      `SELECT id, conversation_id AS conversationId, participant_id AS participantId,
              direction, observed_at AS observedAt, addressed, body AS text, author_label AS authorLabel
         FROM messages ORDER BY observed_at DESC, id DESC LIMIT ? OFFSET ?`
    ),
    listMessagesPageByConv: db.prepare(
      `SELECT id, conversation_id AS conversationId, participant_id AS participantId,
              direction, observed_at AS observedAt, addressed, body AS text, author_label AS authorLabel
         FROM messages WHERE conversation_id = ?
         ORDER BY observed_at DESC, id DESC LIMIT ? OFFSET ?`
    ),
    countMessagesByConv: db.prepare(
      `SELECT COUNT(*) AS total FROM messages WHERE conversation_id = ?`
    ),
    listAllParticipants: db.prepare(
      `SELECT id, created_at AS createdAt FROM participants ORDER BY created_at DESC`
    ),
    countParticipants: db.prepare(`SELECT COUNT(*) AS total FROM participants`),
    countClaims: db.prepare(`SELECT COUNT(*) AS total FROM participant_claims`),
    countEpisodes: db.prepare(`SELECT COUNT(*) AS total FROM episodes`),
    countPatterns: db.prepare(`SELECT COUNT(*) AS total FROM interaction_patterns`),
    extractionRunCounts: db.prepare(
      `SELECT state, COUNT(*) AS total FROM extraction_runs GROUP BY state`
    ),
    turnOutcomeCounts: db.prepare(
      `SELECT kind, COUNT(*) AS total FROM turn_outcomes GROUP BY kind`
    ),
    messagesByDay: db.prepare(
      `SELECT strftime('%Y-%m-%d', observed_at / 1000, 'unixepoch') AS day, COUNT(*) AS total
         FROM messages WHERE observed_at > ? AND direction = 'incoming'
         GROUP BY day ORDER BY day`
    ),
    extractionByDay: db.prepare(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, state, COUNT(*) AS total
         FROM extraction_runs WHERE created_at > ?
         GROUP BY day, state ORDER BY day`
    ),
    listExtractionRunsPage: db.prepare(
      `SELECT r.id, r.state, r.created_at AS createdAt, r.updated_at AS updatedAt,
              c.label AS conversationLabel, c.address AS conversationAddress, c.kind AS conversationKind
         FROM extraction_runs r JOIN conversations c ON c.id = r.conversation_id
         ORDER BY r.created_at DESC, r.id DESC LIMIT ? OFFSET ?`
    ),
    countExtractionRuns: db.prepare(`SELECT COUNT(*) AS total FROM extraction_runs`),

    // Reset all memory
    deleteAllEvidenceLinks: db.prepare('DELETE FROM evidence_snapshot_participants'),
    deleteAllEvidence: db.prepare('DELETE FROM evidence_snapshots'),
    deleteAllEpisodeParticipants: db.prepare('DELETE FROM episode_participants'),
    deleteAllClaims: db.prepare('DELETE FROM participant_claims'),
    deleteAllEpisodes: db.prepare('DELETE FROM episodes'),
    deleteAllPatterns: db.prepare('DELETE FROM interaction_patterns'),

    // Deletion helpers
    purgeClaimEvidenceLinks: db.prepare(
      `DELETE FROM evidence_snapshot_participants
          WHERE evidence_id IN (SELECT id FROM evidence_snapshots WHERE claim_id = ?)`
    ),
    purgeClaimEvidence: db.prepare(`DELETE FROM evidence_snapshots WHERE claim_id = ?`),
    purgeClaimRow: db.prepare(`DELETE FROM participant_claims WHERE id = ?`),
    purgeEpisodeEvidenceLinks: db.prepare(
      `DELETE FROM evidence_snapshot_participants
          WHERE evidence_id IN (SELECT id FROM evidence_snapshots WHERE episode_id = ?)`
    ),
    purgeEpisodeEvidence: db.prepare(`DELETE FROM evidence_snapshots WHERE episode_id = ?`),
    purgeEpisodeParticipants: db.prepare(`DELETE FROM episode_participants WHERE episode_id = ?`),
    purgeEpisodeRow: db.prepare(`DELETE FROM episodes WHERE id = ?`),
    purgePatternEvidenceLinks: db.prepare(
      `DELETE FROM evidence_snapshot_participants
          WHERE evidence_id IN (SELECT id FROM evidence_snapshots WHERE interaction_pattern_id = ?)`
    ),
    purgePatternEvidence: db.prepare(
      `DELETE FROM evidence_snapshots WHERE interaction_pattern_id = ?`
    ),
    purgePatternRow: db.prepare(`DELETE FROM interaction_patterns WHERE id = ?`),
  };

  function transaction(fn) {
    return db.transaction(fn);
  }

  // Absorbing an identity moves every durable reference and records the
  // permanent redirect as one atomic unit: a participant can never end up split
  // across the absorbed and the surviving identity.
  const absorb = db.transaction((absorbedId, survivingId, now) => {
    statements.reassignAliases.run(survivingId, absorbedId);
    statements.reassignMessages.run(survivingId, absorbedId);
    statements.reassignClaimSubjects.run(survivingId, absorbedId);
    statements.reassignClaimReporters.run(survivingId, absorbedId);
    statements.reassignEpisodeReporters.run(survivingId, absorbedId);
    statements.reassignPatternParticipants.run(survivingId, absorbedId);
    statements.reassignEvidenceReporters.run(survivingId, absorbedId);
    statements.dropDuplicateEpisodeLinks.run(absorbedId, survivingId);
    statements.reassignEpisodeLinks.run(survivingId, absorbedId);
    statements.dropDuplicateEvidenceLinks.run(absorbedId, survivingId);
    statements.reassignEvidenceLinks.run(survivingId, absorbedId);
    statements.reassignRedirects.run(survivingId, absorbedId);
    statements.insertRedirect.run(absorbedId, survivingId, now);
  });

  const resetAllMemory = db.transaction(() => {
    statements.deleteAllEvidenceLinks.run();
    statements.deleteAllEvidence.run();
    statements.deleteAllEpisodeParticipants.run();
    statements.deleteAllClaims.run();
    statements.deleteAllEpisodes.run();
    statements.deleteAllPatterns.run();
  });

  const deleteClaim = db.transaction((id) => {
    statements.purgeClaimEvidenceLinks.run(id);
    statements.purgeClaimEvidence.run(id);
    statements.purgeClaimRow.run(id);
  });

  const deleteEpisode = db.transaction((id) => {
    statements.purgeEpisodeEvidenceLinks.run(id);
    statements.purgeEpisodeEvidence.run(id);
    statements.purgeEpisodeParticipants.run(id);
    statements.purgeEpisodeRow.run(id);
  });

  const deletePattern = db.transaction((id) => {
    statements.purgePatternEvidenceLinks.run(id);
    statements.purgePatternEvidence.run(id);
    statements.purgePatternRow.run(id);
  });

  return {
    close() {
      db.close();
    },
    transaction,

    // Identity
    insertParticipant(id, now) {
      statements.insertParticipant.run(id, now);
      return { id, createdAt: now };
    },
    findParticipant(id) {
      return statements.findParticipant.get(id) ?? null;
    },
    findAlias(kind, value) {
      return statements.findAlias.get(kind, value) ?? null;
    },
    insertAlias(kind, value, participantId, now) {
      statements.insertAlias.run(kind, value, participantId, now);
    },
    aliasesOfParticipant(participantId) {
      return statements.aliasesOfParticipant.all(participantId);
    },
    insertRedirect(absorbedId, survivingId, now) {
      statements.insertRedirect.run(absorbedId, survivingId, now);
    },
    findRedirect(absorbedId) {
      return statements.findRedirect.get(absorbedId) ?? null;
    },
    insertPairingConflict(conflict) {
      statements.insertConflict.run(
        conflict.aliasKind,
        conflict.aliasValue,
        conflict.counterpartKind,
        conflict.counterpartValue,
        conflict.heldByParticipantId,
        conflict.conflictingParticipantId,
        conflict.observedAt
      );
    },
    listPairingConflicts() {
      return statements.listConflicts.all();
    },
    absorbParticipant(absorbedId, survivingId, now) {
      absorb(absorbedId, survivingId, now);
    },

    // Conversations and messages
    findConversation(address) {
      return statements.findConversation.get(address) ?? null;
    },
    findConversationById(id) {
      return statements.findConversationById.get(id) ?? null;
    },
    insertConversation(address, kind, label, now) {
      const info = statements.insertConversation.run(address, kind, label, now);
      return { id: Number(info.lastInsertRowid), address, kind, label };
    },
    updateConversationLabel(conversationId, label) {
      statements.updateConversationLabel.run(label, conversationId);
    },
    findMessageByKey(conversationId, whatsappMessageId) {
      return statements.findMessageByKey.get(conversationId, whatsappMessageId) ?? null;
    },
    findMessageById(id) {
      return statements.findMessageById.get(id) ?? null;
    },
    insertMessage(message) {
      const info = statements.insertMessage.run(
        message.conversationId,
        message.participantId,
        message.whatsappMessageId,
        message.direction,
        message.observedAt,
        message.addressed ? 1 : 0,
        message.text,
        message.authorLabel
      );
      return Number(info.lastInsertRowid);
    },
    markMessageAddressed(messageId) {
      statements.markMessageAddressed.run(messageId);
    },
    recentMessages(conversationId, excludeMessageId, limit) {
      return statements.recentMessages.all(conversationId, excludeMessageId ?? -1, limit);
    },
    latestAddressedExchanges(participantId, limit) {
      return statements.latestAddressedExchanges.all(participantId, limit);
    },
    countCompletedExchanges(participantId) {
      return statements.countCompletedExchanges.get(participantId).total;
    },
    deleteMessagesOlderThan(cutoff) {
      return statements.deleteMessagesOlderThan.run(cutoff).changes;
    },
    countMessages() {
      return statements.countMessages.get().total;
    },

    // Durable memories
    findDuplicate(category, duplicateKey) {
      if (category === 'participant_claim') {
        return statements.findDuplicateClaim.get(duplicateKey) ?? null;
      }
      if (category === 'episode') {
        return statements.findDuplicateEpisode.get(duplicateKey) ?? null;
      }
      return statements.findDuplicatePattern.get(duplicateKey) ?? null;
    },
    insertClaim(claim) {
      const info = statements.insertClaim.run(
        claim.subjectParticipantId,
        claim.reporterParticipantId,
        claim.text,
        claim.normalizedText,
        claim.occurredAt,
        claim.createdAt,
        claim.duplicateKey
      );
      return Number(info.lastInsertRowid);
    },
    insertEpisode(episode) {
      const info = statements.insertEpisode.run(
        episode.reporterParticipantId,
        episode.text,
        episode.normalizedText,
        episode.occurredAt,
        episode.createdAt,
        episode.duplicateKey
      );
      return Number(info.lastInsertRowid);
    },
    insertEpisodeParticipant(episodeId, participantId) {
      statements.insertEpisodeParticipant.run(episodeId, participantId);
    },
    insertInteractionPattern(pattern) {
      const info = statements.insertInteractionPattern.run(
        pattern.participantId,
        pattern.text,
        pattern.normalizedText,
        pattern.occurredAt,
        pattern.createdAt,
        pattern.duplicateKey
      );
      return Number(info.lastInsertRowid);
    },
    insertEvidence(evidence) {
      const info = statements.insertEvidence.run(
        evidence.claimId ?? null,
        evidence.episodeId ?? null,
        evidence.interactionPatternId ?? null,
        evidence.conversationId,
        evidence.whatsappMessageId,
        evidence.observedAt,
        evidence.reporterParticipantId ?? null,
        evidence.excerpt
      );
      return Number(info.lastInsertRowid);
    },
    insertEvidenceParticipant(evidenceId, participantId) {
      statements.insertEvidenceParticipant.run(evidenceId, participantId);
    },
    listClaims() {
      return statements.listClaims.all();
    },
    listEpisodes() {
      return statements.listEpisodes.all();
    },
    listEpisodeParticipants() {
      return statements.listEpisodeParticipants.all();
    },
    listInteractionPatterns() {
      return statements.listInteractionPatterns.all();
    },
    firstEvidence(category, memoryId) {
      if (category === 'participant_claim') {
        return statements.firstEvidenceForClaim.get(memoryId) ?? null;
      }
      if (category === 'episode') {
        return statements.firstEvidenceForEpisode.get(memoryId) ?? null;
      }
      return statements.firstEvidenceForPattern.get(memoryId) ?? null;
    },
    countEvidence() {
      return statements.countEvidence.get().total;
    },

    // Extraction runs and turn outcomes
    insertExtractionRun(messageId, conversationId, whatsappMessageId, now) {
      const info = statements.insertExtractionRun.run(
        messageId,
        conversationId,
        whatsappMessageId,
        now,
        now
      );
      return Number(info.lastInsertRowid);
    },
    findRunById(id) {
      return statements.findRunById.get(id) ?? null;
    },
    findRunByMessage(messageId) {
      return statements.findRunByMessage.get(messageId) ?? null;
    },
    listPendingRuns() {
      return statements.listPendingRuns.all();
    },
    setRunState(id, state, now) {
      statements.setRunState.run(state, now, id);
    },
    insertTurnOutcome(outcome) {
      statements.insertTurnOutcome.run(
        outcome.extractionRunId,
        outcome.messageId ?? null,
        outcome.kind,
        outcome.stage ?? null,
        outcome.sentMessageId ?? null,
        outcome.notificationMessageId ?? null,
        outcome.createdAt
      );
    },
    findTurnOutcome(extractionRunId) {
      return statements.findTurnOutcome.get(extractionRunId) ?? null;
    },
    listTurnOutcomes() {
      return statements.listTurnOutcomes.all();
    },

    // Dashboard reads
    listAllConversations() { return statements.listAllConversations.all(); },
    listMessagesPage(limit, offset, conversationId) {
      return conversationId != null
        ? statements.listMessagesPageByConv.all(conversationId, limit, offset)
        : statements.listMessagesPageAll.all(limit, offset);
    },
    countMessagesPage(conversationId) {
      return conversationId != null
        ? statements.countMessagesByConv.get(conversationId).total
        : statements.countMessages.get().total;
    },
    listAllParticipants() { return statements.listAllParticipants.all(); },
    countParticipants() { return statements.countParticipants.get().total; },
    countClaims() { return statements.countClaims.get().total; },
    countEpisodes() { return statements.countEpisodes.get().total; },
    countPatterns() { return statements.countPatterns.get().total; },
    extractionRunCounts() { return statements.extractionRunCounts.all(); },
    turnOutcomeCounts() { return statements.turnOutcomeCounts.all(); },
    messagesByDay(since) { return statements.messagesByDay.all(since); },
    extractionByDay(since) { return statements.extractionByDay.all(since); },
    listExtractionRunsPage(limit, offset) { return statements.listExtractionRunsPage.all(limit, offset); },
    countExtractionRuns() { return statements.countExtractionRuns.get().total; },
    deleteClaim(id) { deleteClaim(id); },
    deleteEpisode(id) { deleteEpisode(id); },
    deletePattern(id) { deletePattern(id); },
    resetAllMemory() { resetAllMemory(); },
  };
}
