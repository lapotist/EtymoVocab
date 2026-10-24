import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBulkWords, runBulkLookup } from '../../src/EtymoVocab.Web/wwwroot/bulk-lookup.js';

const relations = word => ({ word, source: { revisionId: 42 }, resolvedFrom: 'queried form', etymologies: [
  { id: 'sense-1', partsOfSpeech: [{ pos: 'Adjective', relations: [{ kind: 'synonym', sense: 'pleasant', terms: ['pleasant'] }] }] },
] });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('bulk parsing preserves phrases, normalizes case/NFC duplicates and reports overflow explicitly', () => {
  const result = parseBulkWords(' Nice, ice  cream;NICE\n café\r\ncafe\u0301; kind; mild; MILD ', { limit: 3 });
  assert.deepEqual(result.words, ['Nice', 'ice cream', 'café']);
  assert.deepEqual(result.duplicates, ['NICE', 'café', 'MILD']);
  assert.deepEqual(result.overflow, ['kind', 'mild']);
  assert.deepEqual(result.invalid, []);
});

test('bulk parsing rejects malformed titles without silently dropping them or splitting phrases on spaces', () => {
  const result = parseBulkWords(`take care of;Template:head;https://example.com;<script>;bad\tword;${'a'.repeat(201)};...`);
  assert.deepEqual(result.words, ['take care of']);
  assert.deepEqual(result.invalid.map(item => item.reason), [
    'unsupported-character', 'unsupported-character', 'unsupported-character', 'control-character', 'too-long', 'not-a-word',
  ]);
  assert.deepEqual(parseBulkWords(' ,;\n '), { words: [], duplicates: [], overflow: [], invalid: [] });
  assert.throws(() => parseBulkWords(null), TypeError);
  for (const limit of [0, -1, 1.5, 51]) assert.throws(() => parseBulkWords('nice', { limit }), RangeError);
});

test('lookup concurrency is bounded at two and streaming records retain original input indices', async () => {
  const gates = new Map();
  const called = [];
  const delivered = [];
  let active = 0;
  let peak = 0;
  const run = runBulkLookup(['first', 'second', 'third', 'fourth'], {
    concurrency: 8,
    lookup: async word => {
      called.push(word);
      active += 1;
      peak = Math.max(peak, active);
      const gate = deferred();
      gates.set(word, gate);
      await gate.promise;
      active -= 1;
      return relations(word);
    },
    onResult: record => delivered.push(record),
  });
  assert.deepEqual(called, ['first', 'second']);
  gates.get('second').resolve();
  await tick();
  assert.deepEqual(called, ['first', 'second', 'third']);
  assert.equal(delivered[0].index, 1);
  gates.get('third').resolve();
  await tick();
  gates.get('fourth').resolve();
  gates.get('first').resolve();
  const result = await run;
  assert.equal(peak, 2);
  assert.deepEqual(result.results.map(item => item.word), ['first', 'second', 'third', 'fourth']);
  assert.deepEqual(result.pending, []);
  assert.equal(result.completed, 4);
  assert.equal(result.results[0].data.etymologies[0].id, 'sense-1');
  assert.equal(result.results[0].data.source.revisionId, 42);
});

test('ordinary failures and entries without explicit lexical relations do not stop the remaining words', async () => {
  const calls = [];
  const delivered = [];
  const result = await runBulkLookup(['missing', 'empty', 'nice'], {
    concurrency: 1,
    lookup: async word => {
      calls.push(word);
      if (word === 'missing') throw Object.assign(new Error('Not found'), { status: 404 });
      if (word === 'empty') return { word, etymologies: [{ partsOfSpeech: [{ relations: [{ kind: 'doublet', terms: ['other'] }] }] }] };
      return relations(word);
    },
    onResult: record => delivered.push(record.status),
  });
  assert.deepEqual(calls, ['missing', 'empty', 'nice']);
  assert.deepEqual(delivered, ['error', 'empty', 'success']);
  assert.equal(result.results[0].error.status, 404);
  assert.equal(result.results[1].data.word, 'empty');
  assert.equal(result.rateLimited, false);
});

test('rate limiting pauses unstarted work while retaining in-flight successes and retryable input order', async () => {
  for (const status of [429, 503]) {
    const called = [];
    const gate = deferred();
    const run = runBulkLookup(['blocked', 'inflight', 'pending', 'later'], {
      lookup: async word => {
        called.push(word);
        if (word === 'blocked') throw Object.assign(new Error('Wait'), { status, retryAfter: 61.2 });
        await gate.promise;
        return relations(word);
      },
    });
    await tick();
    assert.deepEqual(called, ['blocked', 'inflight']);
    gate.resolve();
    const result = await run;
    assert.equal(result.rateLimited, true);
    assert.equal(result.retryAfter, 62);
    assert.equal(result.results[1].status, 'success');
    assert.deepEqual(result.pending, ['pending', 'later']);
    assert.deepEqual(result.retryable, ['blocked', 'pending', 'later']);
  }
});

test('429 without Retry-After still pauses instead of repeatedly hitting the upstream', async () => {
  const calls = [];
  const result = await runBulkLookup(['one', 'two'], {
    concurrency: 1,
    lookup: async word => { calls.push(word); throw Object.assign(new Error('Slow down'), { status: 429 }); },
  });
  assert.deepEqual(calls, ['one']);
  assert.equal(result.rateLimited, true);
  assert.equal(result.retryAfter, null);
  assert.deepEqual(result.retryable, ['one', 'two']);
});

test('abort suppresses late results and progress and never starts pending requests', async () => {
  const controller = new AbortController();
  const calls = [];
  const delivered = [];
  const progress = [];
  const gate = deferred();
  const run = runBulkLookup(['one', 'two', 'three'], {
    signal: controller.signal,
    lookup: async word => { calls.push(word); await gate.promise; return relations(word); },
    onResult: record => delivered.push(record),
    onProgress: record => progress.push(record),
  });
  controller.abort();
  gate.resolve();
  const result = await run;
  assert.deepEqual(calls, ['one', 'two']);
  assert.deepEqual(delivered, []);
  assert.equal(progress.length, 1);
  assert.equal(result.completed, 0);
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.pending, ['one', 'two', 'three']);
});

test('a signal aborted before dispatch makes no lookup or UI callback', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const result = await runBulkLookup(['nice'], {
    signal: controller.signal, lookup: () => { calls += 1; }, onResult: () => { calls += 1; }, onProgress: () => { calls += 1; },
  });
  assert.equal(calls, 0);
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.pendingIndices, [0]);
});

test('invalid batch setup fails before dispatch, and empty input reports completion safely', async () => {
  for (const words of [['nice', 'NICE'], ['Template:head'], [null], Array(51).fill('word')]) {
    await assert.rejects(runBulkLookup(words, { lookup: async () => relations('nice') }), TypeError);
  }
  await assert.rejects(runBulkLookup(['nice'], { lookup: async () => {}, concurrency: 0 }), RangeError);
  const result = await runBulkLookup([], { lookup: async () => { throw new Error('Must not run'); } });
  assert.equal(result.completed, 0);
  assert.deepEqual(result.results, []);
});

test('consumer callback failures reject clearly and stop additional queue work', async () => {
  const calls = [];
  const failure = new Error('UI callback failed');
  await assert.rejects(runBulkLookup(['one', 'two', 'three'], {
    concurrency: 1, lookup: async word => { calls.push(word); return relations(word); },
    onResult: () => { throw failure; },
  }), error => error === failure);
  assert.deepEqual(calls, ['one']);
});

test('twenty words use four five-word calls while completed chunks stream before the rest', async () => {
  const words = Array.from({ length: 20 }, (_, index) => `word${index}`);
  const calls = [];
  const gates = [];
  const delivered = [];
  let active = 0;
  let peak = 0;
  const run = runBulkLookup(words, {
    concurrency: 10,
    lookupBatch: async chunk => {
      calls.push(chunk);
      active += 1; peak = Math.max(peak, active);
      const gate = deferred(); gates.push(gate);
      await gate.promise;
      active -= 1;
      return chunk.map(word => ({ word, data: relations(word) }));
    },
    onResult: record => delivered.push(record),
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], words.slice(0, 5));
  gates[0].resolve();
  await tick();
  assert.equal(delivered.length, 5);
  assert.deepEqual(delivered.map(record => record.index), [0, 1, 2, 3, 4]);
  assert.equal(calls.length, 3);
  gates[2].resolve();
  await tick();
  assert.equal(calls.length, 4);
  gates[3].resolve(); gates[1].resolve();
  const outcome = await run;
  assert.equal(peak, 2);
  assert.equal(calls.length, 4);
  assert.equal(outcome.completed, 20);
  assert.deepEqual(outcome.results.map(record => record.word), words);
  assert.deepEqual(outcome.pending, []);
});

test('batch responses map by exact requested word and preserve lemma, sense and per-item error data', async () => {
  const result = await runBulkLookup(['Nice', 'bank', 'walked', 'empty'], {
    batchSize: 4,
    lookupBatch: async () => [
      { word: 'walked', data: { ...relations('walk'), resolvedFrom: 'walked' } },
      { word: 'bank', error: { status: 404, title: 'No English entry', detail: 'missing' } },
      { word: 'unknown', data: relations('unknown') },
      { word: 'Nice', data: relations('Nice') },
      { word: 'empty', data: { word: 'empty', etymologies: [] } },
    ],
  });
  assert.deepEqual(result.results.map(record => record.status), ['success', 'error', 'success', 'empty']);
  assert.equal(result.results[0].word, 'Nice');
  assert.equal(result.results[1].error.message, 'No English entry');
  assert.equal(result.results[1].error.detail, 'missing');
  assert.equal(result.results[2].word, 'walked');
  assert.equal(result.results[2].data.word, 'walk');
  assert.equal(result.results[2].data.resolvedFrom, 'walked');
  assert.equal(result.results[2].data.etymologies[0].id, 'sense-1');
});

test('a limited item pauses new chunks while retaining successes in the already-fetched chunk', async () => {
  for (const status of [429, 503]) {
    const calls = [];
    const delivered = [];
    const result = await runBulkLookup(['nice', 'blocked', 'later', 'unstarted'], {
      concurrency: 1, batchSize: 3,
      lookupBatch: async chunk => {
        calls.push(chunk);
        return [
          { word: 'nice', data: relations('nice') },
          { word: 'blocked', error: { status, title: 'Wait', retryAfter: 30.2 } },
          { word: 'later', data: relations('later') },
        ];
      },
      onResult: record => delivered.push(record.word),
    });
    assert.deepEqual(calls, [['nice', 'blocked', 'later']]);
    assert.deepEqual(delivered, ['nice', 'blocked', 'later']);
    assert.equal(result.rateLimited, true);
    assert.equal(result.retryAfter, 31);
    assert.deepEqual(result.pending, ['unstarted']);
    assert.deepEqual(result.retryable, ['blocked', 'unstarted']);
  }
});

test('whole-batch failures retain item identities and only a rate-limited failure pauses later chunks', async () => {
  for (const status of [404, 503]) {
    const calls = [];
    const result = await runBulkLookup(['one', 'two', 'three', 'four'], {
      concurrency: 1, batchSize: 2,
      lookupBatch: async chunk => {
        calls.push(chunk);
        if (chunk[0] === 'one') throw { status, title: 'Unavailable batch', retryAfter: status === 503 ? 10 : null };
        return chunk.map(word => ({ word, data: relations(word) }));
      },
    });
    assert.deepEqual(result.results.slice(0, 2).map(record => [record.word, record.status, record.error.message]), [
      ['one', 'error', 'Unavailable batch'], ['two', 'error', 'Unavailable batch'],
    ]);
    assert.equal(result.rateLimited, status === 503);
    assert.equal(calls.length, status === 503 ? 1 : 2);
    assert.deepEqual(result.pending, status === 503 ? ['three', 'four'] : []);
  }
});

test('aborting active batch calls suppresses their items and never dispatches remaining chunks', async () => {
  const controller = new AbortController();
  const gate = deferred();
  const calls = [];
  const delivered = [];
  const progress = [];
  const run = runBulkLookup(['one', 'two', 'three', 'four', 'five', 'six'], {
    batchSize: 2, signal: controller.signal,
    lookupBatch: async chunk => { calls.push(chunk); await gate.promise; return chunk.map(word => ({ word, data: relations(word) })); },
    onResult: record => delivered.push(record), onProgress: record => progress.push(record),
  });
  controller.abort(); gate.resolve();
  const result = await run;
  assert.equal(calls.length, 2);
  assert.deepEqual(delivered, []);
  assert.equal(progress.length, 1);
  assert.equal(result.cancelled, true);
  assert.equal(result.completed, 0);
  assert.deepEqual(result.pending, ['one', 'two', 'three', 'four', 'five', 'six']);
});

test('malformed, duplicate and missing batch rows cannot be assigned to the wrong requested word', async () => {
  const result = await runBulkLookup(['Nice', 'duplicate', 'invalid', 'good'], {
    batchSize: 4,
    lookupBatch: async () => [
      { word: 'nice', data: relations('nice') }, // case is part of dictionary title identity
      { word: 'duplicate', data: relations('duplicate') }, { word: 'duplicate', data: relations('different') },
      { word: 'invalid', unexpected: true },
      { word: 'good', data: relations('good') }, null,
    ],
  });
  assert.deepEqual(result.results.map(record => record.status), ['error', 'error', 'error', 'success']);
  assert.equal(result.results[3].data.word, 'good');
  const invalidBatch = await runBulkLookup(['one', 'two'], { lookupBatch: async () => ({ wrong: true }) });
  assert.deepEqual(invalidBatch.results.map(record => record.status), ['error', 'error']);
});

test('batch setup validation and consumer failures stop before more chunks are dispatched', async () => {
  for (const batchSize of [0, -1, 1.5, 21]) {
    await assert.rejects(runBulkLookup(['nice'], { lookupBatch: async () => [], batchSize }), RangeError);
  }
  await assert.rejects(runBulkLookup(['nice'], { lookup: async () => {}, lookupBatch: true }), TypeError);
  const calls = [];
  const failure = new Error('Batch rendering failed');
  await assert.rejects(runBulkLookup(['one', 'two', 'three', 'four'], {
    concurrency: 1, batchSize: 2,
    lookupBatch: async chunk => { calls.push(chunk); return chunk.map(word => ({ word, data: relations(word) })); },
    onResult: () => { throw failure; },
  }), error => error === failure);
  assert.equal(calls.length, 1);
});
