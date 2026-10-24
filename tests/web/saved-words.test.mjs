import test from 'node:test';
import assert from 'node:assert/strict';
import { createSavedWordsStore, normalizeSavedWord, SAVED_WORDS_STORAGE_KEY } from '../../src/EtymoVocab.Web/wwwroot/saved-words.js';

const START = 1_700_000_000_000;
function memoryStorage(initial = null) {
  const values = new Map(initial == null ? [] : [[SAVED_WORDS_STORAGE_KEY, initial]]);
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
}
function setup(storage = memoryStorage()) {
  let timestamp = START;
  const store = createSavedWordsStore({ storage, now: () => timestamp });
  return { store, storage, setTime: value => { timestamp = value; } };
}
const source = {
  query: 'Nice', sourceWord: 'nice', relation: 'synonym', pos: 'Adjective', sense: 'pleasant',
  etymologyId: 'pleasant', sourceUrl: 'https://en.wiktionary.org/w/index.php?title=nice&oldid=93745522',
};

test('word identity normalizes case, canonical Unicode and whitespace while preserving first spelling', () => {
  const { store, setTime } = setup();
  assert.deepEqual(normalizeSavedWord('  Café   au lait '), { word: 'Café au lait', key: 'café au lait' });
  const first = store.save('  Café   au lait ');
  setTime(START + 5000);
  const again = store.save('CAFE\u0301 au LAIT');
  assert.equal(again.word, first.word);
  assert.equal(again.savedAt, START);
  assert.equal(store.has(' café AU lait '), true);
  assert.equal(store.list().length, 1);
});

test('invalid words and invalid provenance cannot mutate the collection', () => {
  const { store } = setup();
  for (const word of [null, 4, '', '  ', 'a'.repeat(201), 'nice\nkind', 'word\u0000']) {
    assert.throws(() => store.save(word), TypeError);
  }
  for (const context of [[], 1, { relation: 'same root' }, { sourceUrl: 'javascript:alert(1)' },
    { sourceUrl: 'http://en.wiktionary.org/wiki/nice' }, { sourceUrl: 'https://name:password@example.org/' },
    { sense: 'x'.repeat(501) }, { query: 'word\nother' }, { etymologyId: {} }]) {
    assert.throws(() => store.save('nice', context), TypeError);
  }
  assert.equal(store.list().length, 0);
});

test('sense-specific discovery contexts survive reload, are allowlisted, and duplicate saves merge', () => {
  const { store, storage, setTime } = setup();
  store.save('Kind', { ...source, ignored: 'never persisted' });
  store.save('kind', { ...source, query: 'NICE', sourceWord: 'Nice' });
  setTime(START + 100);
  store.save('kind', { ...source, relation: 'antonym', sense: 'unpleasant', etymologyId: 2 });
  const reloaded = createSavedWordsStore({ storage, now: () => START + 100 });
  const [word] = reloaded.list();
  assert.equal(word.word, 'Kind');
  assert.equal(word.savedAt, START);
  assert.equal(word.contexts.length, 2);
  assert.equal(word.contexts[0].relation, 'synonym');
  assert.equal(word.contexts[1].relation, 'antonym');
  assert.equal(word.contexts[1].etymologyId, '2');
  assert.equal('ignored' in word.contexts[0], false);
  assert.equal(storage.getItem(SAVED_WORDS_STORAGE_KEY).includes('ignored'), false);
});

test('provenance is bounded without creating duplicate saved words', () => {
  const { store } = setup();
  for (let index = 0; index < 30; index += 1) store.save('bright', { ...source, sense: `meaning ${index}` });
  const [word] = store.list();
  assert.equal(store.list().length, 1);
  assert.equal(word.contexts.length, 20);
  assert.equal(word.contexts[0].sense, 'meaning 10');
  assert.equal(word.contexts.at(-1).sense, 'meaning 29');
});

test('remove persists, export omits removed words, and explicit re-save starts a new item', () => {
  const { store, storage, setTime } = setup();
  store.save('Kind', source);
  assert.equal(store.remove('KIND'), true);
  assert.equal(store.remove('kind'), false);
  assert.equal(store.remove('missing'), false);
  assert.equal(store.exportData().words.length, 0);
  const reloaded = createSavedWordsStore({ storage, now: () => START + 100 });
  assert.equal(reloaded.has('kind'), false);
  setTime(START + 5000);
  const again = store.save('kind');
  assert.equal(again.word, 'kind');
  assert.equal(again.savedAt, START + 5000);
  assert.deepEqual(again.contexts, []);
});

test('sequential stale-tab writes retain both collections and cannot resurrect deleted words', () => {
  const storage = memoryStorage();
  const { store: first } = setup(storage);
  const { store: second } = setup(storage);
  first.save('kind', source);
  second.save('bright');
  assert.deepEqual(first.list().map(item => item.key), ['bright', 'kind']);
  first.remove('kind');
  second.save('clear');
  assert.deepEqual(second.list().map(item => item.key), ['bright', 'clear']);
  assert.equal(first.has('kind'), false);
  const third = createSavedWordsStore({ storage, now: () => START });
  assert.deepEqual(third.list().map(item => item.key), ['bright', 'clear']);
  second.save('kind', { ...source, sense: 'friendly' });
  assert.equal(first.has('kind'), true);
  assert.equal(first.list().find(item => item.key === 'kind').contexts[0].sense, 'friendly');
});

test('saved words remain removed when the device clock moves backwards', () => {
  const { store, storage, setTime } = setup();
  store.save('kind');
  setTime(START - 5000);
  store.remove('kind');
  const reloaded = createSavedWordsStore({ storage, now: () => START - 5000 });
  assert.equal(reloaded.has('kind'), false);
  reloaded.save('Kind');
  assert.equal(store.has('kind'), true);
});

test('snapshots, nested contexts, returned items and exports cannot mutate internal state', () => {
  const { store } = setup();
  const word = store.save('kind', source);
  assert.throws(() => { word.word = 'bad'; }, TypeError);
  assert.throws(() => { word.contexts[0].sense = 'changed'; }, TypeError);
  assert.throws(() => { store.list().push({}); }, TypeError);
  const exported = store.exportData();
  assert.throws(() => { exported.words.length = 0; }, TypeError);
  store.save('kind', { ...source, sense: 'another meaning' });
  assert.equal(word.contexts.length, 1);
  assert.equal(store.list()[0].contexts.length, 2);
});

test('malformed JSON, schemas, rows and bad contexts do not prevent useful words from loading', () => {
  for (const initial of ['broken{', 'null', '[]', '{}', '{"schemaVersion":9,"records":[]}']) {
    const { store } = setup(memoryStorage(initial));
    assert.deepEqual(store.list(), []);
    store.save('kind');
    assert.equal(store.list().length, 1);
  }
  const original = setup();
  original.store.save('kind', source);
  const [valid] = JSON.parse(original.storage.getItem(SAVED_WORDS_STORAGE_KEY)).records;
  const records = [null, 5, {}, { ...valid, key: 'forged' }, { ...valid, revision: -1 },
    { ...valid, operationId: '' }, { ...valid, savedAt: START + 1 },
    { ...valid, contexts: [{ ...source, sourceUrl: 'javascript:bad' }, ...valid.contexts] }];
  const { store } = setup(memoryStorage(JSON.stringify({ schemaVersion: 1, records })));
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].contexts.length, 1);
  assert.deepEqual(store.list()[0].contexts[0], source);
});

test('unreadable or full storage falls back to memory without losing the current list', () => {
  const blocked = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const { store: unavailable } = setup(blocked);
  assert.equal(unavailable.storageAvailable, false);
  unavailable.save('kind');
  assert.equal(unavailable.has('kind'), true);
  unavailable.remove('kind');
  assert.equal(unavailable.list().length, 0);
  let writes = 0;
  const full = { getItem: () => null, setItem() { writes += 1; throw new Error('quota'); } };
  const { store } = setup(full);
  store.save('kind');
  store.save('bright');
  assert.equal(store.storageAvailable, false);
  assert.equal(store.list().length, 2);
  assert.equal(writes, 1);
  assert.equal(store.exportData().words.length, 2);
});

test('subscriptions update on mutations, isolate listener failures, and unsubscribe cleanly', () => {
  const { store } = setup();
  const seen = [];
  const stop = store.subscribe(words => seen.push(words.map(item => item.word)));
  const stopBroken = store.subscribe(() => { throw new Error('view error'); });
  store.save('kind');
  store.save('kind');
  store.save('bright');
  store.remove('kind');
  assert.deepEqual(seen, [['kind'], ['bright', 'kind'], ['bright']]);
  stop();
  stopBroken();
  store.save('clear');
  assert.equal(seen.length, 3);
  assert.throws(() => store.subscribe('invalid'), TypeError);
});

test('browser storage events refresh subscribed views and stop after unsubscribe', () => {
  const originalAdd = globalThis.addEventListener;
  const originalRemove = globalThis.removeEventListener;
  let handler;
  let removed = 0;
  globalThis.addEventListener = (name, value) => { assert.equal(name, 'storage'); handler = value; };
  globalThis.removeEventListener = (name, value) => { assert.equal(name, 'storage'); assert.equal(value, handler); removed += 1; };
  try {
    const storage = memoryStorage();
    const first = setup(storage).store;
    const second = setup(storage).store;
    const seen = [];
    const stop = first.subscribe(words => seen.push(words.length));
    second.save('kind');
    handler({ key: 'unrelated', storageArea: storage });
    assert.deepEqual(seen, []);
    handler({ key: SAVED_WORDS_STORAGE_KEY, storageArea: storage });
    assert.deepEqual(seen, [1]);
    second.remove('kind');
    handler({ key: SAVED_WORDS_STORAGE_KEY, storageArea: storage });
    assert.deepEqual(seen, [1, 0]);
    stop();
    assert.equal(removed, 1);
  } finally {
    if (originalAdd === undefined) delete globalThis.addEventListener; else globalThis.addEventListener = originalAdd;
    if (originalRemove === undefined) delete globalThis.removeEventListener; else globalThis.removeEventListener = originalRemove;
  }
});

test('saved words touch only their own storage key, never learning or remembered-origin evidence', () => {
  const storage = memoryStorage();
  const learning = '{"attempts":["existing"]}';
  const remembered = '["la:specio"]';
  storage.values.set('etymovocab.learning.v1', learning);
  storage.values.set('etymovocab.remembered.v1', remembered);
  const { store } = setup(storage);
  store.save('kind', source);
  store.remove('kind');
  assert.equal(storage.values.get('etymovocab.learning.v1'), learning);
  assert.equal(storage.values.get('etymovocab.remembered.v1'), remembered);
  assert.equal(storage.values.size, 3);
});
