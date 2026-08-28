# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Domain language

`CONTEXT.md` is the authoritative domain model.
Use its vocabulary (conversation, participant, ambient message, durable memory, participant claim, episode, interaction pattern, evidence snapshot, callback, intentional silence) in identifiers, comments, tests and PR descriptions, and honour its `_Avoid_` lists.

## Module boundaries

These three boundaries are load-bearing and enforced by a test (`test/deployment.test.js`, scenario 58):

- The memory module (`memory/`) owns participant identity, persistence, extraction, pruning and retrieval, and is the only place that issues SQL. All statements live in `memory/store.js`; physical table and column names are private to the module.
- Reply generation (`reply/`) owns prompt assembly, provider fallback, output validation and silence-token interpretation. Prompt assembly is an internal helper, tested only through `generateReply`.
- Provider adapters (`providers/`) carry transport concerns only: no personality, memory policy, fallback order, or domain validation.

Chat orchestration (`chat.js`) issues no SQL, builds no prompts, validates no model output, and calls no provider adapter directly.

Modules are created at startup through factory functions in `index.js` with their real dependencies passed in. Do not add module-level provider clients or mutable test globals.

## Tests

`npm test` runs the whole suite on Node's built-in runner, entirely offline: no WhatsApp credentials, no live provider keys, no network.
Tests assert externally observable behaviour through module interfaces. Prompt-building helpers, extraction helpers, SQL statements and the physical schema are not public test seams; focused low-level tests are only acceptable for migrations and database constraints.
Numbered test names (`1.` to `58.`) map to the required scenarios in issue #12 and should stay stable.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
