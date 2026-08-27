# FlunkieBot

A WhatsApp bot built on [Baileys](https://github.com/WhiskeySockets/Baileys) that answers messages using an LLM, with automatic fallback across three free-tier providers.

- **Direct messages**: every message gets an LLM-generated reply, sent plain (no quoted reference).
- **Group chats**: only replies when tagged with `@FlunkieBot`, quoting the message that mentioned it.
- **Multi-provider fallback**: tries Groq, then OpenRouter, then Gemini (configurable order, quality-first) — if one is rate-limited, erroring, or returns garbage/empty output, it automatically falls through to the next, retrying the whole chain a couple of times before giving up on a message.
- Keeps a short rolling conversation history per chat so replies stay contextual.
- Shows a "typing…" indicator while generating a reply.
- Personality/behavior is fully configurable via a plain text system prompt.
- Auto-reconnects with backoff on disconnects, refuses to start a second instance against the same session (prevents WhatsApp session corruption), and logs everything in readable form.

## Prerequisites

- Node.js 20+
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

   | Variable              | Required     | Default                          | Description                                                |
   | --------------------- | ------------ | --------------------------------- | ----------------------------------------------------------- |
   | `GEMINI_API_KEY`      | one of three | —                                 | Enables the Gemini provider                                 |
   | `GEMINI_MODEL`        | no           | `gemini-3.5-flash-lite`           | Gemini model. "Flash-Lite" has a much higher free-tier daily limit than plain Flash/Pro |
   | `GROQ_API_KEY`        | one of three | —                                 | Enables the Groq provider                                    |
   | `GROQ_MODEL`          | no           | `openai/gpt-oss-120b`             | Groq model to use                                             |
   | `OPENROUTER_API_KEY`  | one of three | —                                 | Enables the OpenRouter provider                              |
   | `OPENROUTER_MODEL`    | no           | `minimax/minimax-m3:free`         | OpenRouter model to use                                       |
   | `LLM_PROVIDER_ORDER`  | no           | `groq,openrouter,gemini`          | Comma-separated fallback order (quality-first); unconfigured providers are skipped |
   | `LLM_RETRY_PASSES`    | no           | `2`                               | If every provider fails in one pass, retry the whole chain this many times |
   | `LLM_RETRY_DELAY_MS`  | no           | `5000`                            | Delay in ms between retry passes                             |
   | `HISTORY_LIMIT`       | no           | `20`                              | Max messages kept per chat for conversation context          |
   | `LOG_LEVEL`           | no           | `info`                            | App log verbosity: trace, debug, info, warn, error, fatal    |
   | `LOG_FORMAT`          | no           | pretty                            | Set to `json` for raw structured JSON instead of readable logs |
   | `BAILEYS_LOG_LEVEL`   | no           | `warn`                            | Verbosity of Baileys' own internal logger                    |
   | `DEBUG_MENTIONS`      | no           | unset                             | Set to `1` to log group mention-matching details             |

   At least one provider's API key must be set. Configuring all three gives the bot the most resilience against any single provider's free-tier rate limits. Free model slugs on Groq/OpenRouter change or get deprecated fairly often — if a provider starts erroring with a 404, check its current model list (see comments in `.env.example`) and update the `*_MODEL` variable.

3. Edit `system-prompt.txt` to change the bot's personality — no code changes or rebuild needed on the host, just a restart.

## Running

```bash
npm start
```

On first run, a QR code prints to the terminal. Scan it from WhatsApp: **Settings → Linked Devices → Link a Device**. The session is saved to `auth_info/`, so you won't need to scan again unless you log out or delete that folder.

Once connected, DM the linked number or tag `@FlunkieBot` in a group.

## Running with Docker Compose

```bash
docker compose up -d --build
docker compose logs -f
```

The first run still needs a QR scan — watch it via `docker compose logs -f`. The `auth_info/` folder and `system-prompt.txt` are bind-mounted into the container, so the session persists across rebuilds and the prompt can be edited without rebuilding the image. The container restarts automatically (`restart: unless-stopped`) if it ever exits.

**Never run the bot on the host and in Docker at the same time** against the same `auth_info/` — two connections sharing one WhatsApp session desyncs its encryption state, which shows up as undecryptable "Waiting for this message" placeholders on the recipient's side. The bot enforces this itself: it takes a lock file at `auth_info/.bot.lock` on startup and refuses to start if another instance already holds it (stale locks older than 5 minutes are auto-reclaimed).

## Project structure

| File                       | Purpose                                                                  |
| -------------------------- | ------------------------------------------------------------------------- |
| `index.js`                 | Baileys connection, message routing, mention detection, reconnect logic   |
| `llm.js`                   | Provider fallback + retry orchestrator                                    |
| `providers/gemini.js`      | Gemini API client                                                         |
| `providers/groq.js`        | Groq API client                                                           |
| `providers/openrouter.js`  | OpenRouter API client                                                     |
| `providers/error.js`       | Shared helper that turns noisy provider errors into short, readable ones  |
| `prompt.js`                | Loads `system-prompt.txt`                                                 |
| `history.js`               | In-memory per-chat conversation history                                   |
| `logger.js`                | Logging setup (pino, pretty-printed by default)                           |
| `lock.js`                  | Single-instance session lock                                              |
| `system-prompt.txt`        | LLM system prompt / bot personality                                       |
| `auth_info/`                | Saved WhatsApp session credentials + lock file (git-ignored, do not share) |

## Notes

- Conversation history is in-memory only and resets when the process restarts.
- `auth_info/` contains your WhatsApp session — treat it like a password and never commit it.
- Every provider reply is validated (non-empty string) before being sent — an empty/garbage response from a provider is treated as a failure and triggers the same retry/fallback path as a network error, rather than ever reaching WhatsApp.
