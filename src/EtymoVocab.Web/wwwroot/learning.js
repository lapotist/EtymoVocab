import { LESSONS, LESSON_VERSION } from './lessons.js';
import { createLearningStore } from './learning-state.js';
import { createLearningDraftStore } from './learning-drafts.js';

// Lessons and attempts are independent of the live dictionary and its remembered-origin flags.
let storage;
try { storage = window.localStorage; } catch { /* continue with this tab's memory */ }
const store = createLearningStore({ storage, lessons: LESSONS, version: LESSON_VERSION });
let draftStorage;
try { draftStorage = window.sessionStorage; } catch { /* drafts can still last for this page */ }
const drafts = createLearningDraftStore({ storage: draftStorage, lessons: LESSONS, version: LESSON_VERSION });
const lessonHref = id => '#/learn/' + encodeURIComponent(id);
const timeLabel = time => new Date(time).toLocaleString('zh-TW', {
  year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'short',
});
const confidenceLabels = { low: '還不確定', medium: '有一些把握', high: '很有把握' };

export function createLearningView({ view, el }) {
  function go(lesson, phase) {
    const target = lessonHref(lesson.id) + (phase ? '/' + phase : '');
    if (location.hash === target) render(lesson.id, phase);
    else location.hash = target;
  }

  function show(...nodes) {
    view.replaceChildren(...nodes.filter(node => node != null && node !== false));
    const heading = view.querySelector('h1, h2');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function breadcrumbs(lesson) {
    return el('nav', { class: 'breadcrumbs', 'aria-label': '學習路徑' },
      el('a', { href: '#/' }, '首頁'), ' / ',
      lesson ? el('a', { href: '#/learn' }, '推論練習') : '推論練習',
      lesson ? ' / ' + lesson.title : null);
  }

  function storageNote() {
    return store.storageAvailable
      ? el('p', { class: 'muted small learning-storage' }, '已送出的作答儲存在這個瀏覽器。可匯出供自己回顧，尚無匯入功能；清除網站資料會移除記錄。')
      : el('p', { class: 'notice', role: 'status' }, '這個瀏覽器目前無法儲存作答。你仍可練習，但離開或重新整理後記錄可能消失；可先匯出供自己回顧，尚無匯入功能。');
  }

  function sources(items) {
    return el('details', { class: 'learning-sources' },
      el('summary', {}, '查看詞義與構詞來源'),
      el('ul', {}, items.map(source => el('li', {},
        el('a', { href: source.url, target: '_blank', rel: 'noopener' }, source.label)))),
      el('p', { class: 'muted small' }, '練習例句與中文說明為本專案編寫；詞義與構詞參考 Wiktionary（CC BY-SA 4.0）。來源是詞條依據，並非學習成效的證明。'));
  }

  function metric(title, score, description) {
    return el('div', { class: 'learning-metric' },
      el('dt', {}, title),
      el('dd', {}, `${score.correct} / ${score.total}`),
      el('p', {}, score.total ? description : '尚無作答記錄'));
  }

  function exportAttempts() {
    const blob = new Blob([JSON.stringify(store.exportData(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = el('a', { href: url, download: `etymovocab-learning-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderHub() {
    document.title = '推論練習 · EtymoVocab';
    const summary = store.getSummary();
    const hasAttempts = store.getAttempts().length > 0;
    const entries = LESSONS.map(lesson => ({ lesson, progress: store.getLessonProgress(lesson.id), due: store.canStartDelayed(lesson.id) }));
    const dueEntry = entries.find(entry => entry.due && !entry.progress.delayedCompleted);
    const unfinishedEntry = entries.find(entry => !entry.progress.immediateCompleted && (entry.progress.answeredCount > 0
      || entry.lesson.questions.some(question => drafts.get(entry.lesson.id, question.id, 'immediate'))));
    const nextEntry = dueEntry || unfinishedEntry || entries.find(entry => !entry.progress.immediateCompleted) || entries[0];
    const nextPhase = dueEntry ? 'followup' : unfinishedEntry ? 'challenge' : null;
    show(
      breadcrumbs(),
      el('section', { class: 'learning-hero' },
        el('p', { class: 'eyebrow' }, 'LEARN THE CONNECTION. TEST THE CLUE.'),
        el('h1', {}, '學會兩個字，', el('br'), '試著讀懂下一個。'),
        el('div', { class: 'learning-next' },
          el('p', {}, dueEntry ? '今天可以換個字，再試一次' : unfinishedEntry ? '接著完成上次的練習' : hasAttempts ? '接著探索另一個連結' : '第一次來？先從這一課試試'),
          el('a', { class: 'primary-link', href: lessonHref(nextEntry.lesson.id) + (nextPhase ? '/' + nextPhase : '') },
            `${dueEntry ? '開始新題回訪' : unfinishedEntry ? '繼續練習' : '開始練習'}：${nextEntry.lesson.title} →`)),
        el('p', { class: 'hero-description' }, '從熟悉的例子認識構詞，再用新句子檢驗推論。也練習辨認：什麼時候詞根能幫忙，什麼時候還需要語境。'),
        el('p', { class: 'muted small' }, `${LESSONS.length} 個短課程 · 每課 2 個例子、2 個挑戰 · 7 天後用另一個字回訪`)),
      hasAttempts ? el('section', { class: 'card learning-progress', 'aria-label': '首次作答記錄' },
        el('div', { class: 'learning-section-heading' },
          el('h2', {}, '你的推論記錄'),
          el('button', { type: 'button', class: 'secondary', onclick: exportAttempts }, '匯出作答記錄')),
        el('dl', { class: 'learning-metrics' },
          metric('首次詞義推論', summary.transfer, '答對 / 已作答'),
          metric('首次線索判斷', summary.boundary, '答對 / 已作答'),
          metric('七天後新題', summary.delayed, '答對 / 已作答'),
          el('div', { class: 'learning-metric' }, el('dt', {}, '高信心誤判'), el('dd', {}, summary.confidentErrors),
            el('p', {}, '首次作答中，很有把握但答錯'))),
        el('p', { class: 'muted small' }, '只計入本版課程第一次作答，且你表示尚不熟悉的題目。重練與「已知道」跳過會保留記錄，但不增加分數。這是練習結果，並非已驗證的單字能力分級。'), storageNote())
        : el('p', { class: 'muted small learning-empty-progress' }, '完成第一題後，這裡會顯示你的推論記錄。已送出的作答只儲存在這個瀏覽器。'),
      el('div', { class: 'learning-section-heading' }, el('h2', {}, '選一個連結，開始練習'),
        el('span', { class: 'muted small' }, `${summary.completedLessons} / ${LESSONS.length} 課已完成`)),
      el('div', { class: 'lesson-grid' }, entries.map(({ lesson, progress, due }, index) => {
        return el('article', { class: 'card lesson-card' },
          el('span', { class: 'lesson-number' }, String(index + 1).padStart(2, '0')),
          el('p', { class: 'lesson-concept', lang: 'en' }, lesson.concept.label),
          el('h3', {}, lesson.title),
          el('p', { class: 'muted' }, lesson.subtitle),
          el('p', { class: 'lesson-status' }, progress.immediateCompleted ? '初次練習已完成' : progress.answeredCount ? `已作答 ${progress.answeredCount} / ${progress.totalCount} 題` : '從兩個例子開始'),
          el('a', { class: 'primary-link', href: lessonHref(lesson.id) }, progress.immediateCompleted ? '查看課程與結果' : progress.answeredCount ? '繼續練習 →' : '開始這一課 →'),
          progress.immediateCompleted ? el('div', { class: 'lesson-followup' },
            progress.delayedCompleted ? el('span', {}, '✓ 七天後新題已完成')
              : due ? el('a', { href: lessonHref(lesson.id) + '/followup' }, '七天後新題已開放 →')
                : el('span', {}, `${timeLabel(progress.dueAt)} 開放新題回訪`)) : null);
      })),
      !store.storageAvailable ? storageNote() : null);
  }

  function lessonHeading(lesson, label) {
    return el('header', { class: 'learning-heading' },
      el('p', { class: 'eyebrow' }, label), el('h1', {}, lesson.title),
      el('p', { class: 'muted' }, lesson.subtitle));
  }

  function renderLesson(lesson, review = false) {
    document.title = `${lesson.title} · 推論練習 · EtymoVocab`;
    const progress = store.getLessonProgress(lesson.id);
    if (progress.immediateCompleted && !review) return renderSummary(lesson);
    show(breadcrumbs(lesson),
      el('div', { class: 'learning-reader' },
        lessonHeading(lesson, '01 / NOTICE THE PATTERN'),
        el('section', { class: 'card learning-concept' },
          el('p', { class: 'concept-label', lang: 'en' }, lesson.concept.label),
          el('h2', {}, lesson.concept.meaning), el('p', {}, lesson.concept.note)),
        el('div', { class: 'learning-examples' }, lesson.examples.map((example, index) =>
          el('article', { class: 'card learning-example' },
            el('span', { class: 'eyebrow' }, `例子 ${index + 1}`),
            el('h2', { lang: 'en' }, example.term),
            el('p', { class: 'example-breakdown', lang: 'en' }, example.breakdown),
            el('p', {}, example.meaning),
            el('blockquote', { lang: 'en' }, example.sentence), sources(example.sources)))),
        el('div', { class: 'learning-actions' },
          el('button', { type: 'button', onclick: () => go(lesson, progress.immediateCompleted ? 'practice' : 'challenge') }, progress.immediateCompleted ? '重練兩個挑戰 →' : progress.answeredCount ? '繼續剩下的挑戰 →' : '準備好了，開始挑戰 →'),
          el('a', { href: '#/learn' }, '回到課程列表')),
        el('p', { class: 'muted small' }, '挑戰會換一個字。先判斷是否已熟悉，再選答案與把握程度；送出後才會顯示解說。'),
        storageNote()));
  }

  function startImmediate(lesson, repeat = false) {
    const answered = new Set(store.getLessonProgress(lesson.id).attempts.filter(a => a.phase === 'immediate').map(a => a.questionId));
    const queue = repeat ? lesson.questions : lesson.questions.filter(q => !answered.has(q.id));
    if (!queue.length) return renderSummary(lesson);
    const draftedIndex = queue.findIndex(question => drafts.get(lesson.id, question.id, 'immediate'));
    renderQuestion(lesson, queue, draftedIndex < 0 ? 0 : draftedIndex, false);
  }

  function renderQuestion(lesson, queue, index, delayed) {
    const question = queue[index];
    const prior = store.getLessonProgress(lesson.id).attempts.some(a => a.questionId === question.id);
    const phase = delayed ? 'delayed' : 'immediate';
    const draft = drafts.get(lesson.id, question.id, phase);
    let answered = false;
    const body = el('div', { class: 'learning-question-body' });
    const stage = el('section', { class: 'card learning-question' },
      el('p', { class: 'eyebrow' }, delayed ? '七天後 / 換個字再試一次' : `挑戰 ${lesson.questions.findIndex(item => item.id === question.id) + 1} / ${lesson.questions.length}`),
      el('h1', { class: 'challenge-term', lang: 'en' }, question.term),
      el('blockquote', { class: 'challenge-sentence', lang: 'en' }, question.sentence),
      el('p', { class: 'challenge-prompt' }, question.prompt),
      prior ? el('p', { class: 'notice' }, '這題已作答過。本次是重練，會保留記錄，不計入首次成績。') : null,
      body);

    const record = values => {
      if (answered) return;
      let attempt;
      try {
        attempt = store.recordAttempt({ lessonId: lesson.id, questionId: question.id, ...values });
      } catch (error) {
        body.append(el('p', { class: 'notice', role: 'alert' }, `目前無法記錄這一題：${error.message}`));
        return;
      }
      answered = true;
      drafts.remove(lesson.id, question.id, phase);
      renderFeedback(lesson, question, attempt, () => {
        if (index + 1 < queue.length) renderQuestion(lesson, queue, index + 1, delayed);
        else renderSummary(lesson, delayed);
      }, index + 1 < queue.length ? '下一個挑戰 →' : '查看本課結果 →');
    };

    function showChoices(saved = null) {
      let selectedAnswer = saved?.answerId || null;
      let selectedConfidence = saved?.confidence || null;
      const reason = el('textarea', { id: 'learning-reason', name: 'reason', rows: '2', maxlength: '500', placeholder: '例如：某個字的部分，或句子裡的一個提示。' });
      reason.value = saved?.reason || '';
      const submit = el('button', { type: 'submit', disabled: true }, '確認答案與把握程度');
      const saveDraft = () => drafts.set({ lessonId: lesson.id, questionId: question.id, phase,
        answerId: selectedAnswer, confidence: selectedConfidence, reason: reason.value });
      const refresh = () => { submit.disabled = !selectedAnswer || !selectedConfidence; saveDraft(); };
      reason.addEventListener('input', saveDraft);
      const form = el('form', { class: 'learning-answer-form', onsubmit: event => {
        event.preventDefault();
        if (!selectedAnswer || !selectedConfidence) return;
        submit.disabled = true;
        record({ answerId: selectedAnswer, confidence: selectedConfidence, priorKnowledge: 'new', reason: reason.value });
      } },
      el('fieldset', { class: 'learning-options' }, el('legend', {}, '你的判斷'),
        question.options.map((option, optionIndex) => el('label', { class: 'learning-option' },
          el('input', { type: 'radio', name: 'answer', value: option.id, checked: selectedAnswer === option.id, required: true, onchange: () => { selectedAnswer = option.id; refresh(); } }),
          el('span', { class: 'option-letter', 'aria-hidden': 'true' }, String.fromCharCode(65 + optionIndex)),
          el('span', {}, option.text)))),
      el('fieldset', { class: 'learning-confidence' }, el('legend', {}, '這個判斷，你有多少把握？'),
        el('div', { class: 'confidence-options' }, Object.entries(confidenceLabels).map(([value, label]) =>
          el('label', { class: 'confidence-option' },
            el('input', { type: 'radio', name: 'confidence', value, checked: selectedConfidence === value, required: true, onchange: () => { selectedConfidence = value; refresh(); } }), label)))),
      el('details', { class: 'learning-reason', open: !!reason.value },
        el('summary', {}, '寫下我的線索（選填）'),
        el('label', { for: 'learning-reason' }, '哪個線索幫助了你？'), reason,
        el('p', { class: 'muted small' }, '保留自己的推論，送出後對照解說。這段文字不會自動評分。')),
      el('p', { class: 'muted small learning-draft-note', role: 'status' }, drafts.storageAvailable
        ? '未送出的答案會暫存在這個分頁，送出後才計入記錄。'
        : '未送出的答案只能保留在本頁，重新整理後可能消失。'),
      submit);
      body.replaceChildren(form);
      refresh();
      form.querySelector('input').focus({ preventScroll: true });
    }

    body.append(el('p', {}, '你已經知道這題的答案嗎？'),
      el('div', { class: 'learning-actions' },
        el('button', { type: 'button', onclick: () => showChoices() }, '還不熟悉，試著推論'),
        el('button', { type: 'button', class: 'secondary', onclick: () => record({ priorKnowledge: 'known', answerId: null, confidence: null }) }, '已經知道，跳過這題')),
      el('p', { class: 'muted small' }, '跳過不計分。詞義推論與線索判斷會分開記錄。'));
    show(breadcrumbs(lesson), el('div', { class: 'learning-reader' }, stage,
      el('a', { href: '#/learn' }, '先回課程列表'), storageNote()));
    if (draft) showChoices(draft);
  }

  function renderFeedback(lesson, question, attempt, next, nextLabel) {
    const known = attempt.priorKnowledge === 'known';
    const selected = question.options.find(o => o.id === attempt.answerId);
    const answer = question.options.find(o => o.id === question.answerId);
    show(breadcrumbs(lesson),
      el('div', { class: 'learning-reader' },
        el('section', { class: 'card learning-feedback', 'data-outcome': known ? 'skipped' : attempt.correct ? 'correct' : 'incorrect' },
          el('p', { class: 'eyebrow' }, known ? '已跳過 · 不計分' : attempt.correct ? '判斷正確' : '看看線索如何支持答案'),
          el('h1', { class: 'challenge-term', lang: 'en' }, question.term),
          el('blockquote', { class: 'challenge-sentence', lang: 'en' }, question.sentence),
          selected ? el('p', {}, `你的答案：${selected.text}（${confidenceLabels[attempt.confidence]}）`) : null,
          attempt.reason ? el('p', { class: 'feedback-reason' }, `你的線索：${attempt.reason}`) : null,
          el('p', { class: 'feedback-answer' }, `參考答案：${answer.text}`),
          el('p', {}, question.explanation),
          el('div', { class: 'feedback-clue' }, el('h2', {}, '這次可以用的線索'), el('p', {}, question.clue)),
          el('div', { class: 'feedback-boundary' }, el('h2', {}, '推論的界線'), el('p', {}, question.boundary)),
          !known && !attempt.correct && attempt.confidence === 'high'
            ? el('p', { class: 'notice' }, '這次很有把握，但答案需要修正。下次可以先用句子檢查構詞帶來的猜測。') : null,
          sources(question.sources),
          el('p', { class: 'muted small' }, known ? '這題保留為「已知道」記錄。' : attempt.firstAttempt ? '已記錄首次作答。答對這題代表這次判斷成功，並不代表整個字族都已熟練。' : '已記錄重練；首次成績維持原本結果。')),
        el('div', { class: 'learning-actions' },
          el('button', { type: 'button', onclick: next }, nextLabel),
          el('a', { href: '#/explore/' + encodeURIComponent(question.term), target: '_blank', rel: 'noopener' }, '另開詞源地圖 ↗')),
        storageNote()));
  }

  function answerStatus(attempt) {
    return attempt.priorKnowledge === 'known' ? '已知道 · 不計分' : attempt.correct ? '答對' : '答錯';
  }

  function reviewAttempts(question, attempts) {
    const answer = question.options.find(option => option.id === question.answerId);
    return el('details', { class: 'attempt-review' },
      el('summary', {}, `回看解說與 ${attempts.length} 次作答`),
      el('blockquote', { lang: 'en' }, question.sentence),
      el('p', {}, question.prompt),
      el('p', { class: 'feedback-answer' }, `參考答案：${answer.text}`),
      el('p', {}, question.explanation),
      el('div', { class: 'feedback-clue' }, el('h3', {}, '這次可以用的線索'), el('p', {}, question.clue)),
      el('div', { class: 'feedback-boundary' }, el('h3', {}, '推論的界線'), el('p', {}, question.boundary)),
      el('ol', { class: 'attempt-history' }, [...attempts].reverse().map(attempt => {
        const selected = question.options.find(option => option.id === attempt.answerId);
        return el('li', {},
          el('p', { class: 'attempt-time' }, `${attempt.firstAttempt ? '首次作答' : '再次練習'} · ${timeLabel(attempt.timestamp)}`),
          el('p', {}, `${answerStatus(attempt)}${selected ? ` · 你的答案：${selected.text}` : ''}`),
          attempt.confidence ? el('p', {}, `把握程度：${confidenceLabels[attempt.confidence]}`) : null,
          attempt.reason ? el('p', { class: 'feedback-reason' }, `你的線索：${attempt.reason}`) : null);
      })), sources(question.sources));
  }

  function renderSummary(lesson, delayed = false) {
    const progress = store.getLessonProgress(lesson.id);
    const immediate = progress.attempts.filter(a => a.phase === 'immediate' && a.firstAttempt);
    const scored = immediate.filter(a => a.priorKnowledge === 'new');
    const due = store.canStartDelayed(lesson.id);
    show(breadcrumbs(lesson), el('div', { class: 'learning-reader' },
      lessonHeading(lesson, delayed ? 'FOLLOW-UP / 回訪完成' : 'REFLECT / 本課記錄'),
      el('section', { class: 'card learning-summary' },
        el('h2', {}, '每個答案，都留下可回看的線索'),
        el('p', { class: 'summary-score' }, `${scored.filter(a => a.correct).length} / ${scored.length}`, el('span', {}, ' 初次練習答對')),
        el('p', { class: 'muted small' }, `${immediate.filter(a => a.priorKnowledge === 'known').length} 題標記為已知道，不計分。詞義推論與線索判斷的分項結果可在總覽查看。`),
        el('ul', { class: 'learning-results' }, lesson.questions.map(question => {
          const attempt = immediate.find(a => a.questionId === question.id);
          const history = progress.attempts.filter(item => item.questionId === question.id);
          const latest = history.at(-1);
          return el('li', {},
            el('span', {}, question.kind === 'transfer' ? '詞義推論' : '線索判斷'),
            el('strong', { lang: 'en' }, question.term),
            el('div', { class: 'attempt-status' },
              el('span', {}, attempt ? `首次：${answerStatus(attempt)}` : '尚未作答'),
              history.length > 1 ? el('span', { class: 'latest-practice' }, `最近練習：${answerStatus(latest)}`) : null),
            history.length ? reviewAttempts(question, history) : null);
        })),
        el('p', {}, '能說出構詞只是第一步。下一次，用不同的字和句子檢查這個連結是否仍然有幫助。')),
      el('section', { class: 'card followup-card' },
        el('h2', {}, '七天後，換一個字'),
        progress.delayedCompleted
          ? el('p', {}, (() => {
            const result = progress.attempts.find(a => a.phase === 'delayed' && a.firstAttempt);
            return result?.priorKnowledge === 'known' ? '新題已標記為「已知道」，不計分。' : result?.correct ? '首次回訪推論成功，已記錄結果。' : '首次回訪需要再練習，已記錄結果。';
          })())
          : el('p', {}, due ? '現在可以挑戰另一個字。先試著回想，再看解說。' : `${timeLabel(progress.dueAt)} 開放不同的新題（依裝置當地時間）。這段期間可以繼續探索其他課程。`),
        progress.delayedCompleted ? reviewAttempts(lesson.delayed, progress.attempts.filter(attempt => attempt.phase === 'delayed')) : null,
        due ? el('a', { class: 'primary-link', href: lessonHref(lesson.id) + '/followup', onclick: event => {
          if (location.hash === lessonHref(lesson.id) + '/followup') {
            event.preventDefault();
            renderFollowup(lesson);
          }
        } }, progress.delayedCompleted ? '重練回訪題' : '開始新題回訪 →') : null),
      el('div', { class: 'learning-actions' },
        el('a', { class: 'primary-link', href: '#/learn' }, '回到學習總覽'),
        el('button', { type: 'button', class: 'secondary', onclick: () => go(lesson, 'examples') }, '回看兩個例子'),
        el('button', { type: 'button', class: 'secondary', onclick: () => go(lesson, 'practice') }, '再練一次（不計首次成績）')),
      storageNote()));
  }

  function renderFollowup(lesson) {
    document.title = `${lesson.title} · 七天後新題 · EtymoVocab`;
    const progress = store.getLessonProgress(lesson.id);
    if (!store.canStartDelayed(lesson.id)) {
      show(breadcrumbs(lesson), el('div', { class: 'learning-reader card' },
        el('h1', {}, '讓這個連結隔幾天，再試一次'),
        el('p', {}, progress.immediateCompleted ? `${timeLabel(progress.dueAt)} 開放新題回訪（依裝置當地時間）。題目會在那時出現。` : '先完成本課的兩個挑戰，七天後會開放另一個字的新題。'),
        el('a', { class: 'primary-link', href: lessonHref(lesson.id) }, '回到這一課')));
      return;
    }
    renderQuestion(lesson, [lesson.delayed], 0, true);
  }

  function render(lessonId, phase) {
      if (!lessonId) return renderHub();
      const lesson = LESSONS.find(candidate => candidate.id === lessonId);
      if (!lesson || (phase && !['followup', 'challenge', 'practice', 'examples'].includes(phase))) {
        document.title = '找不到課程 · EtymoVocab';
        show(breadcrumbs(), el('div', { class: 'card' }, el('h1', {}, '找不到這個課程'), el('a', { href: '#/learn' }, '查看所有推論練習')));
        return;
      }
      if (phase === 'followup') return renderFollowup(lesson);
      if (phase === 'challenge' || phase === 'practice') return startImmediate(lesson, phase === 'practice');
      return renderLesson(lesson, phase === 'examples');
  }

  return { render };
}
