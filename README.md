# FlunkieBot

FlunkieBot is the persistent FlunkCie character that participates in WhatsApp conversations and builds continuity with their participants.
It is built on [Baileys](https://github.com/WhiskeySockets/Baileys), answers with an LLM, and falls back automatically across three free-tier providers.

See [CONTEXT.md](CONTEXT.md) for the domain model and the exact vocabulary this codebase uses.

- **Direct messages**: every supported message addresses FlunkieBot and gets a reply, sent plain (no quoted reference).
- **Group conversations**: FlunkieBot replies only when addressed — tagged with `@FlunkieBot`, or the message text itself contains "bot", "flunk"/"flunkie", or "gif" — quoting the message that addressed it. There are no spontaneous group replies.
- **Ambient observation**: ordinary group messages are observed and stored for context without producing a reply, so FlunkieBot understands the group without interrupting it.
- **Persistent memory**: recent conversation messages and automatically selected durable memories live in one local SQLite database that survives restarts and container rebuilds.
- **Participant identity**: a participant is recognized across conversations through evidence-backed WhatsApp aliases, never through guesses based on digits, names, group membership, or timing.
- **Callbacks**: at most one sufficiently relevant durable memory is retrieved per reply, and FlunkieBot may weaponize it, or ignore it when the current conversation offers a better joke.
- **Intentional silence**: after being addressed, FlunkieBot stays silent only when a retrieved interaction pattern makes silence itself the joke. That is recorded distinctly from a failed reply.
- **Fixed failure notification**: if every reply provider fails, FlunkieBot sends one fixed in-character notification so an outage stays visible instead of looking like ghosting.
- **Multi-provider fallback**: tries Groq, then OpenRouter, then Gemini for replies (configurable). A rate-limited, erroring, truncated, refused, or empty response falls through to the next provider, retrying the whole chain a bounded number of times.
- **Natural delivery**: a reply is sent the way a person texts, split into a few short bubbles with "typing..." pauses in between. With a GIPHY key configured, FlunkieBot may send a reaction GIF instead of a bubble of text; without one it is never told GIFs exist.
- Personality and fixed lore are hand-authored in a plain text system prompt. Nothing in the code lets FlunkieBot rewrite them.
- Auto-reconnects with backoff on disconnects, refuses to start a second instance against the same session (prevents WhatsApp session corruption), and logs everything in readable form.

## Prerequisites

- Node.js 22+ (required by `better-sqlite3` and by the glob patterns the test script passes to `node --test`)
- At least one LLM provider API key (any combination works):
  - [Gemini API key](https://aistudio.google.com/apikey)
  - [Groq API key](https://console.groq.com/keys)
  - [OpenRouter API key](https://openrouter.ai/keys)
- A WhatsApp account to link as the bot

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the example env file and add your API key(s):

   ```bash
   cp .env.example .env
   ```

   | Variable                  | Required     | Default                        | Description                                                                                       |
   | ------------------------- | ------------ | ------------------------------ | ------------------------------------------------------------------------------------------------- |
   | `GEMINI_API_KEY`          | one of three | -                              | Enables the Gemini provider                                                                        |
   | `GEMINI_MODEL`            | no           | `gemini-3.5-flash-lite`        | Gemini model. "Flash-Lite" has a much higher free-tier daily limit than plain Flash/Pro             |
   | `GROQ_API_KEY`            | one of three | -                              | Enables the Groq provider                                                                          |
   | `GROQ_MODEL`              | no           | `openai/gpt-oss-120b`          | Groq model to use                                                                                  |
   | `OPENROUTER_API_KEY`      | one of three | -                              | Enables the OpenRouter provider                                                                    |
   | `OPENROUTER_MODEL`        | no           | `minimax/minimax-m3:free`      | OpenRouter model to use                                                                            |
   | `GIPHY_API_KEY`           | no           | -                              | Enables reaction GIFs. Free key at https://developers.giphy.com; unset means GIFs are never offered |
   | `LLM_PROVIDER_ORDER`      | no           | `groq,openrouter,gemini`       | Comma-separated fallback order for replies; unconfigured providers are skipped                     |
   | `MEMORY_PROVIDER_ORDER`   | no           | `groq,gemini,openrouter`       | Comma-separated fallback order for memory extraction; schema-enforced routes come first             |
   | `LLM_RETRY_PASSES`        | no           | `2`                            | If every provider fails in one pass, retry the whole chain this many times                          |
   | `LLM_RETRY_DELAY_MS`      | no           | `5000`                         | Delay in ms between retry passes                                                                    |
   | `MEMORY_DB_PATH`          | no           | `./data/flunkiebot.sqlite`     | SQLite database holding conversation messages and durable memories                                  |
   | `INITIATIVE_MODE`         | no           | `off`                          | `off` or `dm-only`. See [Unprompted messages](#unprompted-messages)                                 |
   | `INITIATIVE_MIN_DAYS`     | no           | `14`                           | Minimum days between two unprompted messages to the same person                                     |
   | `INITIATIVE_WEEKLY_CAP`   | no           | `2`                            | Maximum unprompted messages across the whole group per rolling seven days                           |
   | `INITIATIVE_HOURS`        | no           | `10-23`                        | Local-time window in which an unprompted message may go out, end exclusive                          |
   | `INITIATIVE_EXCLUDED_NUMBERS` | no       | -                              | Comma-separated phone numbers that never receive an unprompted message                              |
   | `LOG_LEVEL`               | no           | `info`                         | App log verbosity: trace, debug, info, warn, error, fatal                                           |
   | `LOG_FORMAT`              | no           | pretty                         | Set to `json` for raw structured JSON instead of readable logs                                      |
   | `BAILEYS_LOG_LEVEL`       | no           | `warn`                         | Verbosity of Baileys' own internal logger                                                           |

   At least one provider's API key must be set, otherwise startup fails.
   Configuring all three gives the bot the most resilience against any single provider's free-tier rate limits.
   Free model slugs on Groq/OpenRouter change or get deprecated fairly often: if a provider starts erroring with a 404, check its current model list (see comments in `.env.example`) and update the `*_MODEL` variable.

3. Edit `system-prompt.txt` to change FlunkieBot's identity, lore and voice. No code changes or rebuild needed on the host, just a restart.

## Running

```bash
npm start
```

On first run, a QR code prints to the terminal. Scan it from WhatsApp: **Settings -> Linked Devices -> Link a Device**.
The session is saved to `auth_info/`, so you won't need to scan again unless you log out or delete that folder.

Once connected, DM the linked number or tag `@FlunkieBot` in a group.

## Persistent memory

FlunkieBot stores everything it remembers in one local SQLite database at `MEMORY_DB_PATH` (`./data/flunkiebot.sqlite` by default).
The parent directory is created at startup.

- **Conversation messages** are temporary: they expire roughly seven days after they were observed. Pruning runs at startup and after received messages, without a scheduler.
- **Durable memories** are permanent. They come in three kinds: a participant claim (a direct, concrete, lasting first-person statement), an episode (a concrete occurrence that can support a later callback), and an interaction pattern (a recurring way FlunkieBot and one participant interact, learned only after two distinct completed addressed exchanges).
- Each durable memory keeps a minimal evidence snapshot: the source message key, conversation, observation time, reporter, involved participants, and the shortest verbatim excerpt that supports it. That snapshot survives after the conversation messages expire. It is not a retained transcript.
- Durable memories are append-only. Contradictory memories coexist with their provenance rather than being silently reconciled, and an exact duplicate is a harmless no-op.
- Memory extraction runs after the reply has already been sent, so remembering never adds latency to a response, and a failed extraction never retracts a reply that already went out.
- Retrieval is deterministic: participant association, normalized keyword overlap, and recency. No embeddings, no vector search, no model call.

Startup fails visibly if the database cannot be opened, carries an unknown newer schema version, or fails to migrate.
FlunkieBot never silently falls back to a stateless mode.

There are no remember, forget, inspect, or moderation commands, and no memory dashboard.
This is a deliberately simple friends-group deployment.

## Unprompted messages

FlunkieBot can start a conversation himself instead of only answering one.
This is off by default: with `INITIATIVE_MODE=off` nothing below happens at all, and no unprompted message is even generated.

Set `INITIATIVE_MODE=dm-only` to switch it on.
There is deliberately no mode that reaches further than that.

- **Who can receive one.** Only participants who already started a direct-message thread with FlunkieBot themselves. Someone who knows him purely from the group never gets an unprompted message, however much he remembers about them. That set is derived from the direct conversations he already has, which never expire.
- **When it runs.** Piggybacking on a turn he just handled, in the same process. There is no scheduler, no background loop and no second process, so he never produces outgoing traffic in an otherwise silent account.
- **What counts as an occasion**, in this order: someone was discussed in the group while they had been silent themselves for at least 24 hours; or a stored episode has been sitting there for at least 14 days and has never been used before. Neither means nothing is sent.
- **The budget.** At most one unprompted message per person per `INITIATIVE_MIN_DAYS`, at most `INITIATIVE_WEEKLY_CAP` across the whole group per rolling week, and only inside `INITIATIVE_HOURS`. The budget is the control, not the occasion: there are far more valid occasions in a week than the budget will ever spend.
- **The stop rule.** Two unprompted messages in a row that were never answered put that person on hold for thirty days. A message that got a reply does not count as ignored.
- **The exclusion list.** `INITIATIVE_EXCLUDED_NUMBERS` takes anyone out entirely, whatever the mode says.

`INITIATIVE_HOURS` is read in the process timezone, and a container runs in UTC unless told otherwise.
Set `TZ` in `.env` before switching this on, or the window lands in the wrong part of the day.

The stop rule is a technical mitigation rather than politeness.
WhatsApp is testing a monthly limit on messages that receive no reply, which applies to personal accounts too, and messages that do get a reply are explicitly excluded from it.
Combined with the fact that the only realistic way to lose the number here is a human blocking or reporting the bot, the annoyance threshold and the ban threshold are the same threshold.

An unprompted message never uses the same durable memory twice, and ripeness is measured from the moment a memory was stored, never from the occurrence time the model supplied for it: that field is often missing or wrong.
A prank is a tone rather than an occasion of its own, and is handled in the prompt.
The send itself runs in the queue of the *recipient*, so an unprompted message can never cut in front of a message arriving from that same person, and it goes out through the same composing-presence and typing pacing as every other reply.

## Running with Docker Compose

```bash
docker compose up -d --build
docker compose logs -f
```

The first run still needs a QR scan: watch it via `docker compose logs -f`.
Three paths are bind-mounted into the container:

| Host                 | Container                | Purpose                                                       |
| -------------------- | ------------------------ | ------------------------------------------------------------- |
| `./auth_info`        | `/app/auth_info`         | WhatsApp session credentials and the single-instance lock      |
| `./system-prompt.txt`| `/app/system-prompt.txt` | Hand-authored personality, mounted read-only                   |
| `./data`             | `/app/data`              | SQLite database, so persistent memory survives rebuilds        |

`./data` is excluded from version control and from the Docker build context.
The container restarts automatically (`restart: unless-stopped`) if it ever exits.

**Never run the bot on the host and in Docker at the same time** against the same `auth_info/`: two connections sharing one WhatsApp session desyncs its encryption state, which shows up as undecryptable "Waiting for this message" placeholders on the recipient's side.
The bot enforces this itself: it takes a lock file at `auth_info/.bot.lock` on startup and refuses to start if another instance already holds it (stale locks older than 5 minutes are auto-reclaimed).

Run exactly one bot process against one SQLite database and one WhatsApp authentication directory.

## Tests

```bash
npm test
```

The suite runs entirely offline on Node's built-in test runner.
It needs no WhatsApp credentials, no live provider keys, and no network: it uses deterministic fake providers, a fake WhatsApp sender, injected clocks, and temporary databases.
Whether FlunkieBot is actually funny stays a manual judgement in real conversations.

## Project structure

| File                          | Purpose                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| `index.js`                    | Startup: configuration, module wiring, Baileys connection and reconnect logic             |
| `chat.js`                     | Chat orchestration: routing, per-conversation ordering, presence, sending                 |
| `whatsapp.js`                 | WhatsApp normalization and the sender adapter                                             |
| `natural-send.js`             | Bubble splitting and typing pacing for outgoing replies                                   |
| `gif.js`                      | GIPHY search, used only when `GIPHY_API_KEY` is set                                       |
| `memory/index.js`             | The memory module: observe a message, the addressed-turn pair, and the initiative pair    |
| `memory/store.js`             | The only place in the application that holds SQL                                          |
| `memory/initiative.js`        | Who may receive an unprompted message, when, and on what occasion                         |
| `memory/database.js`          | Database open, pragmas and migration application                                          |
| `memory/migrations.js`        | Ordered, versioned schema migrations                                                      |
| `memory/identity.js`          | Participant identity, evidence-backed alias pairing and merges                            |
| `memory/retrieval.js`         | Deterministic keyword-and-recency retrieval                                               |
| `memory/extraction.js`        | Extraction packets, validation pipeline and atomic batch writes                           |
| `memory/extraction-schema.js` | The code-owned extraction JSON Schema and its validator                                   |
| `memory/text.js`              | Deterministic text normalization shared by retrieval and durable-memory keys              |
| `reply/index.js`              | Reply generation: answering a message, and writing an unprompted opening message          |
| `reply/prompt-assembly.js`    | Internal prompt assembly, context budgets and the output protocol                         |
| `provider-fallback.js`        | Bounded provider fallback shared by reply generation and extraction                       |
| `providers/*.js`              | Transport-only provider adapters (Groq, OpenRouter, Gemini) and error normalization       |
| `personality.js`              | Loads `system-prompt.txt`                                                                 |
| `system-prompt.txt`           | Hand-authored identity, fixed FlunkCie lore, and savage voice                             |
| `logger.js`                   | Logging setup (pino, pretty-printed by default)                                           |
| `lock.js`                     | Single-instance session lock                                                              |
| `auth_info/`                  | Saved WhatsApp session credentials and lock file (git-ignored, do not share)               |
| `data/`                       | SQLite database (git-ignored)                                                              |

## Notes

- Module boundaries are deliberate: the memory module is the only place that issues SQL, reply generation is the only place that builds prompts and interprets model output, and provider adapters carry transport concerns only. Chat orchestration does none of those three.
- `auth_info/` contains your WhatsApp session. Treat it like a password and never commit it.
- Every provider reply is validated before being sent. Empty, truncated, refused, filtered, or otherwise incomplete output is treated exactly like a network failure and triggers the same fallback path, rather than ever reaching WhatsApp.
- The reserved silence token is interpreted before sending and is never sent as message text. It is not accepted at all for an unprompted message: sending nothing is the default there, not the joke.
- Whether an unprompted message goes out is entirely a memory-module decision. Chat orchestration only carries out what it hands back, and never decides who gets one or when.
