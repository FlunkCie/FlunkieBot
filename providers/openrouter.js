import { systemPrompt } from '../prompt.js';
import { providerError } from './error.js';

const apiKey = process.env.OPENROUTER_API_KEY;
const model = process.env.OPENROUTER_MODEL || 'minimax/minimax-m3:free';

export const name = 'openrouter';

export function isConfigured() {
  return Boolean(apiKey);
}

export async function ask(messages) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/flunkiebot',
      'X-Title': 'FlunkieBot',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw providerError('OpenRouter', response.status, body || response.statusText);
  }

  const data = await response.json();
  const reply = data.choices?.[0]?.message?.content;
  if (!reply) {
    throw providerError('OpenRouter', response.status, 'response had no content');
  }
  return reply;
}
