import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  etymologicalGroups, addEtymologicalWord, attachEtymologicalWords, addVerifiedOrigin,
  familySource, familyHref, familyOrder,
} from '../../src/EtymoVocab.Web/wwwroot/map-related.js';

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

test('family sources are reconstructed roots and English prefixes, never suffixes or reconstructed words', () => {
  // sacred: the chain ends in PIE *seh₂k-, which Wiktionary groups into an English root category.
  assert.deepEqual(familySource({ lang: 'ine-pro', term: '*seh₂k-' }), { kind: 'root', lang: 'ine-pro', term: '*seh₂k-', id: null });
  assert.deepEqual(familySource({ lang: 'ine-pro', term: '*per-', id: 'fare' }).id, 'fare');
  // transport: the English breakdown trans- + port.
  assert.deepEqual(familySource({ lang: 'en', term: 'trans-', id: 'across, beyond' }),
    { kind: 'prefix', lang: 'en', term: 'trans-', id: 'across, beyond' });
  for (const notAFamily of [
    { lang: 'ine-pro', term: '*-tḗr' },     // reconstructed suffix
    { lang: 'gem-pro', term: '*fadēr' },    // reconstructed word
    { lang: 'ine-pro', term: '*sh₂krós' },  // reconstructed word
    { lang: 'en', term: '-ed' },            // suffix
    { lang: 'en', term: 'port' },           // base
    { lang: 'la', term: 'trāns-' },         // Latin prefix: no English category
    { lang: 'la', term: 'sacer' },
  ]) assert.equal(familySource(notAFamily), null, JSON.stringify(notAFamily));
});

test('family routes carry the prefix kind and sense id only when needed', () => {
  assert.equal(familyHref({ kind: 'root', lang: 'ine-pro', term: '*seh₂k-', id: null }), '#/root/ine-pro/*seh%E2%82%82k-');
  assert.equal(familyHref({ kind: 'root', lang: 'ine-pro', term: '*per-', id: 'fare' }), '#/root/ine-pro/*per-?id=fare');
  assert.equal(familyHref({ kind: 'prefix', lang: 'en', term: 'trans-', id: 'across, beyond' }),
    '#/root/en/trans-?kind=prefix&id=across%2C+beyond');
});

test('family order puts plain words before names and phrases (real *seh₂k- members)', () => {
  const members = ['Sánchez', 'Santa Fe', 'Sancho', 'sacrifice', 'sanction', 'santo', 'sacro-', 'sacration'];
  assert.deepEqual([...members].sort(familyOrder),
    ['santo', 'sanction', 'sacration', 'sacrifice', 'sacro-', 'Sancho', 'Sánchez', 'Santa Fe']);
});

test('dedicated derived and related sections retain evidence and reject semantic kinds', () => {
  const sourceUrl = 'https://en.wiktionary.org/w/index.php?title=predict&oldid=93715976#English';
  const groups = etymologicalGroups({ etymologicalRelations: [
    { kind: 'related', lang: 'en', term: 'prediction', sourceUrl, sourceSection: 'Related terms' },
    { kind: 'derived', lang: 'en', term: 'predictably', sourceUrl, sourceSection: 'Derived terms' },
    { kind: 'synonym', lang: 'en', term: 'foretell' },
    { kind: 'antonym', lang: 'en', term: 'ignore' },
  ] }, 'predict');
  assert.deepEqual(groups.map(group => group.kind), ['related', 'derived']);
  const tree = { key: 'en:predict', children: [] };
  const node = addEtymologicalWord(tree, groups[0], groups[0].terms[0]);
  assert.equal(node.relationSource, sourceUrl);
  assert.equal(node.kind, 'related');
  assert.equal(node.lookup.term, 'prediction');
});

test('initial display keeps all candidates available and expanded component groups stay distinct', () => {
  const etymologicalRelations = Array.from({ length: 12 }, (_, i) => ({ kind: 'derived', lang: 'en', term: `relative${i}` }));
  const parent = { key: 'en:word', term: 'word', lang: 'en', children: [] };
  const component = { key: 'en:component', term: 'component', lang: 'en', children: [] };
  assert.equal(attachEtymologicalWords(parent, { etymologicalRelations }), 8);
  assert.equal(attachEtymologicalWords(component, { etymologicalRelations }), 8);
  assert.equal(parent.etymologicalGroups[0].terms.length, 12);
  assert.notEqual(parent.etymologicalGroups[0].key, component.etymologicalGroups[0].key);
  assert.notEqual(parent.children[0].children[0].key, component.children[0].children[0].key);
  assert.equal(addEtymologicalWord(parent, parent.etymologicalGroups[0], etymologicalRelations[11]).term, 'relative11');
  assert.equal(attachEtymologicalWords(parent, { etymologicalRelations }), 0);
  assert.equal(parent.children[0].children.length, 9);
});

test('index candidates never enter the map until verified; shared components retain two evidence links', () => {
  const tree = { key: 'en:telephone', children: [] };
  const anchor = { key: '["en","-phone",null]', term: '-phone', url: 'https://en.wiktionary.org/wiki/-phone#English' };
  const match = { term: 'microphone', lang: 'en', component: true, anchor, candidateAnchor: anchor,
    memberSource: { url: 'https://en.wiktionary.org/w/index.php?title=microphone&oldid=123#English' } };
  assert.equal(addVerifiedOrigin(tree, match), null);
  assert.equal(addVerifiedOrigin(tree, { ...match, verified: true, candidateAnchor: { key: 'different-sense' } }), null);
  const node = addVerifiedOrigin(tree, { ...match, verified: true });
  assert.equal(node.kind, 'verified-origin');
  assert.equal(node.relationSource, match.memberSource.url);
  assert.equal(node.originSource, anchor.url);
  assert.equal(tree.children[0].label, '共用構詞成分');
  assert.equal(tree.children[0].verifiedAnchor, anchor);
  assert.equal(node.verifiedAnchor, anchor);
  assert.equal(addVerifiedOrigin(tree, { ...match, verified: true }), null);
});
