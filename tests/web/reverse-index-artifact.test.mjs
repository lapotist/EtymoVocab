import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { indexShard, originBucketKey } from '../../src/EtymoVocab.Web/wwwroot/reverse-index.js';

const base = new URL('../../src/EtymoVocab.Web/wwwroot/data/etymology-index/', import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('packaged reverse index has intact shards, compatible keys, accurate counts and attributable source data', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', base), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.buildId, /^[a-f0-9]{64}$/);
  assert.match(manifest.source.inputSha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.source.url, /^https:\/\//);
  assert.match(manifest.source.dumpDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(manifest.source.extractedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(manifest.source.license, 'CC BY-SA 4.0');
  assert.ok(manifest.source.attribution.includes('Wiktionary'));
  assert.ok(manifest.source.licenseUrl);
  assert.ok(manifest.coverage.includes('verification'));
  assert.equal(Object.keys(manifest.shards).length, 256);
  assert.ok(manifest.statistics.recordsRead >= manifest.entryCount);

  const uniqueWords = new Set();
  let origins = 0;
  let edges = 0;
  const examples = new Map();
  const wanted = new Set([
    originBucketKey({ lang: 'en', title: '-phone' }),
    originBucketKey({ lang: 'en', title: 'hap' }),
    originBucketKey({ lang: 'la', title: 'panis' }),
  ]);
  // Read sequentially to keep peak memory bounded while checking every packaged byte.
  for (let index = 0; index < 256; index++) {
    const bucket = index.toString(16).padStart(2, '0');
    const metadata = manifest.shards[bucket];
    assert.ok(metadata, `Missing bucket ${bucket}`);
    assert.equal(metadata.file, `${bucket}-${metadata.sha256}.json`);
    assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
    const bytes = await readFile(new URL(metadata.file, base));
    assert.equal(bytes.length, metadata.bytes);
    assert.equal(sha256(bytes), metadata.sha256, `Corrupt shard ${bucket}`);
    const shard = JSON.parse(bytes);
    assert.equal(shard.schemaVersion, 1);
    for (const [key, words] of Object.entries(shard.origins)) {
      assert.equal(indexShard(key), bucket, `Builder/browser hash mismatch for ${key}`);
      const [lang, title] = JSON.parse(key);
      assert.equal(originBucketKey({ lang, title }), key);
      assert.ok(lang && title && Array.isArray(words) && words.length > 0);
      assert.equal(new Set(words).size, words.length, `Duplicate candidate in ${key}`);
      for (const word of words) {
        assert.equal(typeof word, 'string');
        assert.equal(word.normalize('NFC'), word);
        uniqueWords.add(word);
      }
      origins++;
      edges += words.length;
      if (wanted.has(key)) examples.set(key, words);
    }
  }
  assert.equal(origins, manifest.originCount);
  assert.equal(edges, manifest.edgeCount);
  assert.equal(uniqueWords.size, manifest.entryCount);
  assert.ok(examples.get('["en","-phone"]').includes('microphone'));
  assert.ok(examples.get('["en","hap"]').includes('hapless'));
  assert.ok(examples.get('["la","panis"]').includes('companion'));
  assert.ok(examples.get('["la","panis"]').includes('pantry'));
  // JavaScript normally moves integer-looking keys ("10"..."99") ahead of "00"; the builder
  // writes every two-digit bucket in ordinal order, so serialize that dictionary explicitly.
  const orderedShards = '{' + Object.keys(manifest.shards).sort().map(key =>
    JSON.stringify(key) + ':' + JSON.stringify(manifest.shards[key])).join(',') + '}';
  const identity = '{"schemaVersion":' + manifest.schemaVersion + ',"source":' + JSON.stringify(manifest.source)
    + ',"statistics":' + JSON.stringify(manifest.statistics) + ',"shards":' + orderedShards + '}';
  assert.equal(sha256(identity), manifest.buildId);
});
