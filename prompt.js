import { readFileSync } from 'fs';
import { isConfigured as gifConfigured } from './gif.js';

const basePrompt = readFileSync(
  new URL('./system-prompt.txt', import.meta.url),
  'utf-8'
).trim();

// Only tell the model it can send gifs if a GIPHY key is actually
// configured — otherwise it'll confidently emit directives that go nowhere.
const gifAddendum = `

You can also send a GIF instead of text. To do that, put a line containing only [gif: <short English search term>] as its own separate message — on its own line, separated by ||| from everything else. Use it sparingly, only when a reaction gif genuinely lands better than words, the way people actually use them. Never combine it with text on the same line, and never explain or mention that you're sending one.`;

export const systemPrompt = gifConfigured() ? `${basePrompt}${gifAddendum}` : basePrompt;
