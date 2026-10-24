import test from 'node:test';
import assert from 'node:assert/strict';
import { createLearningDraftStore, LEARNING_DRAFT_STORAGE_KEY } from '../../src/EtymoVocab.Web/wwwroot/learning-drafts.js';

const VERSION = 'test-1';
const question = id => ({
  id, options: [{ id: 'a', text: 'One option' }, { id: 'b', text: 'Another option' }],
  answerId: 'b', explanation: 'This teaching content must never enter draft storage.',
});
const lessons = ['first', 'second'].map(id => ({
  id, questions: [question('transfer'), question('boundary')], delayed: question('followup'),
}));
const input = { lessonId: 'first', questionId: 'transfer', phase: 'immediate' };

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
}

const create = (storage, extra = {}) => createLearningDraftStore({ storage, lessons, version: VERSION, ...extra });

test('a partial answer, confidence, and literal rationale restore after a same-tab reload', () => {
  const storage = memoryStorage();
  const store = create(storage);
  assert.equal(store.get('first', 'transfer', 'immediate'), null);
  store.set({ ...input, answerId: 'a', reason: '<b>prefix & sentence</b> 我還在思考。' });
  let reloaded = create(storage);
  assert.deepEqual(reloaded.get('first', 'transfer', 'immediate'), {
    ...input, answerId: 'a', confidence: null, reason: '<b>prefix & sentence</b> 我還在思考。',
  });
  reloaded.set({ ...reloaded.get('first', 'transfer', 'immediate'), confidence: 'high' });
  reloaded = create(storage);
  assert.equal(reloaded.get('first', 'transfer', 'immediate').confidence, 'high');
  assert.equal(reloaded.storageAvailable, true);
});

test('defaults allow an unfinished question and only learner inputs reach the dedicated key', () => {
  const storage = memoryStorage();
  storage.setItem('etymovocab.learning.v1', 'submitted history');
  const store = create(storage);
  store.set({ ...input, explanation: 'Do not persist me', correct: true, firstAttempt: true });
  const saved = JSON.parse(storage.getItem(LEARNING_DRAFT_STORAGE_KEY));
  assert.deepEqual(saved.drafts, [{ ...input, answerId: null, confidence: null, reason: '' }]);
  assert.equal(storage.getItem('etymovocab.learning.v1'), 'submitted history');
  assert.deepEqual([...storage.values.keys()].sort(), ['etymovocab.learning-drafts.v1', 'etymovocab.learning.v1']);
});

test('lesson identities, questions, phases, versions, and separate tab storage stay isolated', () => {
  const storage = memoryStorage();
  const store = create(storage);
  store.set({ ...input, answerId: 'a' });
  store.set({ ...input, lessonId: 'second', answerId: 'b' });
  store.set({ lessonId: 'first', questionId: 'followup', phase: 'delayed', reason: 'A later challenge' });
  const reloaded = create(storage);
  assert.equal(reloaded.get('first', 'transfer', 'immediate').answerId, 'a');
  assert.equal(reloaded.get('second', 'transfer', 'immediate').answerId, 'b');
  assert.equal(reloaded.get('first', 'boundary', 'immediate'), null);
  assert.equal(reloaded.get('first', 'followup', 'delayed').reason, 'A later challenge');
  assert.equal(create(storage, { version: 'test-2' }).get('first', 'transfer', 'immediate'), null);
  assert.equal(create(memoryStorage()).get('first', 'transfer', 'immediate'), null);
});

test('removing the submitted question clears its reload draft without deleting another draft', () => {
  const storage = memoryStorage();
  const store = create(storage);
  store.set({ ...input, answerId: 'a' });
  store.set({ ...input, questionId: 'boundary', reason: 'Keep this unfinished answer' });
  store.remove('first', 'transfer', 'immediate');
  const reloaded = create(storage);
  assert.equal(reloaded.get('first', 'transfer', 'immediate'), null);
  assert.equal(reloaded.get('first', 'boundary', 'immediate').reason, 'Keep this unfinished answer');
  reloaded.remove('first', 'transfer', 'immediate');
  assert.equal(reloaded.get('first', 'boundary', 'immediate').reason, 'Keep this unfinished answer');
});

test('malformed payloads, schemas, and rows restore safely without poisoning valid drafts', () => {
  const good = { ...input, answerId: 'a', confidence: 'low', reason: 'Keep me' };
  const wrapper = drafts => JSON.stringify({ schemaVersion: 1, version: VERSION, drafts });
  for (const raw of ['{broken', 'null', '[]', '{}', wrapper(true), JSON.stringify({ schemaVersion: 2, version: VERSION, drafts: [good] })]) {
    const storage = memoryStorage();
    storage.setItem(LEARNING_DRAFT_STORAGE_KEY, raw);
    const store = create(storage);
    assert.equal(store.get('first', 'transfer', 'immediate'), null);
    store.set({ ...input, reason: 'Recovered' });
    assert.equal(create(storage).get('first', 'transfer', 'immediate').reason, 'Recovered');
  }
  const storage = memoryStorage();
  storage.setItem(LEARNING_DRAFT_STORAGE_KEY, wrapper([
    null, 7, {}, good,
    { ...good, lessonId: 'missing' }, { ...good, questionId: 'missing' },
    { ...good, phase: 'delayed' }, { ...good, answerId: 'missing' },
    { ...good, confidence: 'certain' }, { ...good, reason: 'a'.repeat(501) },
  ]));
  assert.deepEqual(create(storage).get('first', 'transfer', 'immediate'), good);
});

test('invalid input is rejected before replacing or persisting an existing draft', () => {
  const storage = memoryStorage();
  const store = create(storage);
  store.set({ ...input, answerId: 'b', reason: 'Original draft' });
  const original = storage.getItem(LEARNING_DRAFT_STORAGE_KEY);
  for (const change of [
    { lessonId: 'missing' }, { questionId: 'missing' }, { phase: 'delayed' }, { phase: 'other' },
    { answerId: 'missing' }, { answerId: 1 }, { confidence: 'certain' }, { reason: null }, { reason: 'a'.repeat(501) },
  ]) assert.throws(() => store.set({ ...input, ...change }), TypeError);
  assert.throws(() => store.set(null), TypeError);
  assert.throws(() => store.get('first', 'followup', 'immediate'), TypeError);
  assert.throws(() => store.remove('missing', 'transfer', 'immediate'), TypeError);
  assert.equal(storage.getItem(LEARNING_DRAFT_STORAGE_KEY), original);
  store.set({ ...input, reason: 'a'.repeat(500) });
  assert.equal(store.get('first', 'transfer', 'immediate').reason.length, 500);
});

test('draft records and catalogue snapshots cannot be mutated to change restored values', () => {
  const storage = memoryStorage();
  const mutableLessons = structuredClone(lessons);
  const store = create(storage, { lessons: mutableLessons });
  const original = { ...input, answerId: 'a' };
  const returned = store.set(original);
  original.answerId = 'b';
  assert.throws(() => { returned.answerId = 'b'; }, TypeError);
  const restored = store.get('first', 'transfer', 'immediate');
  assert.throws(() => { restored.reason = 'Tampered'; }, TypeError);
  mutableLessons[0].questions[0].options.push({ id: 'foreign', text: 'New option' });
  assert.throws(() => store.set({ ...input, answerId: 'foreign' }), TypeError);
  assert.equal(create(storage).get('first', 'transfer', 'immediate').answerId, 'a');
});

test('blocked storage and quota failures preserve an in-memory draft and support removal', () => {
  for (const storage of [null, {}, {
    getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); },
  }]) {
    const store = create(storage);
    assert.equal(store.storageAvailable, false);
    store.set({ ...input, reason: 'In memory' });
    assert.equal(store.get('first', 'transfer', 'immediate').reason, 'In memory');
    store.remove('first', 'transfer', 'immediate');
    assert.equal(store.get('first', 'transfer', 'immediate'), null);
  }
  let writes = 0;
  const store = create({ getItem: () => null, setItem() { writes += 1; throw new Error('quota'); } });
  assert.equal(store.storageAvailable, true);
  store.set({ ...input, answerId: 'a' });
  store.set({ ...input, answerId: 'b' });
  assert.equal(store.storageAvailable, false);
  assert.equal(store.get('first', 'transfer', 'immediate').answerId, 'b');
  assert.equal(writes, 1);
  store.remove('first', 'transfer', 'immediate');
  assert.equal(store.get('first', 'transfer', 'immediate'), null);
});

test('default persistence uses sessionStorage and does not read local attempt history', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const storage = memoryStorage();
  try {
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
    create(undefined).set({ ...input, reason: 'Session only' });
    assert.equal(create(undefined).get('first', 'transfer', 'immediate').reason, 'Session only');
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('blocked'); } });
    const denied = create(undefined);
    denied.set({ ...input, reason: 'Still usable' });
    assert.equal(denied.storageAvailable, false);
    assert.equal(denied.get('first', 'transfer', 'immediate').reason, 'Still usable');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor);
    else delete globalThis.sessionStorage;
  }
});
