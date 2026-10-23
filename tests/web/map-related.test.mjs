import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relatedGroups, addRelatedWord } from '../../src/EtymoVocab.Web/wwwroot/map-related.js';

const entry = { partsOfSpeech: [
  { pos: 'Verb', relations: [
    { kind: 'synonym', sense: 'examine', terms: ['inspect', 'examine', 'examine'] },
    { kind: 'antonym', sense: 'examine', terms: ['ignore'] },
  ] },
  { pos: 'Noun', relations: [{ kind: 'synonym', sense: 'examination', terms: ['examine'] }] },
] };

test('word choices retain relation, sense and part of speech, excluding self and duplicates', () => {
  const groups = relatedGroups(entry, 'inspect');
  assert.deepEqual(groups.map(group => [group.kind, group.pos, group.sense, group.terms]), [
    ['synonym', 'Verb', 'examine', ['examine']],
    ['antonym', 'Verb', 'examine', ['ignore']],
    ['synonym', 'Noun', 'examination', ['examine']],
  ]);
  assert.equal(new Set(groups.map(group => group.key)).size, 3);
});

test('adding a related word preserves the ancestry and adds a distinct expandable meaning branch', () => {
  const ancestor = { key: 'la:inspicio', kind: 'step', children: [] };
  const tree = { key: 'en:inspect', children: [ancestor] };
  const group = relatedGroups(entry, 'inspect')[0];
  const node = addRelatedWord(tree, group, 'examine');
  assert.equal(tree.children[0], ancestor);
  assert.equal(tree.children[1].relatedRelation, 'synonym');
  assert.equal(tree.children[1].children[0], node);
  assert.deepEqual(node.lookup, { lang: 'en', term: 'examine', id: null });
  assert.equal(node.maskable, false);
  assert.equal(addRelatedWord(tree, group, 'examine'), null);
  assert.equal(tree.children[1].children.length, 1);
  assert.equal(addRelatedWord(tree, group, 'invented'), null);
});

test('the same spelling in different senses remains separately labeled', () => {
  const tree = { children: [] };
  const groups = relatedGroups(entry, 'inspect');
  const verb = addRelatedWord(tree, groups[0], 'examine');
  const noun = addRelatedWord(tree, groups[2], 'examine');
  assert.notEqual(verb.key, noun.key);
  assert.equal(tree.children.length, 2);
  assert.match(tree.children[0].label, /Verb/);
  assert.match(tree.children[1].label, /Noun/);
});

test('entries without lexical relations have no invented word choices', () => {
  assert.deepEqual(relatedGroups({ partsOfSpeech: [{ pos: 'Verb' }] }, 'inspect'), []);
});
