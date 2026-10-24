// Batch discovery deliberately requests lexical relations only. It never grows an ancestry tree.
const MAX_TERM_LENGTH = 200;
const MAX_CONCURRENCY = 2;
const forbidden = /[<>\[\]{}|#:/\\]/u;
const controls = /[\u0000-\u001f\u007f-\u009f]/u;
const canonical = value => value.normalize('NFC').trim().replace(/[ \u00a0]+/gu, ' ');
const identity = value => value.toLowerCase();

function invalidReason(term) {
  if (!term) return 'empty';
  if (term.length > MAX_TERM_LENGTH) return 'too-long';
  if (controls.test(term)) return 'control-character';
  if (forbidden.test(term)) return 'unsupported-character';
  if (!/[\p{L}\p{N}]/u.test(term)) return 'not-a-word';
  return null;
}

/** Split lines, commas, or semicolons; spaces inside a phrase stay together. */
export function parseBulkWords(text, { limit = 20 } = {}) {
  if (typeof text !== 'string') throw new TypeError('Bulk input must be text.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new RangeError('Bulk limit must be between 1 and 50.');
  const words = [];
  const duplicates = [];
  const overflow = [];
  const invalid = [];
  const seen = new Set();
  for (const raw of text.split(/[\r\n,;]+/u)) {
    const term = canonical(raw);
    if (!term) continue;
    const reason = invalidReason(term);
    if (reason) {
      invalid.push({ term, reason });
      continue;
    }
    const key = identity(term);
    if (seen.has(key)) {
      duplicates.push(term);
      continue;
    }
    seen.add(key);
    if (words.length < limit) words.push(term);
    else overflow.push(term);
  }
  return { words, duplicates, overflow, invalid };
}

function hasRelations(data) {
  return Array.isArray(data?.etymologies) && data.etymologies.some(etymology =>
    Array.isArray(etymology?.partsOfSpeech) && etymology.partsOfSpeech.some(part =>
      Array.isArray(part?.relations) && part.relations.some(relation =>
        ['synonym', 'antonym'].includes(relation?.kind)
        && Array.isArray(relation.terms) && relation.terms.some(term => typeof term === 'string' && term.trim()))));
}

function describeError(error) {
  const rawStatus = Number(error?.status);
  const retryAfter = Number(error?.retryAfter);
  return Object.freeze({
    message: typeof error?.message === 'string' && error.message ? error.message
      : typeof error?.title === 'string' && error.title ? error.title : 'Lookup failed.',
    status: Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : null,
    detail: typeof error?.detail === 'string' ? error.detail : null,
    retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : null,
  });
}

/**
 * Streams completed lookups with their original input index. An optional lookupBatch reduces
 * dictionary round trips in small chunks while preserving a result for every requested word.
 * In-flight lookups cannot be stopped
 * by the browser engine; abort suppresses their results and callbacks, and starts no new work.
 * Rate-limiting stops the queue without automatically retrying or sleeping. Pending/retryable
 * words can be offered for a later explicit retry after the reported Retry-After interval.
 */
export async function runBulkLookup(words, { lookup, lookupBatch, batchSize = 5, onResult, onProgress, signal, concurrency = 2 } = {}) {
  if (!Array.isArray(words) || words.length > 50 || (typeof lookup !== 'function' && typeof lookupBatch !== 'function')) {
    throw new TypeError('Provide at most 50 words and a lexical lookup function or batch function.');
  }
  if (lookup !== undefined && typeof lookup !== 'function') throw new TypeError('lookup must be a function.');
  if (lookupBatch !== undefined && typeof lookupBatch !== 'function') throw new TypeError('lookupBatch must be a function.');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 20) throw new RangeError('Batch size must be between 1 and 20.');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('Concurrency must be a positive integer.');
  if (onResult !== undefined && typeof onResult !== 'function') throw new TypeError('onResult must be a function.');
  if (onProgress !== undefined && typeof onProgress !== 'function') throw new TypeError('onProgress must be a function.');
  const input = [];
  const seen = new Set();
  for (const value of words) {
    if (typeof value !== 'string') throw new TypeError('Words must be text.');
    const word = canonical(value);
    if (invalidReason(word) || seen.has(identity(word))) {
      throw new TypeError('Provide valid unique words; parseBulkWords can prepare the input.');
    }
    seen.add(identity(word));
    input.push(word);
  }

  const results = Array(input.length).fill(null);
  let nextIndex = 0;
  let completed = 0;
  let rateLimited = false;
  let retryAfter = null;
  let callbackError = null;
  const stopped = () => signal?.aborted || rateLimited || callbackError;
  const progress = () => {
    if (!signal?.aborted && !callbackError) onProgress?.({ completed, total: input.length, pending: input.length - completed });
  };
  progress();

  function failureRecord(index, word, error) {
    const failure = describeError(error);
    const limited = failure.status === 429 || (failure.status === 503 && failure.retryAfter !== null);
    if (limited) {
      rateLimited = true;
      retryAfter = Math.max(retryAfter || 0, failure.retryAfter || 0) || null;
    }
    return Object.freeze({ index, word, status: 'error', error: failure, rateLimited: limited });
  }

  function dataRecord(index, word, data) {
    return Object.freeze({ index, word, status: hasRelations(data) ? 'success' : 'empty', data });
  }

  function batchRecords(start, chunk, response) {
    if (!Array.isArray(response)) throw new TypeError('The batch lookup did not return word records.');
    const requested = new Set(chunk);
    const records = new Map();
    const duplicates = new Set();
    for (const row of response) {
      if (!row || typeof row !== 'object' || typeof row.word !== 'string') continue;
      const word = canonical(row.word);
      if (!requested.has(word)) continue;
      if (records.has(word)) duplicates.add(word);
      else records.set(word, row);
    }
    return chunk.map((word, offset) => {
      const index = start + offset;
      const row = records.get(word);
      if (!row || duplicates.has(word)) return failureRecord(index, word, new Error('The batch lookup returned a missing or duplicate word record.'));
      if (row.error != null) return failureRecord(index, word, row.error);
      if (!Object.hasOwn(row, 'data')) return failureRecord(index, word, new Error('The batch lookup returned an invalid word record.'));
      return dataRecord(index, word, row.data);
    });
  }

  function publish(record) {
    if (signal?.aborted || callbackError) return false;
    results[record.index] = record;
    completed += 1;
    try {
      onResult?.(record);
      progress();
      return !signal?.aborted && !callbackError;
    } catch (error) {
      // Consumer failures must not masquerade as dictionary errors or leave workers dispatching.
      callbackError = error;
      return false;
    }
  }

  async function worker() {
    while (!stopped() && nextIndex < input.length) {
      const start = nextIndex;
      const chunk = input.slice(start, start + (lookupBatch ? batchSize : 1));
      nextIndex += chunk.length;
      let records;
      try {
        const response = lookupBatch ? await lookupBatch(chunk) : await lookup(chunk[0]);
        if (signal?.aborted || callbackError) return;
        records = lookupBatch ? batchRecords(start, chunk, response) : [dataRecord(start, chunk[0], response)];
      } catch (error) {
        if (signal?.aborted || callbackError) return;
        records = chunk.map((word, offset) => failureRecord(start + offset, word, error));
      }
      for (const record of records) if (!publish(record)) return;
    }
  }

  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, concurrency, input.length) }, worker));
  if (callbackError) throw callbackError;
  const pendingIndices = results.flatMap((record, index) => record === null ? [index] : []);
  const retryable = results.flatMap((record, index) => record === null || record.rateLimited ? [input[index]] : []);
  return {
    results, pending: pendingIndices.map(index => input[index]), pendingIndices, completed,
    cancelled: Boolean(signal?.aborted), rateLimited, retryAfter, retryable,
  };
}
