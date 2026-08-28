// One code-owned JSON Schema is the single source of truth for both provider
// output configuration and local structural validation. Provider-side
// constraints never replace this validation: every result is re-checked here.

export const CLAIM_TEXT_LIMIT = 240;
export const EPISODE_TEXT_LIMIT = 360;
export const INTERACTION_PATTERN_TEXT_LIMIT = 240;
export const EVIDENCE_EXCERPT_LIMIT = 240;
export const MAX_MEMORIES_PER_BATCH = 3;
export const MAX_INVOLVED_PARTICIPANTS = 4;

export const MEMORY_CATEGORIES = [
  'participant_claim',
  'episode',
  'interaction_pattern',
];

// Every field is required; `null` represents allowed absence so the schema fits
// the supported subset of every configured provider.
export const EXTRACTION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['memories'],
  properties: {
    memories: {
      type: 'array',
      maxItems: MAX_MEMORIES_PER_BATCH,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'text', 'subject', 'reporter', 'involved', 'occurredAt', 'evidence'],
        properties: {
          category: { type: 'string', enum: MEMORY_CATEGORIES },
          text: { type: 'string', maxLength: EPISODE_TEXT_LIMIT },
          subject: { type: ['string', 'null'] },
          reporter: { type: ['string', 'null'] },
          involved: {
            type: 'array',
            maxItems: MAX_INVOLVED_PARTICIPANTS,
            items: { type: 'string' },
          },
          occurredAt: { type: ['string', 'null'] },
          evidence: {
            type: 'array',
            minItems: 1,
            maxItems: 2,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['message', 'excerpt'],
              properties: {
                message: { type: 'string' },
                excerpt: { type: 'string', maxLength: EVIDENCE_EXCERPT_LIMIT },
              },
            },
          },
        },
      },
    },
  },
});

export const EXTRACTION_SCHEMA_NAME = 'flunkiebot_memories';

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, expected) {
  const types = Array.isArray(expected) ? expected : [expected];
  const actual = typeOf(value);
  return types.some((type) => type === actual || (type === 'number' && actual === 'integer'));
}

/**
 * Minimal validator for exactly the JSON Schema subset used above. Returns an
 * array of human-readable problems; an empty array means the value is valid.
 */
export function validateAgainstSchema(value, schema = EXTRACTION_SCHEMA, path = 'memories') {
  const problems = [];

  if (schema.type && !matchesType(value, schema.type)) {
    problems.push(`${path}: expected ${[].concat(schema.type).join('|')}, got ${typeOf(value)}`);
    return problems;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    problems.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  }
  if (typeof value === 'string' && schema.maxLength !== undefined && value.length > schema.maxLength) {
    problems.push(`${path}: longer than ${schema.maxLength} characters`);
  }

  if (typeOf(value) === 'array') {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      problems.push(`${path}: more than ${schema.maxItems} entries`);
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      problems.push(`${path}: fewer than ${schema.minItems} entries`);
    }
    if (schema.items) {
      value.forEach((entry, index) => {
        problems.push(...validateAgainstSchema(entry, schema.items, `${path}[${index}]`));
      });
    }
  }

  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) problems.push(`${path}: missing required property "${key}"`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) {
          problems.push(`${path}: unknown property "${key}"`);
        }
      }
    }
    for (const [key, subSchema] of Object.entries(schema.properties ?? {})) {
      if (!Object.hasOwn(value, key)) continue;
      problems.push(...validateAgainstSchema(value[key], subSchema, `${path}.${key}`));
    }
  }

  return problems;
}
