import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created = [];

/** Returns a path inside a fresh temporary directory, cleaned up on exit. */
export function temporaryDatabasePath(name = 'flunkiebot.sqlite') {
  const directory = mkdtempSync(join(tmpdir(), 'flunkiebot-test-'));
  created.push(directory);
  return join(directory, name);
}

process.on('exit', () => {
  for (const directory of created) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  }
});
