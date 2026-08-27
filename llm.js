import { logger } from './logger.js';
import * as gemini from './providers/gemini.js';
import * as groq from './providers/groq.js';
import * as openrouter from './providers/openrouter.js';

const allProviders = { gemini, groq, openrouter };

// Default order favors model quality/reliability: Groq (strong 70B model on
// dedicated infra) and OpenRouter (comparable model, shared free pool) before
// Gemini (weaker Flash-Lite tier, kept last as the high-quota fallback).
const order = (process.env.LLM_PROVIDER_ORDER || 'groq,openrouter,gemini')
  .split(',')
  .map((name) => name.trim().toLowerCase())
  .filter((name) => allProviders[name]);

const providers = order.map((name) => allProviders[name]).filter((provider) => provider.isConfigured());

if (providers.length === 0) {
  throw new Error(
    'No LLM providers are configured. Set at least one of GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY in your .env file.'
  );
}

logger.info({ providers: providers.map((p) => p.name) }, 'LLM providers configured, in fallback order');

const RETRY_PASSES = Number(process.env.LLM_RETRY_PASSES) || 2;
const RETRY_DELAY_MS = Number(process.env.LLM_RETRY_DELAY_MS) || 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A provider can return HTTP 200 with garbage: empty string, null, an object,
// whitespace-only text. Never let that reach WhatsApp — treat it exactly like
// a hard failure so the caller retries/falls through instead of "succeeding".
function assertValidReply(reply, providerName) {
  if (typeof reply !== 'string' || reply.trim().length === 0) {
    throw new Error(
      `${providerName} returned an invalid reply (${typeof reply}: ${JSON.stringify(reply)?.slice(0, 200)})`
    );
  }
}

// A single pass through the provider list can fail entirely if e.g. a free
// provider's shared pool is briefly congested — that's transient, not a real
// outage, so retry the whole chain a couple of times before giving up.
export async function askLLM(messages) {
  let failures = [];

  for (let pass = 1; pass <= RETRY_PASSES; pass++) {
    failures = [];

    for (const provider of providers) {
      try {
        const reply = await provider.ask(messages);
        assertValidReply(reply, provider.name);
        logger.info(`[${provider.name}] replied (pass ${pass}, ${reply.length} chars)`);
        return reply;
      } catch (err) {
        // err.message is already a short, human-readable summary (see providers/error.js) —
        // log just that at warn so failures are scannable; full stack goes to debug only.
        logger.warn(`[${provider.name}] failed (pass ${pass}): ${err.message}`);
        logger.debug({ err, provider: provider.name, pass }, 'full provider error');
        failures.push(`${provider.name}: ${err.message}`);
      }
    }

    if (pass < RETRY_PASSES) {
      logger.warn(`All providers failed on pass ${pass}, retrying in ${RETRY_DELAY_MS}ms`);
      await sleep(RETRY_DELAY_MS);
    }
  }

  throw new Error(`All LLM providers failed after ${RETRY_PASSES} passes: ${failures.join(' | ')}`);
}
