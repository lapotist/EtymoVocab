import test from 'node:test';
import assert from 'node:assert/strict';
import { createLearningStore, DELAY_MS, LEARNING_STORAGE_KEY } from '../../src/EtymoVocab.Web/wwwroot/learning-state.js';

const START = 1_700_000_000_000;
const VERSION = 'test-1';
const options = [{ id: 'yes', text: 'Answer' }, { id: 'no', text: 'Distractor' }];
const makeQuestion = (id, kind, sense) => ({ id, kind, term: id, sense, options, answerId: 'yes' });
const lessons = [
  {
    id: 'negative-in', concept: { id: 'in:not' },
    questions: [makeQuestion('transfer', 'transfer', 'not active'), makeQuestion('boundary', 'boundary', 'inside')],
    delayed: makeQuestion('delayed', 'transfer', 'not complete'),
  },
  {
    id: 'inward-in', concept: { id: 'in:into' },
    questions: [makeQuestion('transfer', 'transfer', 'going into'), makeQuestion('boundary', 'boundary', 'not possible')],
    delayed: makeQuestion('delayed', 'transfer', 'bringing in'),
  },
];

function memoryStorage(initial = null) {
  const values = new Map(initial === null ? [] : [[LEARNING_STORAGE_KEY, initial]]);
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
}

function setup(storage = memoryStorage()) {
  let timestamp = START;
  const store = createLearningStore({ storage, lessons, version: VERSION, now: () => timestamp });
  return { store, storage, setTime: value => { timestamp = value; } };
}

const answer = (store, questionId = 'transfer', extra = {}) => store.recordAttempt({
  lessonId: 'negative-in', questionId, answerId: 'yes', confidence: 'medium', priorKnowledge: 'new', ...extra,
});

test('first responses alone score; transfer, boundary, and confident errors remain separate', () => {
  const { store } = setup();
  const first = answer(store, 'transfer', { answerId: 'no', confidence: 'high' });
  const retry = answer(store, 'transfer', { answerId: 'yes', confidence: 'high' });
  answer(store, 'boundary');
  answer(store, 'boundary', { answerId: 'no', confidence: 'high' });
  assert.equal(first.firstAttempt, true);
  assert.equal(retry.firstAttempt, false);
  assert.deepEqual(store.getSummary(), {
    transfer: { correct: 0, total: 1 }, boundary: { correct: 1, total: 1 }, delayed: { correct: 0, total: 0 },
    confidentErrors: 1, completedLessons: 1,
  });
  assert.equal(store.getAttempts().length, 4);
});

test('known-word skips complete a lesson without counting as demonstrated knowledge', () => {
  const { store } = setup();
  const skipped = answer(store, 'transfer', { priorKnowledge: 'known' });
  answer(store, 'transfer');
  answer(store, 'boundary', { priorKnowledge: 'known', answerId: null, confidence: null });
  assert.equal(skipped.answerId, null);
  assert.equal(skipped.confidence, null);
  assert.equal(skipped.correct, null);
  assert.equal(store.getLessonProgress('negative-in').immediateCompleted, true);
  assert.deepEqual(store.getSummary().transfer, { correct: 0, total: 0 });
  assert.deepEqual(store.getSummary().boundary, { correct: 0, total: 0 });
});

test('delayed gate anchors to initial completion, survives reload and retries, and opens at seven days', () => {
  const { store, storage, setTime } = setup();
  assert.equal(store.canStartDelayed('negative-in'), false);
  assert.throws(() => answer(store, 'delayed'), RangeError);
  answer(store);
  setTime(START + 5000);
  answer(store, 'boundary', { priorKnowledge: 'known' });
  const dueAt = START + 5000 + DELAY_MS;
  assert.equal(store.getLessonProgress('negative-in').completedAt, START + 5000);
  assert.equal(store.getLessonProgress('negative-in').dueAt, dueAt);
  setTime(dueAt - 1);
  answer(store);
  assert.equal(store.canStartDelayed('negative-in'), false);
  assert.throws(() => answer(store, 'delayed'), RangeError);
  const reloaded = createLearningStore({ storage, lessons, version: VERSION, now: () => dueAt });
  assert.equal(reloaded.canStartDelayed('negative-in'), true);
  assert.equal(reloaded.getLessonProgress('negative-in').dueAt, dueAt);
  answer(reloaded, 'delayed', { answerId: 'no', confidence: 'high' });
  answer(reloaded, 'delayed');
  assert.equal(reloaded.getLessonProgress('negative-in').delayedCompleted, true);
  assert.deepEqual(reloaded.getSummary().delayed, { correct: 0, total: 1 });
  assert.deepEqual(reloaded.getSummary().transfer, { correct: 1, total: 1 });
  assert.equal(reloaded.getSummary().confidentErrors, 1);
});

test('same question ids in different lessons preserve concept and sense isolation', () => {
  const { store, storage } = setup();
  answer(store, 'transfer', { answerId: 'no' });
  answer(store, 'transfer', { lessonId: 'inward-in' });
  const reloaded = createLearningStore({ storage, lessons, version: VERSION, now: () => START });
  assert.deepEqual(reloaded.getSummary().transfer, { correct: 1, total: 2 });
  assert.deepEqual(reloaded.getAttempts().map(({ conceptId, sense, firstAttempt }) => ({ conceptId, sense, firstAttempt })), [
    { conceptId: 'in:not', sense: 'not active', firstAttempt: true },
    { conceptId: 'in:into', sense: 'going into', firstAttempt: true },
  ]);
  assert.equal(reloaded.getLessonProgress('inward-in').answeredCount, 1);
});

test('immutable attempts and detached exports cannot change stored scores', () => {
  const { store } = setup();
  const attempt = answer(store);
  assert.throws(() => { attempt.correct = false; }, TypeError);
  assert.throws(() => { store.getAttempts().push({}); }, TypeError);
  const exported = store.exportData();
  exported.attempts[0].correct = false;
  exported.attempts.length = 0;
  assert.deepEqual(store.getSummary().transfer, { correct: 1, total: 1 });
  assert.equal(store.getAttempts().length, 1);
});

test('exports include readable, snapshotted context without adding it to persisted evidence', () => {
  const catalogue = structuredClone(lessons);
  catalogue[0].title = 'Recognize negative in-';
  catalogue[0].questions[0].term = 'inactive';
  catalogue[0].questions[0].prompt = 'Which meaning fits the sentence?';
  const storage = memoryStorage();
  const store = createLearningStore({ storage, lessons: catalogue, version: VERSION, now: () => START });
  const attempt = answer(store, 'transfer', { answerId: 'no', confidence: 'high', reason: 'I checked the prefix.' });
  const persisted = storage.getItem(LEARNING_STORAGE_KEY);

  catalogue[0].title = 'Edited title';
  catalogue[0].questions[0].term = 'edited-term';
  catalogue[0].questions[0].prompt = 'Edited prompt';
  catalogue[0].questions[0].options[0].text = 'Edited answer';
  catalogue[0].questions[0].options[1].text = 'Edited distractor';

  const exported = store.exportData().attempts[0];
  for (const [field, value] of Object.entries(attempt)) assert.equal(exported[field], value);
  assert.equal(exported.lessonTitle, 'Recognize negative in-');
  assert.equal(exported.term, 'inactive');
  assert.equal(exported.prompt, 'Which meaning fits the sentence?');
  assert.equal(exported.selectedAnswerText, 'Distractor');
  assert.equal(exported.referenceAnswerText, 'Answer');
  assert.equal(exported.kind, 'transfer');
  assert.equal(exported.timestampIso, new Date(START).toISOString());
  assert.equal(storage.getItem(LEARNING_STORAGE_KEY), persisted);
  assert.deepEqual(JSON.parse(persisted).attempts[0], attempt);
  assert.deepEqual(store.getAttempts()[0], attempt);
});

test('minimal catalogues have safe export fallbacks and known skips have no selected answer', () => {
  const catalogue = structuredClone(lessons);
  delete catalogue[0].questions[0].term;
  catalogue[0].questions[0].options = [{ id: 'yes' }, { id: 'no' }];
  const store = createLearningStore({ storage: memoryStorage(), lessons: catalogue, version: VERSION, now: () => START });
  answer(store);
  answer(store, 'boundary', { priorKnowledge: 'known' });
  const [response, skipped] = store.exportData().attempts;
  assert.equal(response.lessonTitle, 'negative-in');
  assert.equal(response.term, 'transfer');
  assert.equal(response.prompt, null);
  assert.equal(response.selectedAnswerText, 'yes');
  assert.equal(response.referenceAnswerText, 'yes');
  assert.equal(skipped.selectedAnswerText, null);
  assert.equal(skipped.referenceAnswerText, 'Answer');
  assert.equal(skipped.kind, 'boundary');
  assert.equal(skipped.correct, null);
});

test('archived exports never use readable labels from a different curriculum version', () => {
  const { store, storage } = setup();
  const historical = answer(store, 'transfer', { answerId: 'no', confidence: 'high' });
  const changedCatalogue = structuredClone(lessons);
  changedCatalogue[0].title = 'Different lesson using the same id';
  changedCatalogue[0].questions[0].term = 'different-word';
  changedCatalogue[0].questions[0].prompt = 'Different question';
  changedCatalogue[0].questions[0].options[0].text = 'Different answer';
  const nextVersion = createLearningStore({ storage, lessons: changedCatalogue, version: 'test-2', now: () => START });
  const exported = nextVersion.exportData().attempts[0];
  for (const field of ['lessonTitle', 'term', 'prompt', 'selectedAnswerText', 'referenceAnswerText', 'kind']) {
    assert.equal(exported[field], null, `${field} must not be inferred from a different curriculum`);
  }
  assert.equal(exported.timestampIso, new Date(START).toISOString());
  for (const [field, value] of Object.entries(historical)) assert.equal(exported[field], value);
  assert.deepEqual(nextVersion.getSummary().transfer, { correct: 0, total: 0 });
});

test('readable export round-trips preserve scores and metadata is rebuilt instead of trusted', () => {
  const { store, setTime } = setup();
  answer(store, 'transfer', { answerId: 'no', confidence: 'high' });
  answer(store);
  answer(store, 'boundary', { priorKnowledge: 'known' });
  setTime(START + DELAY_MS);
  answer(store, 'delayed');
  const expected = store.getSummary();
  const exported = store.exportData();
  for (const attempt of exported.attempts) {
    attempt.lessonTitle = 'Untrusted title';
    attempt.term = 'Untrusted word';
    attempt.selectedAnswerText = 'Untrusted answer';
    attempt.referenceAnswerText = 'Untrusted reference';
    attempt.kind = 'boundary';
    attempt.timestampIso = 'Untrusted time';
  }
  const storage = memoryStorage(JSON.stringify(exported));
  const reloaded = createLearningStore({ storage, lessons, version: VERSION, now: () => START + DELAY_MS });
  assert.deepEqual(reloaded.getSummary(), expected);
  const rebuilt = reloaded.exportData().attempts[0];
  assert.equal(rebuilt.lessonTitle, 'negative-in');
  assert.equal(rebuilt.term, 'transfer');
  assert.equal(rebuilt.selectedAnswerText, 'Distractor');
  assert.equal(rebuilt.referenceAnswerText, 'Answer');
  assert.equal(rebuilt.kind, 'transfer');
  assert.equal(rebuilt.timestampIso, new Date(START).toISOString());
  answer(reloaded, 'boundary');
  assert.deepEqual(reloaded.getSummary(), expected);
  for (const attempt of JSON.parse(storage.getItem(LEARNING_STORAGE_KEY)).attempts) {
    for (const field of ['lessonTitle', 'term', 'prompt', 'selectedAnswerText', 'referenceAnswerText', 'kind', 'timestampIso']) {
      assert.equal(Object.hasOwn(attempt, field), false, `${field} must remain export-only`);
    }
  }
});

test('malformed JSON and incompatible schemas start safely empty', () => {
  for (const raw of ['broken{', 'null', '[]', '{}', '{"attempts":true}', JSON.stringify({ schemaVersion: 8, version: VERSION, attempts: [] })]) {
    const { store } = setup(memoryStorage(raw));
    assert.deepEqual(store.getAttempts(), []);
    assert.equal(store.storageAvailable, true);
    answer(store);
    assert.equal(store.getAttempts().length, 1);
  }
});

test('older curricula remain exportable but cannot affect current scores, completion, or eligibility', () => {
  const { store, storage } = setup();
  answer(store);
  answer(store, 'boundary');
  const nextVersion = createLearningStore({ storage, lessons, version: 'next-version', now: () => START });
  assert.deepEqual(nextVersion.getAttempts(), []);
  assert.equal(nextVersion.getSummary().completedLessons, 0);
  assert.equal(nextVersion.getLessonProgress('negative-in').dueAt, null);
  assert.equal(nextVersion.canStartDelayed('negative-in'), false);
  assert.equal(nextVersion.exportData().attempts.length, 2);
  assert.equal(nextVersion.exportData().attempts[0].version, VERSION);
  answer(nextVersion, 'transfer', { answerId: 'no' });
  assert.equal(nextVersion.exportData().attempts.length, 3);
  const reloaded = createLearningStore({ storage, lessons, version: 'next-version', now: () => START });
  assert.deepEqual(reloaded.getSummary().transfer, { correct: 0, total: 1 });
  assert.equal(reloaded.getLessonProgress('negative-in').attempts.length, 1);
  assert.equal(reloaded.exportData().attempts.length, 3);
});

test('loading rejects malformed, foreign, duplicate, future, and prematurely delayed records', () => {
  const { store } = setup();
  const valid = answer(store, 'transfer', { answerId: 'no', confidence: 'high' });
  const rows = [
    null, 9, {}, valid, valid,
    { ...valid, id: 'foreign', lessonId: 'missing' },
    { ...valid, id: 'bad-option', answerId: 'missing' },
    { ...valid, id: 'bad-confidence', confidence: 'certain' },
    { ...valid, id: 'bad-knowledge', priorKnowledge: 'maybe' },
    { ...valid, id: 'bad-concept', conceptId: 'in:into' },
    { ...valid, id: 'bad-sense', sense: 'another meaning' },
    { ...valid, id: 'bad-phase', phase: 'delayed' },
    { ...valid, id: 'bad-version', version: 'other' },
    { ...valid, id: 'bad-time', timestamp: '1700000000000' },
    { ...valid, id: 'negative-time', timestamp: -1 },
    { ...valid, id: 'future', timestamp: START + 1 },
    { ...valid, id: 'premature', questionId: 'delayed', phase: 'delayed', sense: 'not complete' },
    { ...valid, id: 'bad-known', priorKnowledge: 'known' },
  ];
  const { store: loaded } = setup(memoryStorage(JSON.stringify({ schemaVersion: 1, version: VERSION, attempts: rows })));
  assert.equal(loaded.getAttempts().length, 1);
  assert.deepEqual(loaded.getSummary().transfer, { correct: 0, total: 1 });
});

test('saved correctness and first-attempt fields cannot inflate scores', () => {
  const { store } = setup();
  answer(store, 'transfer', { answerId: 'no', confidence: 'high' });
  answer(store);
  const payload = store.exportData();
  payload.attempts[0].correct = true;
  payload.attempts[0].firstAttempt = false;
  payload.attempts[1].firstAttempt = true;
  const { store: loaded } = setup(memoryStorage(JSON.stringify(payload)));
  assert.deepEqual(loaded.getSummary().transfer, { correct: 0, total: 1 });
  assert.equal(loaded.getSummary().confidentErrors, 1);
  assert.deepEqual(loaded.getAttempts().map(attempt => attempt.firstAttempt), [true, false]);
});

test('read and write failures preserve an in-memory session and report persistence unavailable', () => {
  const deniedRead = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const { store: readFailed } = setup(deniedRead);
  assert.equal(readFailed.storageAvailable, false);
  answer(readFailed);
  assert.equal(readFailed.getAttempts().length, 1);

  let writes = 0;
  const fullStorage = { getItem: () => null, setItem() { writes += 1; throw new Error('quota'); } };
  const { store: writeFailed } = setup(fullStorage);
  assert.equal(writeFailed.storageAvailable, true);
  answer(writeFailed);
  answer(writeFailed, 'boundary');
  assert.equal(writeFailed.storageAvailable, false);
  assert.equal(writeFailed.getLessonProgress('negative-in').immediateCompleted, true);
  assert.equal(writes, 1);
  assert.equal(writeFailed.exportData().attempts.length, 2);
});

test('invalid submissions do not mutate progress or persistence', () => {
  const { store, storage } = setup();
  for (const input of [null, {}, { lessonId: 'missing', questionId: 'transfer' }]) {
    assert.throws(() => store.recordAttempt(input), TypeError);
  }
  for (const change of [
    { questionId: 'missing' }, { answerId: 'missing' }, { confidence: 'very-high' }, { priorKnowledge: 'unsure' },
  ]) assert.throws(() => answer(store, 'transfer', change), TypeError);
  assert.equal(store.getAttempts().length, 0);
  assert.equal(storage.getItem(LEARNING_STORAGE_KEY), null);
  assert.throws(() => store.getLessonProgress('missing'), TypeError);
  assert.throws(() => store.canStartDelayed('missing'), TypeError);
});

test('the legacy remembered flag is neither read nor promoted to learning evidence', () => {
  const storage = memoryStorage();
  storage.values.set('etymovocab.remembered.v1', JSON.stringify(['la:in-']));
  const { store } = setup(storage);
  assert.equal(store.getAttempts().length, 0);
  answer(store);
  assert.equal(storage.values.get('etymovocab.remembered.v1'), JSON.stringify(['la:in-']));
  assert.equal(JSON.parse(storage.getItem(LEARNING_STORAGE_KEY)).attempts.length, 1);
});

test('sequential writes from stale tabs preserve both histories and refresh reads', () => {
  const storage = memoryStorage();
  const { store: tabA } = setup(storage);
  const { store: tabB } = setup(storage);
  answer(tabA, 'transfer', { answerId: 'no', confidence: 'high' });
  answer(tabB, 'boundary');
  assert.equal(JSON.parse(storage.getItem(LEARNING_STORAGE_KEY)).attempts.length, 2);
  assert.equal(tabA.getAttempts().length, 2);
  assert.deepEqual(tabA.getSummary(), {
    transfer: { correct: 0, total: 1 }, boundary: { correct: 1, total: 1 }, delayed: { correct: 0, total: 0 },
    confidentErrors: 1, completedLessons: 1,
  });
  assert.equal(tabB.getLessonProgress('negative-in').immediateCompleted, true);
  assert.equal(tabA.exportData().attempts.length, 2);
});

test('equal timestamps across tabs keep the already persisted response first', () => {
  const storage = memoryStorage();
  const { store: tabA } = setup(storage);
  const { store: tabB } = setup(storage);
  const first = answer(tabA, 'transfer', { answerId: 'no', confidence: 'high' });
  const repeat = answer(tabB);
  assert.equal(first.timestamp, repeat.timestamp);
  assert.equal(repeat.firstAttempt, false);
  assert.equal(tabA.getAttempts()[0].id, first.id);
  assert.equal(tabB.getAttempts()[0].id, first.id);
  assert.deepEqual(tabA.getSummary().transfer, { correct: 0, total: 1 });
  answer(tabA);
  const { store: reloaded } = setup(storage);
  assert.deepEqual(reloaded.getAttempts().map(attempt => attempt.firstAttempt), [true, false, false]);
  assert.deepEqual(reloaded.getSummary().transfer, { correct: 0, total: 1 });
});

test('completion in another tab establishes the same seven-day gate', () => {
  const storage = memoryStorage();
  const { store: tabA, setTime: timeA } = setup(storage);
  const { store: tabB, setTime: timeB } = setup(storage);
  answer(tabA);
  timeB(START + 5000);
  answer(tabB, 'boundary');
  timeA(START + 5000);
  assert.equal(tabA.getLessonProgress('negative-in').completedAt, START + 5000);
  assert.equal(tabA.canStartDelayed('negative-in'), false);
  timeA(START + 5000 + DELAY_MS);
  assert.equal(tabA.canStartDelayed('negative-in'), true);
  answer(tabA, 'delayed');
  timeB(START + 5000 + DELAY_MS);
  assert.equal(tabB.getLessonProgress('negative-in').delayedCompleted, true);
  assert.deepEqual(tabB.getSummary().delayed, { correct: 1, total: 1 });
});

test('malformed remote updates do not discard a valid in-memory history', () => {
  const { store, storage } = setup();
  answer(store);
  storage.setItem(LEARNING_STORAGE_KEY, '{malformed');
  assert.deepEqual(store.getSummary().transfer, { correct: 1, total: 1 });
  storage.setItem(LEARNING_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, version: VERSION, attempts: [{}] }));
  assert.equal(store.getAttempts().length, 1);
  answer(store, 'boundary');
  assert.equal(JSON.parse(storage.getItem(LEARNING_STORAGE_KEY)).attempts.length, 2);
});

test('optional rationales round-trip as ungraded text, and older records default to empty text', () => {
  const { store, storage } = setup();
  const reason = 'I used the prefix and checked it against the sentence. <script> is just text.';
  const attempt = answer(store, 'transfer', { reason });
  assert.equal(attempt.reason, reason);
  const { store: reloaded } = setup(storage);
  assert.equal(reloaded.getAttempts()[0].reason, reason);
  assert.equal(reloaded.exportData().attempts[0].reason, reason);
  assert.deepEqual(reloaded.getSummary().transfer, { correct: 1, total: 1 });
  const legacy = store.exportData();
  delete legacy.attempts[0].reason;
  const { store: oldRecord } = setup(memoryStorage(JSON.stringify(legacy)));
  assert.equal(oldRecord.getAttempts()[0].reason, '');
  const skipped = answer(reloaded, 'boundary', { priorKnowledge: 'known' });
  assert.equal(skipped.reason, '');
});

test('invalid or oversized rationales are rejected without recording an attempt', () => {
  const { store } = setup();
  for (const reason of [null, 10, {}, 'a'.repeat(501)]) {
    assert.throws(() => answer(store, 'transfer', { reason }), TypeError);
  }
  assert.throws(() => answer(store, 'transfer', { priorKnowledge: 'known', reason: 'A skipped response has no rationale.' }), TypeError);
  assert.equal(store.getAttempts().length, 0);
  answer(store, 'transfer', { reason: 'a'.repeat(500) });
  assert.equal(store.getAttempts()[0].reason.length, 500);
});
