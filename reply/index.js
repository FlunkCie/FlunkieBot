import { buildReplyRequest, SILENCE_TOKEN } from './prompt-assembly.js';
import { runWithProviderFallback } from '../provider-fallback.js';

export { SILENCE_TOKEN };

export class InvalidReplyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidReplyError';
  }
}

/**
 * Reply generation. It owns prompt assembly, character budgets, provider
 * fallback, raw-output validation and interpretation of the reserved silence
 * token, and exposes exactly one operation.
 */
export function createReplyGeneration({
  providers,
  personality,
  gifsEnabled = false,
  retryPasses = 2,
  retryDelayMs = 5000,
  sleep,
  logger,
}) {
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error(
      'No reply providers are configured. Set at least one of GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY in your .env file.'
    );
  }

  /**
   * @returns {Promise<{ kind: 'reply', text: string } | { kind: 'silence' }>}
   * Throws when provider fallback is exhausted; exhausted fallback is a
   * generation failure and never intentional silence.
   */
  async function generateReply(replyContext) {
    const request = buildReplyRequest(replyContext, personality, { gifsEnabled });
    const silenceAllowed = replyContext.retrievedMemory?.category === 'interaction_pattern';

    return runWithProviderFallback({
      providers,
      request,
      label: 'reply',
      retryPasses,
      retryDelayMs,
      sleep,
      logger,
      attempt: async (provider, immutableRequest) => {
        const result = await provider.generate(immutableRequest);
        const raw = result?.text;

        if (typeof raw !== 'string' || raw.trim().length === 0) {
          throw new InvalidReplyError(
            `returned invalid output (${typeof raw}: ${JSON.stringify(raw)?.slice(0, 200)})`
          );
        }

        const text = raw.trim();

        // The silence token is interpreted before anything reaches WhatsApp and
        // is never sent as message text.
        if (text === SILENCE_TOKEN) {
          if (!silenceAllowed) {
            throw new InvalidReplyError(
              'returned the silence token without a retrieved interaction pattern'
            );
          }
          return { kind: 'silence' };
        }

        return { kind: 'reply', text };
      },
    });
  }

  return { generateReply };
}
