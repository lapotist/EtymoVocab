import test from 'node:test';
import assert from 'node:assert/strict';
import { LESSONS, LESSON_VERSION } from '../../src/EtymoVocab.Web/wwwroot/lessons.js';
import { createLearningStore } from '../../src/EtymoVocab.Web/wwwroot/learning-state.js';

const nonempty = value => assert.ok(typeof value === 'string' && value.trim().length, 'expected nonempty authored text');
const hasWord = (text, term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);

function checkSources(sources) {
  assert.ok(Array.isArray(sources) && sources.length > 0, 'each example and assessment needs a source');
  for (const source of sources) {
    nonempty(source.label);
    const url = new URL(source.url);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, 'en.wiktionary.org');
  }
}

test('curriculum contains distinct, sourced concepts and complete question explanations', () => {
  nonempty(LESSON_VERSION);
  assert.ok(LESSONS.length >= 10);
  const ids = new Set();
  const concepts = new Set();
  const questionIds = new Set();
  const terms = new Set();
  for (const lesson of LESSONS) {
    assert.ok(!ids.has(lesson.id));
    ids.add(lesson.id);
    assert.ok(!concepts.has(lesson.concept.id));
    concepts.add(lesson.concept.id);
    [lesson.id, lesson.title, lesson.subtitle, ...Object.values(lesson.concept)].forEach(nonempty);
    assert.equal(lesson.examples.length, 2);
    assert.deepEqual(lesson.questions.map(q => q.kind).sort(), ['boundary', 'transfer']);
    assert.equal(lesson.delayed.kind, 'transfer');
    for (const example of lesson.examples) {
      [example.term, example.sense, example.meaning, example.breakdown, example.sentence].forEach(nonempty);
      checkSources(example.sources);
    }
    for (const question of [...lesson.questions, lesson.delayed]) {
      assert.ok(!questionIds.has(question.id), `duplicate question ${question.id}`);
      questionIds.add(question.id);
      [question.id, question.sense, question.term, question.prompt, question.sentence,
        question.explanation, question.clue, question.boundary].forEach(nonempty);
      assert.ok(question.options.length >= 3, 'provide plausible alternative interpretations');
      assert.equal(new Set(question.options.map(o => o.id)).size, question.options.length);
      assert.equal(new Set(question.options.map(o => o.text)).size, question.options.length);
      assert.equal(question.options.filter(o => o.id === question.answerId).length, 1);
      question.options.forEach(option => { nonempty(option.id); nonempty(option.text); });
      checkSources(question.sources);
    }
    for (const item of [...lesson.examples, ...lesson.questions, lesson.delayed]) {
      assert.ok(!terms.has(item.term.toLowerCase()), `assessment/teaching term reused: ${item.term}`);
      terms.add(item.term.toLowerCase());
    }
  }
  assert.doesNotThrow(() => createLearningStore({ lessons: LESSONS, version: LESSON_VERSION, storage: null }));
});

test('initial teaching never exposes assessment words and all delayed words remain reserved', () => {
  const teaching = JSON.stringify(LESSONS.map(({ id, title, subtitle, concept, examples }) => ({ id, title, subtitle, concept, examples })));
  const immediateContent = JSON.stringify(LESSONS.map(({ delayed, ...lesson }) => lesson));
  for (const lesson of LESSONS) {
    for (const question of lesson.questions) {
      assert.equal(hasWord(teaching, question.term), false, `${question.term} appears before the assessment`);
    }
    assert.equal(hasWord(immediateContent, lesson.delayed.term), false, `${lesson.delayed.term} leaks before the delayed assessment`);
  }
});

test('correct option positions vary, including in the boundary exercises', () => {
  for (const select of [lesson => lesson.questions[0], lesson => lesson.questions[1], lesson => lesson.delayed]) {
    const positions = new Set(LESSONS.map(lesson => {
      const question = select(lesson);
      return question.options.findIndex(o => o.id === question.answerId);
    }));
    assert.ok(positions.size >= 3, 'answer position must not reveal the solution across lessons');
  }
});
