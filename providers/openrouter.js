import { providerError } from './error.js';

const DEFAULT_MODEL = 'minimax/minimax-m3:free';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

// The current free OpenRouter route supports JSON Object Mode rather than
// strict JSON Schema, so the schema travels in the instructions and
// `provider.require_parameters` keeps the request off routes that would silently
// drop it. Local validation still decides whether the result is acceptable.
export function createOpenRouterProvider({ apiKey, model = DEFAULT_MODEL, fetchImpl = fetch }) {
  return {
    name: 'openrouter',

    async generate(request) {
      let systemInstruction = request.systemInstruction;
      const body = {
        model,
        messages: [],
      };

      if (request.output.kind === 'structured') {
        body.response_format = { type: 'json_object' };
        body.provider = { require_parameters: true };
        systemInstruction = `${systemInstruction}\n\nAntwoord met JSON dat exact voldoet aan dit JSON Schema:\n${JSON.stringify(
          request.output.schema
        )}`;
      }

      body.messages = [
        { role: 'system', content: systemInstruction },
        ...request.messages.map(({ role, content }) => ({ role, content })),
      ];

      let response;
      try {
        response = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/flunkiebot',
            'X-Title': 'FlunkieBot',
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        throw providerError('OpenRouter', undefined, err.message || String(err));
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw providerError('OpenRouter', response.status, text || response.statusText);
      }

      const data = await response.json();
      const choice = data.choices?.[0];
      if (!choice) throw providerError('OpenRouter', response.status, 'response had no candidate');
      if (choice.message?.refusal) {
        throw providerError('OpenRouter', response.status, `model refused: ${choice.message.refusal}`);
      }
      const finishReason = choice.finish_reason ?? choice.native_finish_reason;
      if (finishReason && finishReason !== 'stop') {
        throw providerError(
          'OpenRouter',
          response.status,
          `generation did not complete normally (finish_reason: ${finishReason})`
        );
      }

      const text = choice.message?.content;
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw providerError('OpenRouter', response.status, 'response had no content');
      }
      return { text };
    },
  };
}
