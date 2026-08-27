import { readFileSync } from 'fs';

export const systemPrompt = readFileSync(
  new URL('./system-prompt.txt', import.meta.url),
  'utf-8'
).trim();
