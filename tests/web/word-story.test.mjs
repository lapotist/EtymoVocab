import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildWordStory, feelLines, sameMeaning, shortGloss, splitLabels } from '../../src/EtymoVocab.Web/wwwroot/word-story.js';

// Real engine results captured from live Wiktionary lookups (see fixtures/story/README.md).
const fixture = (word) => JSON.parse(readFileSync(new URL(`./fixtures/story/${word}.json`, import.meta.url), 'utf8'));
const storyOf = (word) => {
  const result = fixture(word);
  return buildWordStory(result, result.etymologies[0]);
};

test('nice: the answer leads with the meaning shift and keeps only changed meanings in the path', () => {
  const story = storyOf('nice');
  assert.match(story.headline, /最早記錄的意思是「ignorant, not knowing」（拉丁語 nescius），今天是「Pleasant/);
  assert.deepEqual(story.literal.parts, [{ term: 'ne', gloss: 'not' }, { term: 'sciō', gloss: 'to know' }]);
  assert.deepEqual(story.path.map(p => [p.kind, p.term]), [['ancestor', 'nescius'], ['ancestor', 'nyce'], ['today', 'nice']]);
  // The obsolete sense "Silly, ignorant; foolish" repeats Middle English nyce, so it is not shown again.
  assert.ok(!story.path.some(p => p.kind === 'older'));
  assert.deepEqual(story.path.at(-1).zh, ['美好']);
  const feel = feelLines(story);
  assert.match(feel[0], /chiefly informal/);
  assert.match(feel[1], /中古英語時期.*經古法語 nice 進入英語/);
});

test('father: identical ancestor meanings collapse into one stable origin', () => {
  const story = storyOf('father');
  assert.equal(story.stable, true);
  assert.equal(story.headline, 'father 的意思一路相近：最早可追溯到原始印歐語 *ph₂tḗr「father」。');
  assert.deepEqual(story.path.map(p => p.kind), ['ancestor', 'today']);
  assert.match(feelLines(story)[0], /^英語本土字，古英語時期/);
  assert.equal(story.literal.via.term, '*ph₂tḗr');
});

test('inspect: a direct Latin borrowing gets the literal parts and a labelled tendency', () => {
  const story = storyOf('inspect');
  assert.deepEqual(story.literal.parts.map(p => p.term), ['in', 'specio']);
  assert.deepEqual(story.path.map(p => p.term), ['inspicere', 'inspect']);
  assert.match(feelLines(story).join(''), /直接借自拉丁語 inspectum。.*（一般傾向）/);
});

test('transport: synonymous glosses are one meaning, and historical senses never enter the path', () => {
  const story = storyOf('transport');
  assert.equal(story.stable, true);
  assert.match(story.headline, /一路相近：最早可追溯到拉丁語 trānsportāre「to carry over」/);
  assert.ok(!story.path.some(p => /penal colony/.test(p.gloss)));
});

test('hotel: long chains keep the origin and the two latest changes; today skips the historical sense', () => {
  const story = storyOf('hotel');
  assert.deepEqual(story.path.map(p => p.term), ['hospitālis', 'ostel', 'hôtel', 'hotel']);
  assert.match(story.path.at(-1).gloss, /^An establishment that provides accommodation/);
});

test('an etymology without usable data is reported as empty instead of inventing a story', () => {
  const story = buildWordStory({ word: 'xyz' }, { steps: [], morphology: [], roots: [], partsOfSpeech: [] });
  assert.equal(story.empty, true);
  assert.equal(story.headline, null);
});

test('gloss helpers: labels split off, long glosses cut at clause boundaries, polarity respected', () => {
  assert.deepEqual(splitLabels('(chiefly informal) Pleasant.'), { labels: ['chiefly informal'], text: 'Pleasant.' });
  assert.equal(shortGloss('(OL., rare) to observe, watch, look at'), 'to observe, watch, look at');
  assert.equal(shortGloss('To examine critically or carefully; especially, to search out problems or determine condition'),
    'To examine critically or carefully');
  assert.equal(shortGloss('A father (male direct ancestor of someone or some creature)', 44), 'A father');
  assert.equal(sameMeaning('carry or convey across', 'to carry over'), true);
  assert.equal(sameMeaning('not knowing', 'knowing'), false);
  assert.equal(sameMeaning('ignorant, not knowing', 'foolish, simple, ignorant, naive'), false);
});
