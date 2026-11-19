import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { originBucketKey, indexShard, usableOrigins, candidateWords, verifySharedOrigin, createReverseIndexClient } from '../../src/EtymoVocab.Web/wwwroot/reverse-index.js';

const anchor = (title, kind = 'ancestor', lang = 'la', id = null) => ({
  key: JSON.stringify([lang, title, id]), kind, lang, title, term: title, etymonId: id,
  url: `https://en.wiktionary.org/wiki/${encodeURIComponent(title)}#${lang}`,
  sourceUrl: `https://en.wiktionary.org/w/index.php?title=${encodeURIComponent(title)}&oldid=123`,
});
const etymology = (...originAnchors) => ({ uncertain: false, originAnchors });
const result = (word, ...etymologies) => ({
  word, lang: 'en', complete: true, etymologies,
  source: { url: `https://en.wiktionary.org/w/index.php?title=${word}&oldid=456`, revisionId: 456 },
});
const digest = bytes => createHash('sha256').update(Buffer.from(bytes)).digest();

function fixture(groups, { intercept, maxCachedShards = 24 } = {}) {
  const byShard = new Map();
  for (const [origin, words] of groups) {
    const key = originBucketKey(origin);
    const name = indexShard(key);
    if (!byShard.has(name)) byShard.set(name, {});
    byShard.get(name)[key] = words;
  }
  const files = new Map();
  const manifest = { schemaVersion: 1, buildId: 'fixture-build', source: { url: 'https://en.wiktionary.org/', license: 'CC BY-SA 4.0' }, shards: {} };
  for (const [name, origins] of byShard) {
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, origins }));
    const sha256 = digest(bytes).toString('hex');
    const file = `${name}-${sha256}.json`;
    files.set(file, bytes);
    manifest.shards[name] = { file, sha256 };
  }
  const calls = [];
  const fetcher = async url => {
    const file = new URL(url).pathname.split('/').pop();
    calls.push(file);
    const intercepted = await intercept?.({ file, manifest, files, calls });
    if (intercepted) return intercepted;
    return file === 'manifest.json' ? Response.json(manifest)
      : files.has(file) ? new Response(files.get(file)) : new Response('', { status: 404 });
  };
  return { client: createReverseIndexClient({ baseUrl: new URL('https://example.test/index/'), fetcher, digest, maxCachedShards }), calls, manifest, files };
}

test('origin buckets normalize canonical Unicode while preserving language, exact title case and punctuation', () => {
  assert.equal(originBucketKey(anchor('cafe\u0301', 'ancestor', 'fr')), '["fr","café"]');
  assert.notEqual(originBucketKey(anchor('Sugar')), originBucketKey(anchor('sugar')));
  assert.notEqual(originBucketKey(anchor('in', 'ancestor', 'en')), originBucketKey(anchor('in', 'ancestor', 'la')));
  assert.deepEqual(JSON.parse(originBucketKey(anchor('a "quote" \\ title'))), ['la', 'a "quote" \\ title']);
});

test('shard selection uses deterministic UTF-8 FNV-1a bytes, including reconstructed and Greek terms', () => {
  // Independently calculated byte vectors, not UTF-16 code units.
  for (const [key, shard] of [
    ['', 'c5'], ['hello', 'ab'],
    ['["ine-pro","Reconstruction:Proto-Indo-European/speḱ-"]', '02'],
    ['["grc","φωνή"]', '83'], ['["en","café"]', '54'],
  ]) assert.equal(indexShard(key), shard);
});

test('usable origins reject uncertain entries and generic affixes but retain specialized component identity', () => {
  const phone = anchor('-phone', 'component', 'en', 'sound');
  const generics = ['-s', '-ing', '-ness', 'un-', 're-', 'in-', 'com-', 'con-', 'ad-', '-us'].map(title => anchor(title, 'component', 'en'));
  const roots = usableOrigins(etymology(...generics, phone, { ...phone }, null, { ...phone, kind: 'synonym' }, { ...phone, url: null }));
  assert.deepEqual(roots, [phone]);
  assert.deepEqual(usableOrigins({ ...etymology(phone), uncertain: true }), []);
  assert.deepEqual(usableOrigins({}), []);
});

test('candidate discovery deduplicates and ranks direct sources, corroborating origins, and readable words', () => {
  const self = anchor('query', 'self', 'en');
  const donor = anchor('donor');
  const older = anchor('older');
  const root = anchor('*root-', 'root', 'ine-pro');
  const origins = {
    [originBucketKey(self)]: ['directlyderived', 'query'],
    [originBucketKey(donor)]: ['longcorroborated', 'a phrase', 'short', 'short', 'excluded', null, 42],
    [originBucketKey(older)]: ['longcorroborated'],
    [originBucketKey(root)]: ['tiny'],
  };
  const candidates = candidateWords([self, donor, older, root], origins, 'query', new Set(['excluded']));
  assert.deepEqual(candidates.map(item => item.word), ['directlyderived', 'longcorroborated', 'short', 'a phrase', 'tiny']);
  assert.equal(candidates[1].anchors.length, 2);
  assert.equal(candidates[2].anchors.length, 1);
  assert.deepEqual(candidateWords([self], {}, 'query'), []);
});

test('verification requires exact resolved identity rather than spelling or language alone', () => {
  const origin = anchor('bank', 'ancestor', 'en', 'finance');
  const query = etymology(origin);
  const matches = verifySharedOrigin(query, result('candidate', etymology({ ...origin })), 'query');
  assert.equal(matches?.verified, true);
  assert.equal(matches.component, false);
  assert.equal(matches.memberSource.revisionId, 456);
  assert.equal(verifySharedOrigin(query, result('candidate', etymology(anchor('bank', 'ancestor', 'en', 'river'))), 'query'), null);
  assert.equal(verifySharedOrigin(query, result('candidate', etymology({ ...origin, lang: 'la' })), 'query'), null);
  assert.equal(verifySharedOrigin(query, result('candidate', etymology({ ...origin, title: 'Bank' })), 'query'), null);
});

test('verification excludes partial, uncertain, self, foreign-language and sourceless results', () => {
  const origin = anchor('donor');
  const query = etymology(origin);
  const candidate = result('candidate', etymology(origin));
  for (const invalid of [
    { ...candidate, complete: false }, { ...candidate, complete: undefined },
    { ...candidate, lang: 'fr' }, { ...candidate, source: null },
    { ...candidate, word: 'query' },
    result('candidate', { ...etymology(origin), uncertain: true }),
  ]) assert.equal(verifySharedOrigin(query, invalid, 'query'), null);
  assert.equal(verifySharedOrigin({ ...query, uncertain: true }, candidate, 'query'), null);
});

test('shared components have distinct meaning and preserve the matching candidate etymology id', () => {
  const phone = anchor('-phone', 'component', 'en', 'sound');
  const candidate = result('microphone',
    { ...etymology(anchor('-phone', 'component', 'en', 'unrelated')), id: 'wrong' },
    { ...etymology(phone), id: 'instrument' });
  const verified = verifySharedOrigin(etymology(phone), candidate, 'telephone');
  assert.equal(verified.component, true);
  assert.equal(verified.etymonId, 'instrument');
  assert.equal(verified.anchor.key, phone.key);
  assert.equal(verifySharedOrigin(etymology(anchor('-ing', 'component', 'en')), result('other', etymology(anchor('-ing', 'component', 'en'))), 'query'), null);
});

test('uncertain older history keeps a word identity but never grants its speculative origins', () => {
  const self = anchor('panis', 'self', 'la', 'bread');
  const older = anchor('*uncertain-', 'ancestor', 'ine-pro');
  assert.deepEqual(usableOrigins({ ...etymology(self, older), uncertain: true }), [self]);
  const englishSelf = anchor('source', 'self', 'en', 'one');
  const uncertain = { ...etymology(englishSelf, older), uncertain: true };
  assert.ok(verifySharedOrigin(etymology({ ...englishSelf, kind: 'component' }), result('source', uncertain), 'derived'));
  assert.equal(verifySharedOrigin(etymology(older), result('source', uncertain), 'derived'), null);
});

test('a closer shared ancestor wins over a broader root match', () => {
  const donor = anchor('donor');
  const root = anchor('*root-', 'root', 'ine-pro');
  const verified = verifySharedOrigin(etymology(root, donor), result('candidate', etymology(root, donor)), 'query');
  assert.equal(verified.anchor.key, donor.key);
});

test('index loading is lazy, deduplicates concurrent requests, and reuses verified shards', async () => {
  const origin = anchor('donor');
  const other = anchor('unused');
  const { client, calls, manifest } = fixture([[origin, ['candidate']], [other, ['unrequested']]]);
  assert.deepEqual(await client.discover(etymology(), 'query'), { candidates: [], manifest: null });
  assert.deepEqual(calls, []);
  const [first, second] = await Promise.all([client.discover(etymology(origin), 'query'), client.discover(etymology(origin), 'query')]);
  assert.deepEqual(first.candidates.map(item => item.word), ['candidate']);
  assert.deepEqual(second.candidates, first.candidates);
  assert.deepEqual(calls, ['manifest.json', manifest.shards[indexShard(originBucketKey(origin))].file]);
  await client.discover(etymology(origin), 'query');
  assert.equal(calls.length, 2);
});

test('different senses share a coarse discovery shard but still require separate live verification', async () => {
  const into = anchor('bank', 'ancestor', 'en', 'finance');
  const not = anchor('bank', 'ancestor', 'en', 'river');
  const { client, calls } = fixture([[into, ['candidate']]]);
  assert.equal((await client.discover(etymology(into), 'query')).candidates.length, 1);
  assert.equal((await client.discover(etymology(not), 'query')).candidates.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(verifySharedOrigin(etymology(into), result('candidate', etymology(not)), 'query'), null);
});

test('redirect titles discover candidates in the snapshot while verification uses the resolved origin', async () => {
  const canonical = { ...anchor('newtitle'), lookupAliases: ['oldtitle'] };
  const alias = anchor('oldtitle');
  const { client } = fixture([[canonical, ['common']], [alias, ['common', 'from-alias']]]);
  const query = etymology(canonical);
  const { candidates } = await client.discover(query, 'query');
  assert.deepEqual(candidates.map(item => item.word), ['common', 'from-alias']);
  assert.deepEqual(candidates[1].anchors, [canonical]);
  assert.ok(verifySharedOrigin(query, result('from-alias', etymology(anchor('newtitle'))), 'query'));
  assert.equal(verifySharedOrigin(query, result('from-alias', etymology(alias)), 'query'), null);
});

test('failed manifest and shard requests can be retried without becoming successful cache hits', async () => {
  const origin = anchor('donor');
  let manifestFailures = 1;
  let shardFailures = 1;
  const { client, calls } = fixture([[origin, ['candidate']]], { intercept: ({ file }) => {
    if (file === 'manifest.json' && manifestFailures-- > 0) return new Response('', { status: 503 });
    if (file !== 'manifest.json' && shardFailures-- > 0) return new Response('', { status: 503 });
  } });
  await assert.rejects(client.discover(etymology(origin), 'query'), /索引/);
  await assert.rejects(client.discover(etymology(origin), 'query'), /索引/);
  assert.deepEqual((await client.discover(etymology(origin), 'query')).candidates.map(item => item.word), ['candidate']);
  assert.equal(calls.filter(file => file === 'manifest.json').length, 2);
  assert.equal(calls.filter(file => file !== 'manifest.json').length, 2);
});

test('digest mismatches are refused before data is returned and a later corrected response can recover', async () => {
  const origin = anchor('donor');
  let corrupt = true;
  const { client, calls } = fixture([[origin, ['candidate']]], { intercept: ({ file }) => {
    if (file !== 'manifest.json' && corrupt) {
      corrupt = false;
      return Response.json({ schemaVersion: 1, origins: { [originBucketKey(origin)]: ['forged'] } });
    }
  } });
  await assert.rejects(client.discover(etymology(origin), 'query'), /正在更新/);
  assert.deepEqual((await client.discover(etymology(origin), 'query')).candidates.map(item => item.word), ['candidate']);
  assert.equal(calls.length, 3);
});

test('manifest versions and unsafe shard paths are refused without fetching the named shard', async () => {
  const origin = anchor('donor');
  for (const mutate of [
    manifest => { manifest.schemaVersion = 2; },
    manifest => { manifest.shards[indexShard(originBucketKey(origin))].file = '../../outside.json'; },
    manifest => { manifest.shards[indexShard(originBucketKey(origin))].sha256 = 'bad-hash'; },
  ]) {
    const { client, manifest, calls } = fixture([[origin, ['candidate']]]);
    mutate(manifest);
    await assert.rejects(client.discover(etymology(origin), 'query'), /索引/);
    assert.deepEqual(calls, ['manifest.json']);
  }
});

test('missing buckets are legitimate coverage gaps and bounded caching refetches evicted shards', async () => {
  const one = anchor('donor');
  const two = anchor('different');
  const missing = anchor('not-indexed');
  assert.notEqual(indexShard(originBucketKey(one)), indexShard(originBucketKey(two)));
  const { client, calls } = fixture([[one, ['first']], [two, ['second']]], { maxCachedShards: 1 });
  assert.deepEqual((await client.discover(etymology(missing), 'query')).candidates, []);
  await client.discover(etymology(one), 'query');
  await client.discover(etymology(two), 'query');
  await client.discover(etymology(one), 'query');
  assert.equal(calls.length, 4);
});

test('invalid cache limits are rejected before any eviction or network work', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, '2']) {
    assert.throws(() => createReverseIndexClient({ maxCachedShards: value }), /positive shard cache/);
  }
});

test('an evicted in-flight failure cannot delete a newer successful request for the same shard', async () => {
  const one = anchor('donor');
  const two = anchor('different');
  const firstName = indexShard(originBucketKey(one));
  let started;
  const firstStarted = new Promise(resolve => { started = resolve; });
  let rejectFirst;
  let firstRequest = true;
  const { client, calls } = fixture([[one, ['first']], [two, ['second']]], {
    maxCachedShards: 1,
    intercept: ({ file }) => {
      if (file.startsWith(firstName + '-') && firstRequest) {
        firstRequest = false;
        started();
        return new Promise((_, reject) => { rejectFirst = reject; });
      }
    },
  });
  const initial = client.discover(etymology(one), 'query');
  const rejected = assert.rejects(initial, /first request failed/);
  await firstStarted;
  await client.discover(etymology(two), 'query');
  await client.discover(etymology(one), 'query');
  rejectFirst(new Error('first request failed'));
  await rejected;
  assert.deepEqual((await client.discover(etymology(one), 'query')).candidates.map(item => item.word), ['first']);
  assert.equal(calls.filter(file => file.startsWith(firstName + '-')).length, 2);
});
