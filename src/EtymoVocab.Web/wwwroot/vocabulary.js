import { parseBulkWords, runBulkLookup } from './bulk-lookup.js';
import { normalizeSavedWord } from './saved-words.js';

const labels = { synonym: '同義詞', antonym: '反義詞' };

export function createVocabularyView({ view, el, store, lookup, lookupBatch, preload, wordHref, exploreHref, sourceNote, inflectionNote, posNames }) {
  let generation = 0;
  let controller;
  let collectionChanged;
  let savedKeys = new Set(store.list().map(item => item.key));
  const batch = { text: '', words: [], results: [], pending: [], busy: false, message: '', retryAt: 0, filter: '', kind: '' };

  function refreshCollection() {
    const words = store.list();
    savedKeys = new Set(words.map(item => item.key));
    document.querySelectorAll('button[data-save-word]').forEach(button => {
      const saved = savedKeys.has(normalizeSavedWord(button.dataset.saveWord).key);
      button.textContent = saved ? '已收藏' : '＋ 收藏';
      button.setAttribute('aria-pressed', String(saved));
      button.setAttribute('aria-label', `${saved ? '取消收藏' : '收藏'} ${button.dataset.saveWord}`);
    });
    const count = document.getElementById('saved-count');
    if (count) count.textContent = String(words.length);
    if (!store.storageAvailable && !view.querySelector('[data-collection-storage]')) view.prepend(storageNote());
    view.querySelectorAll('[data-collection-storage]').forEach(note => {
      note.textContent = storageMessage();
      note.className = store.storageAvailable ? 'muted small' : 'notice';
      if (!store.storageAvailable) note.setAttribute('role', 'status');
    });
    collectionChanged?.();
  }
  store.subscribe(refreshCollection);
  refreshCollection();

  function saveButton(word, context = {}) {
    let normalized;
    try { normalized = normalizeSavedWord(word); }
    catch { return el('button', { type: 'button', class: 'save-word', disabled: true }, '無法收藏'); }
    const limits = { query: 200, sourceWord: 200, pos: 80, sense: 500, etymologyId: 200, sourceUrl: 2048 };
    const provenance = { relation: context.relation || null };
    for (const [field, limit] of Object.entries(limits)) {
      provenance[field] = typeof context[field] === 'string' ? context[field].replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, limit) : null;
    }
    const saved = savedKeys.has(normalized.key);
    const button = el('button', {
      type: 'button', class: 'save-word', 'data-save-word': word,
      'aria-pressed': String(saved), 'aria-label': `${saved ? '取消收藏' : '收藏'} ${word}`,
      onclick: () => {
        if (store.has(word)) store.remove(word);
        else store.save(word, provenance);
      },
    }, saved ? '已收藏' : '＋ 收藏');
    return button;
  }

  function storageMessage() {
    return store.storageAvailable ? '收藏只儲存在這個瀏覽器；可匯出記錄，清除網站資料會移除收藏。'
      : '目前無法永久儲存收藏，本次仍可使用。離開前可匯出記錄。';
  }

  function storageNote() {
    return el('p', { class: store.storageAvailable ? 'muted small' : 'notice', 'data-collection-storage': '', role: store.storageAvailable ? null : 'status' }, storageMessage());
  }

  function show(...nodes) {
    view.replaceChildren(...nodes.filter(node => node != null));
    const heading = view.querySelector('h1');
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(store.exportData(), null, 2)], { type: 'application/json' }));
    const anchor = el('a', { href: url, download: 'etymovocab-saved-words.json' });
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function termChip(term, context) {
    return el('div', { class: 'discovery-word' },
      el('a', { class: 'pick-word', href: wordHref(term), target: '_blank', rel: 'noopener', title: `另開 ${term} 的同反義詞` }, term),
      saveButton(term, context));
  }

  function relationColumns(data, query) {
    const groups = (data.etymologies || []).flatMap(ety => (ety.partsOfSpeech || []).flatMap(part =>
      (part.relations || []).filter(relation => labels[relation.kind]).map(relation => ({ ...relation,
        pos: part.pos, etymologyId: String(ety.id || ety.number || ''), definition: part.senses?.[0] || '',
      }))));
    const needle = batch.filter.trim().toLocaleLowerCase();
    return el('div', { class: 'relation-columns bulk-columns' }, ['synonym', 'antonym'].filter(kind => !batch.kind || batch.kind === kind).map(kind => {
      const matching = groups.filter(group => group.kind === kind).map(group => ({ ...group,
        terms: group.terms.filter(term => !needle || term.toLocaleLowerCase().includes(needle)),
      })).filter(group => group.terms.length);
      const listed = groups.some(group => group.kind === kind && group.terms.length);
      return el('section', { class: 'relation-column ' + kind },
        el('div', { class: 'relation-heading' }, el('h3', {}, labels[kind]),
          el('span', { class: 'count' }, new Set(matching.flatMap(group => group.terms)).size)),
        matching.length ? matching.map(group => el('div', { class: 'relation-group' },
          el('p', { class: 'relation-sense' }, el('span', { class: 'pos-tag' }, posNames[group.pos] || group.pos),
            group.etymologyId ? ` · 詞源 ${group.etymologyId}` : '', ' · ', group.sense || group.definition || '未標示詞義'),
          el('div', { class: 'chips' }, group.terms.map(term => termChip(term, {
            query, sourceWord: data.word, relation: kind, pos: group.pos, sense: group.sense,
            etymologyId: group.etymologyId, sourceUrl: data.source?.url,
          })))))
          : el('p', { class: 'muted small' }, listed ? '沒有符合篩選的單字。' : `Wiktionary 本詞條未列出${labels[kind]}。`));
    }));
  }

  function renderBulk() {
    // Visiting search is an explicit signal of intent; overlap runtime download with reading/typing.
    if (preload) Promise.resolve().then(preload).catch(() => {});
    const current = generation;
    document.title = '批次查同反義詞 · EtymoVocab';
    const text = el('textarea', { id: 'bulk-words', rows: '4', maxlength: '10000', spellcheck: 'false', autocapitalize: 'off',
      placeholder: 'nice\ninspect\nbank', 'aria-describedby': 'bulk-help', oninput: () => { batch.text = text.value; } });
    text.value = batch.text;
    const status = el('p', { class: 'bulk-status muted', role: 'status', 'aria-live': 'polite' }, batch.message);
    const results = el('div', { class: 'bulk-results', 'aria-live': 'off' });
    const start = el('button', { type: 'submit' }, '查詢這些單字');
    const stop = el('button', { type: 'button', class: 'secondary', disabled: true, onclick: stopBatch }, '停止查詢');
    const resume = el('button', { type: 'button', class: 'secondary', hidden: true, onclick: () => {
      if (Date.now() < batch.retryAt) {
        status.textContent = `請再等約 ${Math.ceil((batch.retryAt - Date.now()) / 1000)} 秒，再重試未完成的查詢。`;
        return;
      }
      const words = [...batch.pending];
      if (words.length) execute(words, true);
    } }, '重試未完成的查詢');
    const filter = el('input', { type: 'search', 'aria-label': '篩選結果中的單字', placeholder: '篩選找到的單字', oninput: () => { batch.filter = filter.value; drawResults(); } });
    filter.value = batch.filter;
    const kind = el('select', { 'aria-label': '顯示關係', onchange: () => { batch.kind = kind.value; drawResults(); } },
      el('option', { value: '' }, '同義與反義'), el('option', { value: 'synonym' }, '只看同義詞'), el('option', { value: 'antonym' }, '只看反義詞'));
    kind.value = batch.kind;

    const renderedRows = new Map();

    function resultCard(word, result) {
      if (!result) return el('section', { class: 'card bulk-result', 'data-query': word },
        el('h2', {}, word), el('p', { class: 'muted small' }, batch.busy ? '等待查詢…' : '尚未完成，可重試這個查詢。'));
      if (result.status === 'error') return el('section', { class: 'card bulk-result', 'data-query': word },
        el('h2', {}, word), el('p', { class: 'notice' }, result.error?.message || '這個字暫時無法查詢。'));
      const data = result.data;
      if (!data) return el('section', { class: 'card bulk-result', 'data-query': word },
        el('h2', {}, word), el('p', { class: 'muted small' }, 'Wiktionary 沒有可顯示的詞條資料。'));
      return el('section', { class: 'card bulk-result', 'data-query': word },
        el('div', { class: 'bulk-word-heading' }, el('h2', {}, word === data.word ? data.word : `${word} → ${data.word}`),
          el('div', { class: 'chips' }, saveButton(data.word, { query: word, sourceWord: data.word, sourceUrl: data.source?.url }),
            el('a', { href: exploreHref(data.word), target: '_blank', rel: 'noopener' }, '另開詞源地圖 ↗'))),
        inflectionNote(data),
        ...(data.warnings || []).map(warning => el('p', { class: 'notice' }, warning)),
        relationColumns(data, word), data.source ? sourceNote(data) : null);
    }

    function drawResults() {
      const focusWord = results.contains(document.activeElement) ? document.activeElement?.dataset.saveWord : null;
      const focusQuery = focusWord ? document.activeElement.closest('[data-query]')?.dataset.query : null;
      const present = new Set(batch.words);
      for (const [word, row] of renderedRows) {
        if (!present.has(word)) {
          row.node.remove();
          renderedRows.delete(word);
        }
      }
      batch.words.forEach((word, index) => {
        const result = batch.results[index];
        const row = renderedRows.get(word);
        // Completed rows do not change when another word arrives or the queue stops. Keeping
        // their DOM also preserves keyboard focus and avoids rebuilding hundreds of save controls.
        const changed = !row || row.result !== result
          || (!result && row.busy !== batch.busy)
          || (result?.data && (row.filter !== batch.filter || row.kind !== batch.kind));
        let node = row?.node;
        if (changed) {
          node = resultCard(word, result);
          row?.node.replaceWith(node);
          renderedRows.set(word, { node, result, busy: batch.busy, filter: batch.filter, kind: batch.kind });
        }
        if (results.children[index] !== node) results.insertBefore(node, results.children[index] || null);
      });
      if (focusWord && document.activeElement?.dataset.saveWord !== focusWord) {
        [...results.querySelectorAll('[data-save-word]')].find(button => button.dataset.saveWord === focusWord
          && button.closest('[data-query]')?.dataset.query === focusQuery)?.focus({ preventScroll: true });
      }
    }

    function controls() {
      start.disabled = batch.busy;
      text.disabled = batch.busy;
      stop.disabled = !batch.busy;
      resume.hidden = !batch.pending.length || batch.busy;
    }

    function stopBatch() {
      controller?.abort(); controller = null;
      batch.busy = false;
      batch.pending = batch.words.filter((word, index) => !batch.results[index] || batch.results[index].rateLimited);
      batch.message = '已停止後續查詢，已取得的結果會保留。';
      status.textContent = batch.message;
      controls(); drawResults();
    }

    async function execute(words, append) {
      if (batch.busy || generation !== current) return;
      if (Date.now() < batch.retryAt) {
        status.textContent = `請再等約 ${Math.ceil((batch.retryAt - Date.now()) / 1000)} 秒再查詢。`;
        return;
      }
      batch.retryAt = 0;
      batch.busy = true;
      batch.pending = [];
      if (!append) { batch.words = words; batch.results = words.map(() => null); }
      const positions = words.map(word => batch.words.indexOf(word));
      if (append) positions.forEach(index => { batch.results[index] = null; });
      const active = new AbortController();
      controller = active;
      controls(); drawResults();
      status.textContent = `正在查詢 ${words.length} 個單字…`;
      try {
        const outcome = await runBulkLookup(words, { lookup, lookupBatch, signal: active.signal,
          onResult: result => {
            if (generation !== current || controller !== active) return;
            if (result.rateLimited && result.error?.retryAfter) {
              batch.retryAt = Math.max(batch.retryAt, Date.now() + result.error.retryAfter * 1000);
            }
            batch.results[positions[result.index]] = result;
            drawResults();
          },
          onProgress: progress => {
            if (generation === current && controller === active) status.textContent = `本次已完成 ${progress.completed} / ${progress.total} 個查詢；可先收藏已出現的單字。`;
          },
        });
        if (generation !== current || controller !== active) return;
        batch.pending = outcome.rateLimited ? outcome.retryable : outcome.pending;
        if (!outcome.rateLimited) batch.retryAt = 0;
        batch.message = outcome.rateLimited
          ? `Wiktionary 暫時限流，已暫停後續查詢。已取得的結果會保留${outcome.retryAfter ? `；請至少等 ${outcome.retryAfter} 秒再重試` : ''}。`
          : outcome.cancelled ? '已停止後續查詢，已取得的結果會保留。'
            : `已完成 ${batch.words.length} 個查詢。按「＋ 收藏」挑出你想留下的字。`;
      } catch (error) {
        if (generation !== current || controller !== active) return;
        batch.message = error.message || '批次查詢暫時無法完成。';
        batch.pending = words.filter((word, index) => !batch.results[positions[index]]);
      } finally {
        if (generation === current && controller === active) {
          batch.busy = false; controller = null;
          status.textContent = batch.message; controls(); drawResults();
        }
      }
    }

    const form = el('form', { class: 'card bulk-form', onsubmit: event => {
      event.preventDefault();
      const parsed = parseBulkWords(text.value);
      if (!parsed.words.length || parsed.overflow.length || parsed.invalid.length) {
        status.textContent = parsed.overflow.length ? '一次最多查 20 個不同的單字，請分成幾批查詢。'
          : parsed.invalid.length ? `請檢查輸入：${parsed.invalid[0].term}。請輸入不超過 200 字元的單字或片語，不要貼網址或特殊標記。` : '請先輸入要查詢的單字。';
        return;
      }
      batch.text = text.value;
      execute(parsed.words, false);
    } }, el('label', { for: 'bulk-words' }, '要掃描哪些單字？'), text,
    el('p', { id: 'bulk-help', class: 'muted small' }, '每行一個，也可用逗號或分號分隔；片語保留空格。一次最多 20 個不同的單字，重複項目只查一次。'),
    el('div', { class: 'bulk-actions' }, start, stop, resume), status);
    show(el('nav', { class: 'breadcrumbs', 'aria-label': '目前位置' }, el('a', { href: '#/' }, '首頁'), ' / 批次查詢'),
      el('div', { class: 'page-heading' }, el('div', {}, el('p', { class: 'eyebrow' }, 'SCAN WORDS. KEEP WHAT INTERESTS YOU.'),
        el('h1', {}, '一次掃描，多個單字。'), el('p', { class: 'muted' }, '並排比較同反義詞，收藏想學的字；詞源關係留在詞源地圖探索。')),
        el('a', { href: '#/saved', class: 'primary-link' }, '查看我的收藏 →')),
      form, el('div', { class: 'filter-row' }, filter, kind), results, storageNote());
    controls(); drawResults();
  }

  function renderSaved() {
    document.title = '收藏單字 · EtymoVocab';
    const list = el('div', { class: 'saved-word-list' });
    const count = el('p', { class: 'muted small', role: 'status' });
    const filter = el('input', { type: 'search', placeholder: '篩選收藏單字', 'aria-label': '篩選收藏單字', oninput: draw });
    const exportButton = el('button', { type: 'button', class: 'secondary', onclick: download }, '匯出收藏');
    function draw() {
      const needle = filter.value.trim().toLocaleLowerCase();
      const all = store.list();
      const words = all.filter(item => item.word.toLocaleLowerCase().includes(needle));
      count.textContent = `顯示 ${words.length} / ${all.length} 個收藏單字`;
      exportButton.disabled = !all.length;
      list.replaceChildren(...(words.length ? words.map(item => el('article', { class: 'card saved-word', 'data-saved-word': item.word },
        el('div', { class: 'bulk-word-heading' }, el('h2', { lang: 'en' }, item.word),
          el('button', { type: 'button', class: 'secondary', 'aria-label': `移除收藏 ${item.word}`, onclick: () => {
            store.remove(item.word);
            filter.focus({ preventScroll: true });
          } }, '移除收藏')),
        el('div', { class: 'chips' }, el('a', { href: wordHref(item.word) }, '查同義與反義'), el('a', { href: exploreHref(item.word) }, '探索詞源')),
        item.contexts.length ? el('details', { class: 'saved-contexts' }, el('summary', {}, '回看收藏時的線索'),
          el('ul', {}, item.contexts.map(context => el('li', {},
            context.sourceWord || context.query || '單字查詢', context.relation ? ` · ${labels[context.relation]}` : '',
            context.pos ? ` · ${posNames[context.pos] || context.pos}` : '', context.sense ? ` · ${context.sense}` : '',
            context.sourceUrl ? el('a', { href: context.sourceUrl, target: '_blank', rel: 'noopener' }, ' 詞條來源 ↗') : null)))) : null))
        : [el('div', { class: 'card empty-state' }, el('h2', {}, all.length ? '沒有符合篩選的收藏' : '從感興趣的字，建立你的清單'),
          el('p', {}, '在單字查詢或批次結果按「＋ 收藏」。收藏代表你想留下這個字，不表示它和其他收藏字有共同詞源。'),
          el('a', { class: 'primary-link', href: '#/bulk' }, '批次找單字 →'))]));
    }
    collectionChanged = () => { if (list.isConnected) draw(); };
    show(el('nav', { class: 'breadcrumbs', 'aria-label': '目前位置' }, el('a', { href: '#/' }, '首頁'), ' / 收藏單字'),
      el('div', { class: 'page-heading' }, el('div', {}, el('p', { class: 'eyebrow' }, 'YOUR WORDS, YOUR COLLECTION'), el('h1', {}, '收藏想學的字。')),
        el('div', { class: 'bulk-actions' }, el('a', { href: '#/bulk', class: 'primary-link' }, '繼續批次找字 →'), exportButton)),
      storageNote(), el('div', { class: 'filter-row' }, filter), count, list);
    draw();
  }

  function leave() {
    generation += 1;
    controller?.abort(); controller = null;
    if (batch.busy) {
      batch.busy = false;
      batch.pending = batch.words.filter((word, index) => !batch.results[index] || batch.results[index].rateLimited);
      batch.message = '已停止離開頁面前尚未完成的查詢；已取得的結果會保留。';
    }
    collectionChanged = null;
  }

  return { renderBulk, renderSaved, saveButton, leave };
}
