import { readFileSync } from 'node:fs';

// The hand-authored personality and fixed lore live in one plain text file that
// FlunkieBot itself can never rewrite: nothing in the application writes here.
export function loadPersonality(url = new URL('./system-prompt.txt', import.meta.url)) {
  return readFileSync(url, 'utf-8').trim();
}
