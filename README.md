# FlunkieBot

A WhatsApp bot built on [Baileys](https://github.com/WhiskeySockets/Baileys) that answers messages using an LLM, with automatic fallback across three free-tier providers.

- **Direct messages**: every message gets an LLM-generated reply.
- **Group chats**: only replies when tagged with `@FlunkieBot`.
- **Multi-provider fallback**: tries Gemini, then Groq, then OpenRouter (configurable order) — if one is rate-limited or erroring, it automatically falls through to the next, stretching your combined free-tier quota.
- Keeps a short rolling conversation history per chat so replies stay contextual.
- Shows a "typing…" indicator while generating a reply.
- Personality/behavior is fully configurable via a plain text system prompt.
- Auto-reconnects with backoff on disconnects, and logs everything with structured JSON logs.

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

   | Variable              | Required | Default                              | Description                                                |
   | --------------------- | -------- | ------------------------------------- | ----------------------------------------------------------- |
   | `GEMINI_API_KEY`      | one of three | —                              | Enables the Gemini provider                                 |
   | `GEMINI_MODEL`        | no       | `gemini-3.6-flash`                    | Gemini model to use                                          |
   | `GROQ_API_KEY`        | one of three | —                              | Enables the Groq provider                                    |
   | `GROQ_MODEL`          | no       | `llama-3.3-70b-versatile`             | Groq model to use                                             |
   | `OPENROUTER_API_KEY`  | one of three | —                              | Enables the OpenRouter provider                              |
   | `OPENROUTER_MODEL`    | no       | `meta-llama/llama-3.3-70b-instruct:free` | OpenRouter model to use                                   |
   | `LLM_PROVIDER_ORDER`  | no       | `gemini,groq,openrouter`              | Comma-separated fallback order; unconfigured providers are skipped |
   | `HISTORY_LIMIT`       | no       | `20`                                  | Max messages kept per chat for conversation context          |
   | `LOG_LEVEL`           | no       | `info`                                | App log verbosity: trace, debug, info, warn, error, fatal    |
   | `BAILEYS_LOG_LEVEL`   | no       | `warn`                                | Verbosity of Baileys' own internal logger                    |
   | `DEBUG_MENTIONS`      | no       | unset                                 | Set to `1` to log group mention-matching details             |

   At least one provider's API key must be set. Configuring all three gives the bot the most resilience against any single provider's free-tier rate limits.

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

## Project structure

| File                       | Purpose                                                             |
| -------------------------- | -------------------------------------------------------------------- |
| `index.js`                 | Baileys connection, message routing, mention detection, reconnect logic |
| `llm.js`                   | Provider fallback orchestrator                                      |
| `providers/gemini.js`      | Gemini API client                                                    |
| `providers/groq.js`        | Groq API client                                                      |
| `providers/openrouter.js`  | OpenRouter API client                                                |
| `prompt.js`                | Loads `system-prompt.txt`                                            |
| `history.js`               | In-memory per-chat conversation history                             |
| `logger.js`                | Structured logging setup                                            |
| `system-prompt.txt`        | LLM system prompt / bot personality                                  |
| `auth_info/`               | Saved WhatsApp session credentials (git-ignored, do not share)      |

## Notes

- Conversation history is in-memory only and resets when the process restarts.
- `auth_info/` contains your WhatsApp session — treat it like a password and never commit it.
