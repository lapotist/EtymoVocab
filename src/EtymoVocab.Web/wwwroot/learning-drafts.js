// Unsubmitted learner input belongs to this tab, separate from scored attempts.
export const LEARNING_DRAFT_STORAGE_KEY = 'etymovocab.learning-drafts.v1';
const SCHEMA_VERSION = 1;
const CONFIDENCES = new Set(['low', 'medium', 'high']);
const isText = value => typeof value === 'string' && value.trim().length > 0;
const isVersion = value => isText(value) || (typeof value === 'number' && Number.isFinite(value));
const draftKey = (lessonId, questionId, phase) => JSON.stringify([lessonId, questionId, phase]);

export function createLearningDraftStore({ storage, lessons, version }) {
  if (!isVersion(version) || !Array.isArray(lessons)) {
    throw new TypeError('A lesson catalogue and curriculum version are required.');
  }

  // Snapshot identity and option ids only. Draft persistence must never copy teaching content
  // or the correct answer from the catalogue.
  const catalogue = new Map();
  for (const lesson of lessons) {
    if (!isText(lesson?.id) || catalogue.has(lesson.id)
      || !Array.isArray(lesson.questions) || !lesson.questions.length || !lesson.delayed) {
      throw new TypeError('Each lesson needs a unique id and immediate and delayed questions.');
    }
    const questions = new Map();
    const addQuestion = (question, phase) => {
      if (!isText(question?.id) || questions.has(question.id)
        || !Array.isArray(question.options) || question.options.length < 2) {
        throw new TypeError('Questions need unique ids and answer options.');
      }
      const options = new Set();
      for (const option of question.options) {
        if (!isText(option?.id) || options.has(option.id)) throw new TypeError('Answer option ids must be unique.');
        options.add(option.id);
      }
      questions.set(question.id, { phase, options });
    };
    lesson.questions.forEach(question => addQuestion(question, 'immediate'));
    addQuestion(lesson.delayed, 'delayed');
    catalogue.set(lesson.id, questions);
  }

  function validateIdentity(lessonId, questionId, phase) {
    const question = catalogue.get(lessonId)?.get(questionId);
    if (!question || !['immediate', 'delayed'].includes(phase) || question.phase !== phase) {
      throw new TypeError('A known question and its matching phase are required.');
    }
    return question;
  }

  function normalize(input) {
    if (!input || typeof input !== 'object') throw new TypeError('A draft is required.');
    const { lessonId, questionId, phase, answerId = null, confidence = null, reason = '' } = input;
    const question = validateIdentity(lessonId, questionId, phase);
    if ((answerId !== null && !question.options.has(answerId))
      || (confidence !== null && !CONFIDENCES.has(confidence))
      || typeof reason !== 'string' || reason.length > 500) {
      throw new TypeError('A draft needs a valid selected option, confidence, and rationale of at most 500 characters.');
    }
    return Object.freeze({ lessonId, questionId, phase, answerId, confidence, reason });
  }

  let available = true;
  let persistence = storage;
  if (persistence === undefined) {
    try { persistence = globalThis.sessionStorage; } catch { available = false; }
  }
  if (!persistence || typeof persistence.getItem !== 'function' || typeof persistence.setItem !== 'function') available = false;
  const drafts = new Map();

  if (available) {
    let raw;
    try { raw = persistence.getItem(LEARNING_DRAFT_STORAGE_KEY); } catch { available = false; }
    if (raw != null) {
      let saved;
      try { saved = JSON.parse(raw); } catch { /* discard corrupt draft data */ }
      if (saved?.schemaVersion === SCHEMA_VERSION && saved.version === version && Array.isArray(saved.drafts)) {
        for (const row of saved.drafts) {
          try {
            const draft = normalize(row);
            drafts.set(draftKey(draft.lessonId, draft.questionId, draft.phase), draft);
          } catch { /* malformed or outdated questions cannot restore a draft */ }
        }
      }
    }
  }

  function persist() {
    if (!available) return;
    try {
      persistence.setItem(LEARNING_DRAFT_STORAGE_KEY, JSON.stringify({
        schemaVersion: SCHEMA_VERSION, version, drafts: [...drafts.values()],
      }));
    } catch { available = false; }
  }

  return Object.freeze({
    get storageAvailable() { return available; },
    get(lessonId, questionId, phase) {
      validateIdentity(lessonId, questionId, phase);
      const draft = drafts.get(draftKey(lessonId, questionId, phase));
      return draft ? Object.freeze({ ...draft }) : null;
    },
    set(input) {
      const draft = normalize(input);
      drafts.set(draftKey(draft.lessonId, draft.questionId, draft.phase), draft);
      persist();
      return Object.freeze({ ...draft });
    },
    remove(lessonId, questionId, phase) {
      validateIdentity(lessonId, questionId, phase);
      if (drafts.delete(draftKey(lessonId, questionId, phase))) persist();
    },
  });
}
