import { GoogleGenAI } from '@google/genai';
import { systemPrompt } from '../prompt.js';
import { providerError } from './error.js';

const apiKey = process.env.GEMINI_API_KEY;
const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

export const name = 'gemini';

export function isConfigured() {
  return Boolean(apiKey);
}

function toGeminiContents(messages) {
  return messages.map(({ role, content }) => ({
    role: role === 'assistant' ? 'model' : 'user',
    parts: [{ text: content }],
  }));
}

export async function ask(messages) {
  let response;
  try {
    response = await ai.models.generateContent({
      model,
      contents: toGeminiContents(messages),
      config: { systemInstruction: systemPrompt },
    });
  } catch (err) {
    throw providerError('Gemini', err.status, err.message || String(err));
  }

  const reply = response.text;
  if (!reply) {
    throw providerError('Gemini', undefined, 'response had no text');
  }
  return reply;
}
