// How many top matches to pull before picking one - searching the same term
// twice (e.g. "dancing") shouldn't always return the identical gif.
const RESULT_POOL = 8;

/**
 * GIPHY search, created at startup with its key like every other adapter.
 * Returns null when no key is configured, which is how the rest of the
 * application knows the bot must never mention or attempt GIFs.
 */
export function createGifSearch(apiKey) {
  if (!apiKey) return null;

  return {
    async search(query) {
      const url = new URL('https://api.giphy.com/v1/gifs/search');
      url.searchParams.set('api_key', apiKey);
      url.searchParams.set('q', query);
      url.searchParams.set('limit', String(RESULT_POOL));
      url.searchParams.set('rating', 'pg-13');

      const response = await fetch(url);
      if (!response.ok) {
        const body = await response.text().catch(() => response.statusText);
        throw new Error(`GIPHY search failed (${response.status}): ${body}`);
      }

      const data = await response.json();
      const results = data.data || [];
      if (results.length === 0) {
        throw new Error(`GIPHY returned no results for "${query}"`);
      }

      const pick = results[Math.floor(Math.random() * results.length)];
      const mp4Url =
        pick.images?.original?.mp4 || pick.images?.downsized?.mp4 || pick.images?.fixed_height?.mp4;
      if (!mp4Url) {
        throw new Error(`GIPHY result for "${query}" had no mp4 url`);
      }
      return mp4Url;
    },
  };
}
