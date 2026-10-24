import test from 'node:test';
import assert from 'node:assert/strict';
import { createLookupCache } from '../../src/EtymoVocab.Web/wwwroot/lookup-cache.js';

const result = (word = 'nice', complete = true) => ({ word, complete, etymologies: [{ partsOfSpeech: [{ senses: ['pleasant'] }] }] });

test('a complete parsed result avoids repeated loader work and shares concurrent lookups', async () => {
  const cache = createLookupCache();
  let calls = 0;
  const loader = async () => { calls += 1; return result(); };
  const [first, second] = await Promise.all([cache.load('related:nice', loader), cache.load('related:nice', loader)]);
  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.equal(await cache.load('related:nice', loader), first);
  assert.equal(calls, 1);
});

test('cache lifetime expires without being extended by reads', async () => {
  let time = 1000;
  let calls = 0;
  const cache = createLookupCache({ ttlMs: 100, now: () => time });
  const loader = async () => { calls += 1; return result(); };
  await cache.load('related:nice', loader);
  time = 1099;
  await cache.load('related:nice', loader);
  assert.equal(calls, 1);
  time = 1100;
  await cache.load('related:nice', loader);
  assert.equal(calls, 2);
});

test('bounded entries evict the least recently used result', () => {
  const cache = createLookupCache({ maxEntries: 2 });
  cache.set('a', result('a'));
  cache.set('b', result('b'));
  cache.get('a');
  cache.set('c', result('c'));
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a').word, 'a');
  assert.equal(cache.get('c').word, 'c');
});

test('partial results and failures never turn into warm successful lookups', async () => {
  const cache = createLookupCache();
  let calls = 0;
  const loader = async () => { calls += 1; return result('nice', false); };
  await cache.load('related:nice', loader);
  await cache.load('related:nice', loader);
  assert.equal(calls, 2);
  await assert.rejects(cache.load('related:nice', () => Promise.reject(new Error('offline'))), /offline/);
  assert.equal((await cache.load('related:nice', () => result())).complete, true);
});

test('operation, exact title case, language and etymon remain separate keys', async () => {
  const cache = createLookupCache();
  const keys = [JSON.stringify(['related', 'Sugar']), JSON.stringify(['related', 'sugar']), JSON.stringify(['word', 'sugar']),
    JSON.stringify(['entry', 'en', 'in-', 'not']), JSON.stringify(['entry', 'en', 'in-', 'into']), JSON.stringify(['entry', 'la', 'in-', 'into'])];
  let calls = 0;
  for (const key of keys) await cache.load(key, () => { calls += 1; return result(key); });
  for (const key of keys) assert.equal(cache.get(key).word, key);
  assert.equal(calls, keys.length);
});

test('cached snapshots cannot be mutated through consumers or loader references', async () => {
  const cache = createLookupCache();
  const raw = result();
  const cached = await cache.load('nice', () => raw);
  raw.etymologies[0].partsOfSpeech[0].senses[0] = 'changed';
  assert.equal(cached.etymologies[0].partsOfSpeech[0].senses[0], 'pleasant');
  assert.throws(() => { cached.etymologies[0].partsOfSpeech.push({}); }, TypeError);
});

test('a batch can seed the same parsed cache used by a later single-word lookup', async () => {
  const cache = createLookupCache();
  const key = JSON.stringify(['related', 'nice']);
  cache.set(key, result());
  let called = false;
  const cached = await cache.load(key, () => { called = true; return result('unexpected'); });
  assert.equal(cached.word, 'nice');
  assert.equal(called, false);
});
