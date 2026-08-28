/**
 * Deterministic fake provider adapters. They satisfy the same internal
 * interface as the real adapters and never touch the network.
 */
export function fakeProvider(name, respond) {
  const calls = [];
  return {
    name,
    calls,
    async generate(request) {
      calls.push(request);
      const result = typeof respond === 'function' ? await respond(request, calls.length) : respond;
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

export function failingProvider(name, message = 'provider unavailable') {
  return fakeProvider(name, () => {
    throw new Error(message);
  });
}

export function textProvider(name, text) {
  return fakeProvider(name, { text });
}

/** Replies with the extraction batch supplied for that call, as raw JSON text. */
export function extractionProvider(name, batches) {
  const queue = Array.isArray(batches) ? [...batches] : [batches];
  return fakeProvider(name, () => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return { text: typeof next === 'string' ? next : JSON.stringify(next) };
  });
}
