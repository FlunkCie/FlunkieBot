import { providerError } from './error.js';

const DEFAULT_MODEL = 'openai/gpt-oss-120b';
const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

// Transport only: authentication, model selection, request translation, remote
// invocation, output-mode configuration, completion checks and normalized
// errors. This adapter knows nothing about personality, memory or fallback.
export function createGroqProvider({ apiKey, model = DEFAULT_MODEL, fetchImpl = fetch }) {
  return {
    name: 'groq',

    async generate(request) {
      const body = {
        model,
        messages: [
          { role: 'system', content: request.systemInstruction },
          ...request.messages.map(({ role, content }) => ({ role, content })),
        ],
      };

      // Groq supports strict JSON Schema output, the strongest mode available
      // here. Strict mode accepts only a core keyword subset, so the request's
      // strict-safe schema is preferred where it carries one.
      if (request.output.kind === 'structured') {
        body.response_format = {
          type: 'json_schema',
          json_schema: {
            name: request.output.name,
            strict: true,
            schema: request.output.strictSchema ?? request.output.schema,
          },
        };
      }

      let response;
      try {
        response = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        throw providerError('Groq', undefined, err.message || String(err));
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw providerError('Groq', response.status, text || response.statusText);
      }

      const data = await response.json();
      const choice = data.choices?.[0];
      if (!choice) throw providerError('Groq', response.status, 'response had no candidate');
      if (choice.message?.refusal) {
        throw providerError('Groq', response.status, `model refused: ${choice.message.refusal}`);
      }
      if (choice.finish_reason && choice.finish_reason !== 'stop') {
        throw providerError(
          'Groq',
          response.status,
          `generation did not complete normally (finish_reason: ${choice.finish_reason})`
        );
      }

      const text = choice.message?.content;
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw providerError('Groq', response.status, 'response had no content');
      }
      return { text };
    },
  };
}
