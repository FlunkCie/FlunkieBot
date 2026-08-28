// Bounded provider fallback shared by the two owning modules: reply generation
// and the memory module's extraction path. It knows nothing about personality,
// memory policy or transport - it only walks a configured provider order for a
// bounded number of passes and normalizes the exhausted-fallback error.

export class ProviderFallbackExhaustedError extends Error {
  constructor(label, passes, failures) {
    super(`All ${label} providers failed after ${passes} passes: ${failures.join(' | ')}`);
    this.name = 'ProviderFallbackExhaustedError';
    this.failures = failures;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `attempt` against each provider in order, retrying the whole chain for a
 * bounded number of passes. The request is never rebuilt between attempts.
 * `perProviderRetries` controls how many extra attempts each provider gets
 * before the fallback moves on to the next one.
 */
export async function runWithProviderFallback({
  providers,
  request,
  attempt,
  label,
  retryPasses = 2,
  retryDelayMs = 5000,
  perProviderRetries = 0,
  sleep = defaultSleep,
  logger,
}) {
  if (!providers || providers.length === 0) {
    throw new ProviderFallbackExhaustedError(label, 0, ['no providers configured']);
  }

  let failures = [];

  for (let pass = 1; pass <= retryPasses; pass += 1) {
    failures = [];

    for (const provider of providers) {
      let lastErr;
      for (let retry = 0; retry <= perProviderRetries; retry += 1) {
        try {
          const result = await attempt(provider, request);
          logger?.info?.(`[${provider.name}] ${label} succeeded (pass ${pass})`);
          return result;
        } catch (err) {
          lastErr = err;
          logger?.warn?.(`[${provider.name}] ${label} failed (pass ${pass}, attempt ${retry + 1}): ${err.message}`);
          logger?.debug?.({ err, provider: provider.name, pass, retry }, 'full provider error');
        }
      }
      failures.push(`${provider.name}: ${lastErr.message}`);
    }

    if (pass < retryPasses) {
      logger?.warn?.(`All ${label} providers failed on pass ${pass}, retrying in ${retryDelayMs}ms`);
      await sleep(retryDelayMs);
    }
  }

  throw new ProviderFallbackExhaustedError(label, retryPasses, failures);
}
