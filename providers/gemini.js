import { GoogleGenAI } from '@google/genai';
import { providerError } from './error.js';

const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

// Gemini's supported schema-constrained JSON configuration is
// `responseMimeType: application/json` plus `responseJsonSchema`.
export function createGeminiProvider({ apiKey, model = DEFAULT_MODEL, client }) {
  const ai = client ?? new GoogleGenAI({ apiKey });

  return {
    name: 'gemini',

    async generate(request) {
      const config = { systemInstruction: request.systemInstruction };
      if (request.output.kind === 'structured') {
        config.responseMimeType = 'application/json';
        config.responseJsonSchema = request.output.schema;
      }

      let response;
      try {
        response = await ai.models.generateContent({
          model,
          contents: request.messages.map(({ role, content }) => ({
            role: role === 'assistant' ? 'model' : 'user',
            parts: [{ text: content }],
          })),
          config,
        });
      } catch (err) {
        throw providerError('Gemini', err.status, err.message || String(err));
      }

      if (response?.promptFeedback?.blockReason) {
        throw providerError(
          'Gemini',
          undefined,
          `prompt was blocked (${response.promptFeedback.blockReason})`
        );
      }

      const candidate = response?.candidates?.[0];
      if (!candidate) throw providerError('Gemini', undefined, 'response had no candidate');
      if (candidate.finishReason && candidate.finishReason !== 'STOP') {
        throw providerError(
          'Gemini',
          undefined,
          `generation did not complete normally (finishReason: ${candidate.finishReason})`
        );
      }

      const text = response.text;
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw providerError('Gemini', undefined, 'response had no text');
      }
      return { text };
    },
  };
}
