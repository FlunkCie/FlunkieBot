// Ordered, versioned migrations applied transactionally through SQLite's
// `user_version`. Physical table and column names below are private to the
// memory module: no caller may depend on them.
//
// Retention note: temporary messages expire after seven days, while extraction
// runs and turn outcomes never expire. Those two rows therefore reference a
// message with ON DELETE SET NULL and keep a denormalized copy of the WhatsApp
// message key, so a pruned message leaves the durable outcome intact.
export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial-persistent-domain-model',
    up(db) {
      db.exec(`
        CREATE TABLE participants (
          id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE participant_aliases (
          alias_kind TEXT NOT NULL CHECK (alias_kind IN ('phone', 'lid')),
          alias_value TEXT NOT NULL,
          participant_id TEXT NOT NULL REFERENCES participants(id),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (alias_kind, alias_value)
        );

        CREATE INDEX participant_aliases_by_participant
          ON participant_aliases (participant_id);

        CREATE TABLE participant_redirects (
          absorbed_participant_id TEXT PRIMARY KEY REFERENCES participants(id),
          surviving_participant_id TEXT NOT NULL REFERENCES participants(id),
          created_at INTEGER NOT NULL,
          CHECK (absorbed_participant_id <> surviving_participant_id)
        );

        CREATE TABLE alias_pairing_conflicts (
          id INTEGER PRIMARY KEY,
          alias_kind TEXT NOT NULL,
          alias_value TEXT NOT NULL,
          counterpart_kind TEXT NOT NULL,
          counterpart_value TEXT NOT NULL,
          held_by_participant_id TEXT NOT NULL REFERENCES participants(id),
          conflicting_participant_id TEXT REFERENCES participants(id),
          observed_at INTEGER NOT NULL
        );

        CREATE TABLE conversations (
          id INTEGER PRIMARY KEY,
          address TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL CHECK (kind IN ('group', 'direct')),
          label TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE messages (
          id INTEGER PRIMARY KEY,
          conversation_id INTEGER NOT NULL REFERENCES conversations(id),
          participant_id TEXT REFERENCES participants(id),
          whatsapp_message_id TEXT NOT NULL,
          direction TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
          observed_at INTEGER NOT NULL,
          addressed INTEGER NOT NULL CHECK (addressed IN (0, 1)),
          body TEXT NOT NULL,
          author_label TEXT,
          UNIQUE (conversation_id, whatsapp_message_id)
        );

        CREATE INDEX messages_by_conversation_time
          ON messages (conversation_id, observed_at, id);

        CREATE INDEX messages_by_observed_at ON messages (observed_at);

        CREATE TABLE participant_claims (
          id INTEGER PRIMARY KEY,
          subject_participant_id TEXT NOT NULL REFERENCES participants(id),
          reporter_participant_id TEXT NOT NULL REFERENCES participants(id),
          body TEXT NOT NULL,
          normalized_body TEXT NOT NULL,
          occurred_at INTEGER,
          created_at INTEGER NOT NULL,
          duplicate_key TEXT NOT NULL UNIQUE
        );

        CREATE TABLE episodes (
          id INTEGER PRIMARY KEY,
          reporter_participant_id TEXT NOT NULL REFERENCES participants(id),
          body TEXT NOT NULL,
          normalized_body TEXT NOT NULL,
          occurred_at INTEGER,
          created_at INTEGER NOT NULL,
          duplicate_key TEXT NOT NULL UNIQUE
        );

        CREATE TABLE episode_participants (
          episode_id INTEGER NOT NULL REFERENCES episodes(id),
          participant_id TEXT NOT NULL REFERENCES participants(id),
          PRIMARY KEY (episode_id, participant_id)
        );

        CREATE TABLE interaction_patterns (
          id INTEGER PRIMARY KEY,
          participant_id TEXT NOT NULL REFERENCES participants(id),
          body TEXT NOT NULL,
          normalized_body TEXT NOT NULL,
          occurred_at INTEGER,
          created_at INTEGER NOT NULL,
          duplicate_key TEXT NOT NULL UNIQUE
        );

        CREATE TABLE evidence_snapshots (
          id INTEGER PRIMARY KEY,
          claim_id INTEGER REFERENCES participant_claims(id),
          episode_id INTEGER REFERENCES episodes(id),
          interaction_pattern_id INTEGER REFERENCES interaction_patterns(id),
          conversation_id INTEGER NOT NULL REFERENCES conversations(id),
          whatsapp_message_id TEXT NOT NULL,
          observed_at INTEGER NOT NULL,
          reporter_participant_id TEXT REFERENCES participants(id),
          excerpt TEXT NOT NULL,
          CHECK (
            (claim_id IS NOT NULL)
              + (episode_id IS NOT NULL)
              + (interaction_pattern_id IS NOT NULL) = 1
          )
        );

        CREATE TABLE evidence_snapshot_participants (
          evidence_id INTEGER NOT NULL REFERENCES evidence_snapshots(id),
          participant_id TEXT NOT NULL REFERENCES participants(id),
          PRIMARY KEY (evidence_id, participant_id)
        );

        CREATE TABLE extraction_runs (
          id INTEGER PRIMARY KEY,
          message_id INTEGER UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
          conversation_id INTEGER NOT NULL REFERENCES conversations(id),
          whatsapp_message_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX extraction_runs_by_state ON extraction_runs (state, created_at, id);

        CREATE TABLE turn_outcomes (
          id INTEGER PRIMARY KEY,
          extraction_run_id INTEGER NOT NULL UNIQUE REFERENCES extraction_runs(id),
          message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
          kind TEXT NOT NULL
            CHECK (kind IN ('reply-sent', 'intentional-silence', 'failed')),
          stage TEXT CHECK (stage IS NULL OR stage IN ('generation', 'send')),
          sent_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
          notification_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL,
          CHECK ((kind = 'failed') = (stage IS NOT NULL))
        );
      `);
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
