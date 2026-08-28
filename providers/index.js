import { createGeminiProvider } from './gemini.js';
import { createGroqProvider } from './groq.js';
import { createOpenRouterProvider } from './openrouter.js';

export const DEFAULT_REPLY_PROVIDER_ORDER = 'groq,openrouter,gemini';
// Schema-enforced routes precede OpenRouter's best-effort JSON Object Mode.
export const DEFAULT_EXTRACTION_PROVIDER_ORDER = 'groq,gemini,openrouter';

/**
 * Composition root helper: builds the configured provider adapters once, from
 * explicit configuration. Nothing here is a preconstructed module-level client.
 */
export function createProviders(env = process.env, overrides = {}) {
  const built = new Map();

  if (env.GROQ_API_KEY) {
    built.set(
      'groq',
      createGroqProvider({
        apiKey: env.GROQ_API_KEY,
        model: env.GROQ_MODEL || undefined,
        fetchImpl: overrides.fetchImpl,
      })
    );
  }
  if (env.OPENROUTER_API_KEY) {
    built.set(
      'openrouter',
      createOpenRouterProvider({
        apiKey: env.OPENROUTER_API_KEY,
        model: env.OPENROUTER_MODEL || undefined,
        fetchImpl: overrides.fetchImpl,
      })
    );
  }
  if (env.GEMINI_API_KEY) {
    built.set(
      'gemini',
      createGeminiProvider({
        apiKey: env.GEMINI_API_KEY,
        model: env.GEMINI_MODEL || undefined,
        client: overrides.geminiClient,
      })
    );
  }

  const inOrder = (raw, fallback) =>
    (raw || fallback)
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .map((name) => built.get(name))
      .filter(Boolean);

  return {
    replyProviders: inOrder(env.LLM_PROVIDER_ORDER, DEFAULT_REPLY_PROVIDER_ORDER),
    extractionProviders: inOrder(env.MEMORY_PROVIDER_ORDER, DEFAULT_EXTRACTION_PROVIDER_ORDER),
  };
}
