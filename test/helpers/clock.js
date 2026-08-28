/** An injected clock so retention boundaries and ordering stay deterministic. */
export function createClock(startMs = Date.UTC(2026, 0, 1, 12, 0, 0)) {
  let current = startMs;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
      return current;
    },
    set(ms) {
      current = ms;
      return current;
    },
  };
}
