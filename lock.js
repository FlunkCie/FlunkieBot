import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

// Running two processes (e.g. a host `npm start` and a Docker container)
// against the same auth_info session at once desyncs WhatsApp's Signal
// encryption session — the exact bug that caused "Waiting for this message"
// on the recipient's side. This lock lives inside auth_info/, which is
// bind-mounted into the container, so it's visible to both host and Docker
// runs regardless of which one starts first.
const LOCK_PATH = fileURLToPath(new URL('./auth_info/.bot.lock', import.meta.url));
const STALE_MS = 5 * 60 * 1000;

export function acquireLock() {
  mkdirSync(dirname(LOCK_PATH), { recursive: true });

  if (existsSync(LOCK_PATH)) {
    const ageMs = Date.now() - statSync(LOCK_PATH).mtimeMs;
    if (ageMs < STALE_MS) {
      throw new Error(
        `Another FlunkieBot instance appears to already be using this WhatsApp session ` +
          `(lock is ${Math.round(ageMs / 1000)}s old). Running two instances against the same ` +
          `auth_info at once corrupts the session. Stop the other instance first.`
      );
    }
    logger.warn({ ageMs }, 'Found a stale session lock (no clean shutdown last time), reclaiming it');
  }

  writeFileSync(LOCK_PATH, String(process.pid));
}

export function releaseLock() {
  try {
    unlinkSync(LOCK_PATH);
  } catch {
    // already gone, nothing to clean up
  }
}
