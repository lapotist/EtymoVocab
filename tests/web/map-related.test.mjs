import { test } from 'node:test';
import assert from 'node:assert/strict';
import { etymologicalGroups, addEtymologicalWord } from '../../src/EtymoVocab.Web/wwwroot/map-related.js';

const hostel = { lang: 'en', term: 'hostel', url: 'https://en.wiktionary.org/wiki/hostel#English' };
const hospital = { lang: 'en', term: 'hospital', url: 'https://en.wiktionary.org/wiki/hospital#English' };
// These are the two doublets explicitly recorded in the real hotel fixture.
const entry = {
  doublets: [hostel, hospital],
  partsOfSpeech: [{ pos: 'Noun', relations: [
    { kind: 'synonym', sense: 'lodging', terms: ['inn', 'hostel'] },
    { kind: 'antonym', sense: 'lodging', terms: ['outdoors'] },
  ] }],
};

test('only explicit etymological words become candidates, even when semantic relations exist', () => {
  const groups = etymologicalGroups(entry, 'hotel');
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, 'doublet');
  assert.deepEqual(groups[0].terms, [hostel, hospital]);
  assert.equal(groups[0].terms.some(item => item.term === 'inn' || item.term === 'outdoors'), false);
});

test('shared-origin branches preserve ancestry and support expanding the related word itself', () => {
  const ancestor = { key: 'la:hospitalis', kind: 'step', children: [] };
  const tree = { key: 'en:hotel', children: [ancestor] };
  const group = etymologicalGroups(entry, 'hotel')[0];
  const node = addEtymologicalWord(tree, group, hospital);
  assert.equal(tree.children[0], ancestor);
  assert.equal(tree.children[1].sharedOrigin, true);
  assert.match(tree.children[1].label, /共同來源，非直接演變/);
  assert.equal(tree.children[1].children[0], node);
  assert.equal(node.kind, 'doublet');
  assert.equal(node.sharedOrigin, true);
  assert.deepEqual(node.lookup, { lang: 'en', term: 'hospital', id: null });
  assert.equal(node.url, hospital.url);
  assert.equal(node.maskable, false);
});

test('semantic or unlisted words cannot be inserted by the map helper', () => {
  const tree = { children: [] };
  const group = etymologicalGroups(entry, 'hotel')[0];
  assert.equal(addEtymologicalWord(tree, { ...group, kind: 'synonym' }, hostel), null);
  assert.equal(addEtymologicalWord(tree, { ...group, kind: 'antonym' }, hostel), null);
  assert.equal(addEtymologicalWord(tree, group, { lang: 'en', term: 'inn' }), null);
  assert.equal(addEtymologicalWord(tree, group, { lang: 'fr', term: 'hostel' }), null);
  assert.equal(tree.children.length, 0);
  assert.ok(addEtymologicalWord(tree, group, hostel));
  assert.equal(addEtymologicalWord(tree, group, hostel), null);
  assert.equal(tree.children[0].children.length, 1);
});

test('doublets deduplicate by language and term while excluding the queried entry itself', () => {
  const groups = etymologicalGroups({ doublets: [
    hostel, { ...hostel }, hospital, { lang: 'en', term: 'hotel' }, { lang: 'fr', term: 'hotel', url: null }, null,
  ] }, 'hotel');
  assert.deepEqual(groups[0].terms.map(item => [item.lang, item.term]), [['en', 'hostel'], ['en', 'hospital'], ['fr', 'hotel']]);
  const tree = { children: [] };
  const english = addEtymologicalWord(tree, groups[0], hostel);
  const french = addEtymologicalWord(tree, groups[0], { lang: 'fr', term: 'hotel' });
  assert.notEqual(english.key, french.key);
  assert.equal(french.lookup.lang, 'fr');
});

test('missing etymological evidence never falls back to synonyms or other senses', () => {
  assert.deepEqual(etymologicalGroups({ partsOfSpeech: entry.partsOfSpeech }, 'hotel'), []);
  const finance = etymologicalGroups({ doublets: [{ lang: 'en', term: 'bench' }] }, 'bank');
  const river = etymologicalGroups({ doublets: [] }, 'bank');
  assert.equal(finance[0].terms[0].term, 'bench');
  assert.deepEqual(river, []);
});
