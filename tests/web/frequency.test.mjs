import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRanks, loadFrequencyRanks } from '../../src/EtymoVocab.Web/wwwroot/frequency.js';
import { familyComparator } from '../../src/EtymoVocab.Web/wwwroot/map-related.js';

const text = readFileSync(new URL('../../src/EtymoVocab.Web/wwwroot/data/en-frequency.txt', import.meta.url), 'utf8');
const ranks = parseRanks(text);

test('the shipped frequency list is 50,000 distinct lowercase words, most frequent first', () => {
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.length, 50000);
  assert.equal(ranks.size, 50000);
  assert.equal(lines[0], 'the');
  assert.ok(lines.every(word => /^\p{Ll}[\p{Ll}'-]*$/u.test(word)), 'only lowercase words');
  assert.ok(ranks.get('transport') < ranks.get('transmit'));
});

test('trans- family: common words lead, unranked coinages follow (real category members)', () => {
  const members = ['transguy', 'transkid', 'transfur', 'transman', 'transbay', 'transmit', 'translate', 'transport',
    'transfer', 'transaction', 'trans-Atlantic'];
  const ordered = [...members].sort(familyComparator(ranks));
  assert.deepEqual(ordered.slice(0, 5), ['transfer', 'transport', 'transaction', 'translate', 'transmit']);
  assert.deepEqual(ordered.slice(5), ['transbay', 'transfur', 'transguy', 'transkid', 'transman', 'trans-Atlantic']);
});

test('*seh₂k- family: frequent words before rare ones, surnames last even when frequent as names', () => {
  const members = ['Sánchez', 'Santa Fe', 'Sancho', 'sacrifice', 'sanction', 'santo', 'sacro-', 'sacration', 'saint',
    'consecrate', 'sacrament'];
  const ordered = [...members].sort(familyComparator(ranks));
  assert.deepEqual(ordered.slice(0, 3), ['saint', 'sacrifice', 'sanction']);
  assert.deepEqual(ordered.slice(-3), ['Sancho', 'Sánchez', 'Santa Fe']);
});

test('without ranks the comparator still orders by form and length', () => {
  assert.deepEqual(['Sancho', 'sacrifice', 'santo', 'sacro-'].sort(familyComparator(null)), ['santo', 'sacrifice', 'sacro-', 'Sancho']);
});

test('loading caches success and allows a retry after a failure', async () => {
  let calls = 0;
  const failing = async () => { calls += 1; return { ok: false, status: 503 }; };
  await assert.rejects(loadFrequencyRanks(failing), /HTTP 503/);
  const working = async () => { calls += 1; return { ok: true, text: async () => 'the\nof\n' }; };
  const loaded = await loadFrequencyRanks(working);
  assert.equal(loaded.get('of'), 1);
  assert.equal(await loadFrequencyRanks(working), loaded);
  assert.equal(calls, 2);
});
