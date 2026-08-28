// Deterministic text normalization shared by retrieval keywords and durable
// memory duplicate keys. No language model, no stemming: Unicode folding,
// lowercasing, punctuation removal, and a fixed stop-word list only.

// A deliberately small Dutch-and-English list. It is fixed in code so that
// retrieval stays reproducible across restarts and providers.
export const STOP_WORDS = new Set([
  // Dutch
  'aan', 'als', 'bij', 'dan', 'dat', 'deze', 'die', 'dit', 'door', 'een', 'eens',
  'en', 'er', 'had', 'heb', 'hebben', 'het', 'hij', 'hoe', 'iets', 'ik', 'als',
  'is', 'je', 'kan', 'maar', 'met', 'mij', 'mijn', 'naar', 'niet', 'nog', 'nu',
  'ook', 'over', 'toch', 'toen', 'uit', 'van', 'veel', 'voor', 'was', 'wat',
  'wel', 'werd', 'wij', 'zei', 'zij', 'zijn', 'zo', 'zou', 'jij', 'jou', 'jouw',
  'hem', 'haar', 'hun', 'ze', 'we', 'de', 'om', 'op', 'te', 'ben', 'bent',
  // English
  'about', 'after', 'all', 'and', 'any', 'are', 'because', 'been', 'but', 'can',
  'did', 'does', 'for', 'from', 'had', 'has', 'have', 'her', 'him', 'his', 'how',
  'into', 'its', 'just', 'not', 'now', 'off', 'one', 'our', 'out', 'over', 'she',
  'that', 'the', 'their', 'them', 'then', 'there', 'they', 'this', 'was', 'were',
  'what', 'when', 'which', 'who', 'why', 'will', 'with', 'you', 'your',
]);

const MIN_TOKEN_LENGTH = 3;

// NFKD plus combining-mark removal folds "café" and "cafe" onto one token, so a
// message written with or without diacritics matches the same memory.
export function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function keywordsOf(value) {
  const keywords = new Set();
  for (const token of normalizeText(value).split(' ')) {
    if (token.length < MIN_TOKEN_LENGTH) continue;
    if (STOP_WORDS.has(token)) continue;
    keywords.add(token);
  }
  return keywords;
}
