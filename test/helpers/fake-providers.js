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
