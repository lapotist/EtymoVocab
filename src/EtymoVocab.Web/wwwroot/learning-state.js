// Learning evidence is deliberately separate from the map's self-reported "remembered" flags.
export const LEARNING_STORAGE_KEY = 'etymovocab.learning.v1';
export const DELAY_MS = 7 * 24 * 60 * 60 * 1000;
const SCHEMA_VERSION = 1;
const CONFIDENCES = new Set(['low', 'medium', 'high']);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const isVersion = value => isText(value) || (typeof value === 'number' && Number.isFinite(value));
const isTimestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
const attemptKey = (lessonId, questionId) => JSON.stringify([lessonId, questionId]);

/**
 * A local, catalogue-validated record of attempts. Times are milliseconds since the Unix epoch.
 * The first response to each question is the only scored response, including an unscored "known"
 * skip. Delayed answers become available seven days after all immediate questions were answered.
 */
export function createLearningStore({ storage, lessons, version, now = () => Date.now() }) {
  if (!isVersion(version) || !Array.isArray(lessons)) {
    throw new TypeError('A lesson catalogue and curriculum version are required.');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function.');

  // Snapshot validation fields and readable export context; later edits to the caller's objects
  // cannot change recorded evidence or silently relabel its exported answers.
  const catalogue = new Map();
  for (const lesson of lessons) {
    if (!isText(lesson?.id) || catalogue.has(lesson.id) || !isText(lesson.concept?.id)
      || !Array.isArray(lesson.questions) || !lesson.questions.length || !lesson.delayed) {
      throw new TypeError('Each lesson needs a unique id, concept, questions, and delayed question.');
    }
    const questions = new Map();
    const addQuestion = (question, phase) => {
      if (!isText(question?.id) || questions.has(question.id) || !isText(question.sense)
        || !['transfer', 'boundary'].includes(question.kind)
        || (phase === 'delayed' && question.kind !== 'transfer')
        || !Array.isArray(question.options) || question.options.length < 2) {
        throw new TypeError('Questions need unique ids, senses, kinds, and answer options.');
      }
      const options = new Set();
      const optionTexts = new Map();
      for (const option of question.options) {
        if (!isText(option?.id) || options.has(option.id)) throw new TypeError('Answer option ids must be unique.');
        options.add(option.id);
        optionTexts.set(option.id, isText(option.text) ? option.text : option.id);
      }
      if (!options.has(question.answerId)) throw new TypeError('The correct answer must be an option.');
      questions.set(question.id, {
        id: question.id, sense: question.sense, kind: question.kind, phase,
        options, answerId: question.answerId, optionTexts,
        term: isText(question.term) ? question.term : question.id,
        prompt: isText(question.prompt) ? question.prompt : null,
      });
    };
    lesson.questions.forEach(question => addQuestion(question, 'immediate'));
    addQuestion(lesson.delayed, 'delayed');
    catalogue.set(lesson.id, {
      id: lesson.id, title: isText(lesson.title) ? lesson.title : lesson.id,
      conceptId: lesson.concept.id, questions,
      immediateIds: lesson.questions.map(question => question.id), delayedId: lesson.delayed.id,
    });
  }

  function currentTime() {
    const value = now();
    if (!isTimestamp(value)) throw new TypeError('now must return a valid timestamp in milliseconds.');
    return value;
  }

  let available = true;
  let persistence = storage;
  if (persistence === undefined) {
    try { persistence = globalThis.localStorage; } catch { available = false; }
  }
  if (!persistence || typeof persistence.getItem !== 'function' || typeof persistence.setItem !== 'function') available = false;
  const attempts = [];
  const archivedAttempts = [];
  const firstAnswers = new Map();
  const ids = new Set();
  let sequence = 0;

  function findLesson(lessonId) {
    const lesson = catalogue.get(lessonId);
    if (!lesson) throw new TypeError('Unknown lesson.');
    return lesson;
  }

  function findQuestion(lessonId, questionId) {
    const lesson = findLesson(lessonId);
    const question = lesson.questions.get(questionId);
    if (!question) throw new TypeError('Unknown question for this lesson.');
    return { lesson, question };
  }

  function completion(lesson) {
    const first = lesson.immediateIds.map(id => firstAnswers.get(attemptKey(lesson.id, id)));
    const answered = first.filter(Boolean);
    const completedAt = answered.length === first.length ? Math.max(...answered.map(attempt => attempt.timestamp)) : null;
    return { answeredCount: answered.length, completedAt, dueAt: completedAt === null ? null : completedAt + DELAY_MS };
  }

  function makeAttempt(input, timestamp, id) {
    const { lesson, question } = findQuestion(input.lessonId, input.questionId);
    if (input.priorKnowledge !== 'new' && input.priorKnowledge !== 'known') throw new TypeError('Choose whether the word was already known.');
    const known = input.priorKnowledge === 'known';
    const reason = input.reason === undefined ? '' : input.reason;
    if (typeof reason !== 'string' || reason.length > 500 || (known && reason !== '')) {
      throw new TypeError('A rationale must be text of at most 500 characters; skipped questions have none.');
    }
    if (!known && (!question.options.has(input.answerId) || !CONFIDENCES.has(input.confidence))) {
      throw new TypeError('A valid answer and confidence are required.');
    }
    if (question.phase === 'delayed') {
      const { dueAt } = completion(lesson);
      if (dueAt === null || timestamp < dueAt) throw new RangeError('The delayed question is not available yet.');
    }
    return Object.freeze({
      id, timestamp, version, lessonId: lesson.id, conceptId: lesson.conceptId,
      sense: question.sense, phase: question.phase, questionId: question.id,
      answerId: known ? null : input.answerId,
      confidence: known ? null : input.confidence,
      reason,
      priorKnowledge: input.priorKnowledge,
      correct: known ? null : input.answerId === question.answerId,
      firstAttempt: !firstAnswers.has(attemptKey(lesson.id, question.id)),
    });
  }

  function append(attempt) {
    attempts.push(attempt);
    ids.add(attempt.id);
    if (attempt.firstAttempt) firstAnswers.set(attemptKey(attempt.lessonId, attempt.questionId), attempt);
  }

  function archive(stored) {
    // An older catalogue is unavailable, so preserve its well-formed evidence for export only.
    // Its correctness is historical data, never an input into this curriculum's scores.
    const known = stored.priorKnowledge === 'known';
    const reason = stored.reason === undefined ? '' : stored.reason;
    if (![stored.lessonId, stored.conceptId, stored.sense, stored.questionId].every(isText)
      || !isVersion(stored.version) || !['immediate', 'delayed'].includes(stored.phase)
      || !['known', 'new'].includes(stored.priorKnowledge) || typeof stored.firstAttempt !== 'boolean'
      || typeof reason !== 'string' || reason.length > 500 || (known && reason !== '')
      || (known ? stored.answerId !== null || stored.confidence !== null || stored.correct !== null
        : !isText(stored.answerId) || !CONFIDENCES.has(stored.confidence) || typeof stored.correct !== 'boolean')) return;
    archivedAttempts.push(Object.freeze({
      id: stored.id, timestamp: stored.timestamp, version: stored.version, lessonId: stored.lessonId,
      conceptId: stored.conceptId, sense: stored.sense, phase: stored.phase, questionId: stored.questionId,
      answerId: stored.answerId, confidence: stored.confidence, priorKnowledge: stored.priorKnowledge,
      correct: stored.correct, firstAttempt: stored.firstAttempt, reason,
    }));
    ids.add(stored.id);
  }

  // Read before writes and public reads so sequential activity in another tab is preserved.
  // localStorage does not provide an atomic transaction across simultaneous tabs; this is local
  // persistence, not cross-device synchronization.
  function synchronize() {
    if (!available) return;
    let raw;
    try { raw = persistence.getItem(LEARNING_STORAGE_KEY); } catch { available = false; return; }
    if (raw == null) return;
    let saved;
    try { saved = JSON.parse(raw); } catch { return; }
    if (saved?.schemaVersion !== SCHEMA_VERSION || !isVersion(saved.version) || !Array.isArray(saved.attempts)) return;

    const loadedAt = currentTime();
    // Persisted order breaks equal-timestamp ties. A later write appends after those existing
    // responses, even when both tabs' clocks have the same millisecond timestamp.
    const candidates = [
      ...saved.attempts.filter(attempt => attempt && isTimestamp(attempt.timestamp) && attempt.timestamp <= loadedAt),
      ...archivedAttempts, ...attempts,
    ].sort((a, b) => a.timestamp - b.timestamp);
    attempts.length = 0;
    archivedAttempts.length = 0;
    firstAnswers.clear();
    ids.clear();
    for (const stored of candidates) {
      if (!isText(stored.id) || ids.has(stored.id)) continue;
      if (stored.version !== version) {
        archive(stored);
        continue;
      }
      try {
        const candidate = makeAttempt(stored, stored.timestamp, stored.id);
        // Local storage is untrusted. Validate the catalogue identity and delayed gate, and
        // reconstruct derived correctness and first-attempt flags instead of trusting them.
        if (stored.conceptId !== candidate.conceptId || stored.sense !== candidate.sense || stored.phase !== candidate.phase
          || (stored.priorKnowledge === 'known' && (stored.answerId !== null || stored.confidence !== null))) continue;
        append(candidate);
      } catch { /* one damaged record must not discard valid local or remote evidence */ }
    }
  }

  function snapshot() {
    return {
      schemaVersion: SCHEMA_VERSION, version,
      attempts: [...archivedAttempts, ...attempts].sort((a, b) => a.timestamp - b.timestamp).map(attempt => ({ ...attempt })),
    };
  }

  function exportData() {
    synchronize();
    const exported = snapshot();
    // Labels help a reader interpret a download, but are never persisted or used for scoring.
    // An older curriculum may reuse ids with different wording, so its labels stay unavailable.
    exported.attempts = exported.attempts.map(attempt => {
      const lesson = attempt.version === version ? catalogue.get(attempt.lessonId) : null;
      const question = lesson?.questions.get(attempt.questionId);
      return {
        ...attempt,
        lessonTitle: lesson?.title ?? null,
        term: question?.term ?? null,
        prompt: question?.prompt ?? null,
        selectedAnswerText: question && attempt.answerId !== null ? question.optionTexts.get(attempt.answerId) ?? null : null,
        referenceAnswerText: question ? question.optionTexts.get(question.answerId) ?? null : null,
        kind: question?.kind ?? null,
        timestampIso: new Date(attempt.timestamp).toISOString(),
      };
    });
    return exported;
  }

  function persist() {
    if (!available) return;
    try { persistence.setItem(LEARNING_STORAGE_KEY, JSON.stringify(snapshot())); }
    catch { available = false; }
  }

  function recordAttempt(input) {
    if (!input || typeof input !== 'object') throw new TypeError('An attempt is required.');
    synchronize();
    const timestamp = currentTime();
    let id;
    do {
      sequence += 1;
      id = `attempt-${timestamp.toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    } while (ids.has(id));
    const attempt = makeAttempt(input, timestamp, id);
    append(attempt);
    persist();
    return attempt;
  }

  function getLessonProgress(lessonId) {
    synchronize();
    const lesson = findLesson(lessonId);
    const { answeredCount, completedAt, dueAt } = completion(lesson);
    return {
      lessonId, immediateCompleted: completedAt !== null, answeredCount,
      totalCount: lesson.immediateIds.length, completedAt, dueAt,
      delayedCompleted: firstAnswers.has(attemptKey(lessonId, lesson.delayedId)),
      attempts: Object.freeze(attempts.filter(attempt => attempt.lessonId === lessonId)),
    };
  }

  function getSummary() {
    synchronize();
    const summary = {
      transfer: { correct: 0, total: 0 }, boundary: { correct: 0, total: 0 }, delayed: { correct: 0, total: 0 },
      confidentErrors: 0, completedLessons: 0,
    };
    for (const attempt of firstAnswers.values()) {
      if (attempt.priorKnowledge !== 'new') continue;
      const question = catalogue.get(attempt.lessonId).questions.get(attempt.questionId);
      const score = summary[attempt.phase === 'delayed' ? 'delayed' : question.kind];
      score.total += 1;
      if (attempt.correct) score.correct += 1;
      if (attempt.confidence === 'high' && !attempt.correct) summary.confidentErrors += 1;
    }
    for (const lesson of catalogue.values()) if (completion(lesson).completedAt !== null) summary.completedLessons += 1;
    return summary;
  }

  synchronize();
  return {
    getAttempts() {
      synchronize();
      return Object.freeze([...attempts]);
    },
    getLessonProgress, getSummary, recordAttempt, exportData,
    canStartDelayed(lessonId) {
      synchronize();
      const { dueAt } = completion(findLesson(lessonId));
      return dueAt !== null && currentTime() >= dueAt;
    },
    get storageAvailable() { return available; },
  };
}
