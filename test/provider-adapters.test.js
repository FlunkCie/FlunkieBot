// Scenarios 39-43. Focused provider-adapter contract tests verify
// provider-specific transport mapping and completion-state validation. No
// network is used: fetch and the Gemini client are injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroqProvider } from '../providers/groq.js';
import { createOpenRouterProvider } from '../providers/openrouter.js';
import { createGeminiProvider } from '../providers/gemini.js';
import {
  createProviders,
  DEFAULT_REPLY_PROVIDER_ORDER,
  DEFAULT_EXTRACTION_PROVIDER_ORDER,
} from '../providers/index.js';
import {
  EXTRACTION_SCHEMA,
  EXTRACTION_SCHEMA_NAME,
  STRICT_EXTRACTION_SCHEMA,
} from '../memory/extraction-schema.js';
import { createReplyGeneration } from '../reply/index.js';
import { failingProvider } from './helpers/fake-providers.js';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    statusText: 'OK',
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function recordingFetch(response) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return typeof response === 'function' ? response(calls.length) : response;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const textRequest = Object.freeze({
  systemInstruction: 'IDENTITEIT',
  messages: Object.freeze([Object.freeze({ role: 'user', content: 'CONTEXT_DATA\n{}' })]),
  output: Object.freeze({ kind: 'text' }),
});

const structuredRequest = Object.freeze({
  systemInstruction: 'EXTRACTIE',
  messages: Object.freeze([Object.freeze({ role: 'user', content: 'CONVERSATION_DATA\n{}' })]),
  output: Object.freeze({
    kind: 'structured',
    name: EXTRACTION_SCHEMA_NAME,
    schema: EXTRACTION_SCHEMA,
    strictSchema: STRICT_EXTRACTION_SCHEMA,
  }),
});

const groqOk = jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'Kanker goed.' } }] });

test('39. maps plain text and structured requests correctly for each provider adapter', async () => {
  const groqFetch = recordingFetch(groqOk);
  const groq = createGroqProvider({ apiKey: 'k', model: 'test-model', fetchImpl: groqFetch });
  assert.deepEqual(await groq.generate(textRequest), { text: 'Kanker goed.' });

  const groqBody = groqFetch.calls[0].body;
  assert.equal(groqBody.model, 'test-model');
  assert.deepEqual(groqBody.messages, [
    { role: 'system', content: 'IDENTITEIT' },
    { role: 'user', content: 'CONTEXT_DATA\n{}' },
  ]);
  assert.equal(groqBody.response_format, undefined, 'a plain text request configures no response format');
  assert.equal(groqFetch.calls[0].options.headers.Authorization, 'Bearer k');

  const routerFetch = recordingFetch(
    jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'Kanker goed.' } }] })
  );
  const openrouter = createOpenRouterProvider({ apiKey: 'k2', model: 'free/model', fetchImpl: routerFetch });
  assert.deepEqual(await openrouter.generate(textRequest), { text: 'Kanker goed.' });
  assert.equal(routerFetch.calls[0].body.response_format, undefined);
  assert.equal(routerFetch.calls[0].body.messages[0].content, 'IDENTITEIT');

  const geminiCalls = [];
  const gemini = createGeminiProvider({
    apiKey: 'k3',
    model: 'gemini-test',
    client: {
      models: {
        async generateContent(options) {
          geminiCalls.push(options);
          return { candidates: [{ finishReason: 'STOP' }], text: 'Kanker goed.' };
        },
      },
    },
  });
  assert.deepEqual(await gemini.generate(textRequest), { text: 'Kanker goed.' });
  assert.equal(geminiCalls[0].model, 'gemini-test');
  assert.equal(geminiCalls[0].config.systemInstruction, 'IDENTITEIT');
  assert.deepEqual(geminiCalls[0].contents, [{ role: 'user', parts: [{ text: 'CONTEXT_DATA\n{}' }] }]);
  assert.equal(geminiCalls[0].config.responseJsonSchema, undefined);
});

test('40. configures strict schema output for Groq extraction', async () => {
  const fetchImpl = recordingFetch(
    jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: '{"memories":[]}' } }] })
  );
  const groq = createGroqProvider({ apiKey: 'k', fetchImpl });

  assert.deepEqual(await groq.generate(structuredRequest), { text: '{"memories":[]}' });

  const { response_format: format } = fetchImpl.calls[0].body;
  assert.equal(format.type, 'json_schema');
  assert.equal(format.json_schema.strict, true);
  assert.equal(format.json_schema.name, EXTRACTION_SCHEMA_NAME);
  // Strict mode rejects the counting and length keywords, so this route carries
  // the strict-safe projection of the same code-owned schema.
  assert.deepEqual(format.json_schema.schema, STRICT_EXTRACTION_SCHEMA);
  for (const keyword of ['maxItems', 'minItems', 'maxLength']) {
    assert.ok(
      !JSON.stringify(format.json_schema.schema).includes(keyword),
      `strict schema output still carries "${keyword}"`
    );
  }
});

test('41. configures supported schema output for Gemini extraction', async () => {
  const calls = [];
  const gemini = createGeminiProvider({
    apiKey: 'k',
    client: {
      models: {
        async generateContent(options) {
          calls.push(options);
          return { candidates: [{ finishReason: 'STOP' }], text: '{"memories":[]}' };
        },
      },
    },
  });

  assert.deepEqual(await gemini.generate(structuredRequest), { text: '{"memories":[]}' });
  assert.equal(calls[0].config.responseMimeType, 'application/json');
  assert.deepEqual(calls[0].config.responseJsonSchema, EXTRACTION_SCHEMA);
});

test('42. configures OpenRouter JSON Object Mode with required parameter support', async () => {
  const fetchImpl = recordingFetch(
    jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: '{"memories":[]}' } }] })
  );
  const openrouter = createOpenRouterProvider({ apiKey: 'k', fetchImpl });

  assert.deepEqual(await openrouter.generate(structuredRequest), { text: '{"memories":[]}' });

  const body = fetchImpl.calls[0].body;
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.deepEqual(body.provider, { require_parameters: true });
  // The free route has no schema enforcement, so the full schema travels in the
  // instructions, length and cardinality bounds included; local validation still
  // decides what is acceptable.
  assert.ok(body.messages[0].content.includes(JSON.stringify(EXTRACTION_SCHEMA)));
  assert.ok(body.messages[0].content.includes('maxLength'));
  assert.ok(body.messages[0].content.startsWith('EXTRACTIE'));
});

test('43. normalizes provider errors and honors configured provider order and bounded retries', async () => {
  // HTTP errors, non-normal completion states and missing candidates all become
  // short normalized errors carrying the status.
  const httpError = createGroqProvider({
    apiKey: 'k',
    fetchImpl: recordingFetch(
      jsonResponse({ error: { message: 'Rate limit reached' } }, { ok: false, status: 429 })
    ),
  });
  await assert.rejects(httpError.generate(textRequest), (err) => {
    assert.equal(err.status, 429);
    assert.match(err.message, /^Groq 429: Rate limit reached$/);
    return true;
  });

  const truncated = createGroqProvider({
    apiKey: 'k',
    fetchImpl: recordingFetch(
      jsonResponse({ choices: [{ finish_reason: 'length', message: { content: 'half' } }] })
    ),
  });
  await assert.rejects(truncated.generate(textRequest), /finish_reason: length/);

  const refused = createOpenRouterProvider({
    apiKey: 'k',
    fetchImpl: recordingFetch(
      jsonResponse({ choices: [{ finish_reason: 'stop', message: { refusal: 'nope' } }] })
    ),
  });
  await assert.rejects(refused.generate(textRequest), /model refused/);

  const noCandidate = createGeminiProvider({
    apiKey: 'k',
    client: { models: { async generateContent() { return { candidates: [] }; } } },
  });
  await assert.rejects(noCandidate.generate(textRequest), /no candidate/);

  const filtered = createGeminiProvider({
    apiKey: 'k',
    client: {
      models: {
        async generateContent() {
          return { promptFeedback: { blockReason: 'SAFETY' } };
        },
      },
    },
  });
  await assert.rejects(filtered.generate(textRequest), /blocked \(SAFETY\)/);

  // Configured provider order, for both the reply and the extraction path.
  const env = {
    GROQ_API_KEY: 'a',
    OPENROUTER_API_KEY: 'b',
    GEMINI_API_KEY: 'c',
  };
  const { replyProviders, extractionProviders } = createProviders(env, {
    geminiClient: { models: { async generateContent() { return {}; } } },
  });
  assert.deepEqual(replyProviders.map((p) => p.name), DEFAULT_REPLY_PROVIDER_ORDER.split(','));
  assert.deepEqual(
    extractionProviders.map((p) => p.name),
    DEFAULT_EXTRACTION_PROVIDER_ORDER.split(',')
  );

  const custom = createProviders(
    { ...env, LLM_PROVIDER_ORDER: 'gemini,groq', MEMORY_PROVIDER_ORDER: 'openrouter' },
    { geminiClient: { models: { async generateContent() { return {}; } } } }
  );
  assert.deepEqual(custom.replyProviders.map((p) => p.name), ['gemini', 'groq']);
  assert.deepEqual(custom.extractionProviders.map((p) => p.name), ['openrouter']);
  // Unconfigured providers are skipped rather than failing the order.
  const partial = createProviders({ GROQ_API_KEY: 'a' });
  assert.deepEqual(partial.replyProviders.map((p) => p.name), ['groq']);

  // Bounded retries: the whole chain is retried a fixed number of passes.
  const first = failingProvider('groq', 'down');
  const second = failingProvider('openrouter', 'down');
  const delays = [];
  const replyGeneration = createReplyGeneration({
    providers: [first, second],
    personality: 'IDENTITEIT',
    retryPasses: 3,
    retryDelayMs: 1234,
    sleep: async (ms) => delays.push(ms),
  });

  await assert.rejects(
    replyGeneration.generateReply({
      conversation: { kind: 'direct', label: null },
      addressedParticipant: { id: null, label: 'Alex' },
      messageToAnswer: { messageId: 1, text: 'hoi' },
      recentMessages: [],
      retrievedMemory: null,
    }),
    /All reply providers failed after 3 passes/
  );

  assert.equal(first.calls.length, 3, 'each pass tries every provider exactly once');
  assert.equal(second.calls.length, 3);
  assert.deepEqual(delays, [1234, 1234], 'the configured retry delay is used between passes');
});
