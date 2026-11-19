// Word-frequency ranks for ordering word-family lists (data/en-frequency.txt, wordfreq, CC BY-SA 4.0).
// Loaded once, only when a family list is ordered; callers fall back to length order if it fails.

let ranksPromise;

/** Map of word → rank (0 = most frequent) from the one-word-per-line list. */
export function parseRanks(text) {
  const ranks = new Map();
  text.split('\n').forEach((line, index) => {
    const word = line.trim();
    if (word && !ranks.has(word)) ranks.set(word, index);
  });
  return ranks;
}

export function loadFrequencyRanks(fetchImpl = fetch) {
  ranksPromise ??= fetchImpl(new URL('./data/en-frequency.txt', import.meta.url))
    .then(response => {
      if (!response.ok) throw new Error(`詞頻資料無法載入（HTTP ${response.status}）`);
      return response.text();
    })
    .then(parseRanks)
    .catch(error => {
      ranksPromise = undefined; // allow a later retry
      throw error;
    });
  return ranksPromise;
}
