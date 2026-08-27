import { systemPrompt } from '../prompt.js';
import { providerError } from './error.js';

const apiKey = process.env.GROQ_API_KEY;
const model = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

export const name = 'groq';

export function isConfigured() {
  return Boolean(apiKey);
}

export async function ask(messages) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw providerError('Groq', response.status, body || response.statusText);
  }

  const data = await response.json();
  const reply = data.choices?.[0]?.message?.content;
  if (!reply) {
    throw providerError('Groq', response.status, 'response had no content');
  }
  return reply;
}
