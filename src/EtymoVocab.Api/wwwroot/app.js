'use strict';

// All Wiktionary-derived text is inserted with textContent (via el()), never as HTML.

const RELATION = {
  inh: '繼承', bor: '借入', lbor: '學術借入', slbor: '半學術借入', obor: '拼寫借入', ubor: '借入',
  der: '源自', uder: '源自', from: '源自', cal: '仿譯', pcal: '部分仿譯', sl: '語義借用',
  influence: '受影響', clip: '截短', abbr: '縮略', ellip: '省略', bf: '逆構', apheretic: '首音省略',
  translit: '轉寫',
};

const POS = {
  Noun: '名詞', Verb: '動詞', Adjective: '形容詞', Adverb: '副詞', Pronoun: '代名詞', Preposition: '介系詞',
  Conjunction: '連接詞', Interjection: '感嘆詞', Determiner: '限定詞', Article: '冠詞', Numeral: '數詞',
  Prefix: '字首', Suffix: '字尾', 'Proper noun': '專有名詞', Phrase: '片語', Root: '詞根',
  Particle: '小品詞', 'Combining form': '構詞成分', Participle: '分詞',
};

const MORPH = {
  af: '構詞', prefix: '字首構詞', suffix: '字尾構詞', confix: '前後綴構詞', compound: '複合詞',
  surf: '表層拆解', blend: '混成詞', plus: '組成',
};

const EXAMPLES = ['inspect', 'transport', 'father', 'nice', 'hotel', 'spectacle', 'bank'];

const view = document.getElementById('view');
const form = document.getElementById('search');
const input = document.getElementById('q');
const suggestions = document.getElementById('suggestions');

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const wordHref = (word) => '#/w/' + encodeURIComponent(word);
const rootHref = (lang, root) => '#/root/' + encodeURIComponent(lang) + '/' + encodeURIComponent(root);

class ApiError extends Error {
  constructor(status, title, detail, retryAfter) {
    super(title);
    this.status = status;
    this.detail = detail;
    this.retryAfter = retryAfter;
  }
}

async function getJson(url) {
  let response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    throw new ApiError(0, '無法連線到 EtymoVocab 服務。');
  }
  if (response.ok) return response.json();
  let problem = {};
  try { problem = await response.json(); } catch { /* not JSON */ }
  throw new ApiError(response.status, problem.title || `HTTP ${response.status}`, problem.detail,
    Number(response.headers.get('Retry-After')) || null);
}

function showLoading(label) {
  view.replaceChildren(el('p', { class: 'muted' }, label));
}

function showError(error, retry) {
  const parts = [el('h2', {}, error.message)];
  if (error.status === 503) {
    parts.push(el('p', {}, 'Wiktionary 暫時拒絕或無法回應請求（可能是限流）。這個版本不使用備援資料，請稍後再試。'));
    if (error.retryAfter) parts.push(el('p', { class: 'muted small' }, `建議等待約 ${error.retryAfter} 秒。`));
  } else if (error.detail) {
    parts.push(el('p', { class: 'muted' }, error.detail));
  }
  if (retry) {
    const button = el('button', { type: 'button' }, '重試');
    button.addEventListener('click', retry);
    parts.push(button);
  }
  view.replaceChildren(el('div', { class: 'card' }, parts));
}

function renderHome() {
  document.title = 'EtymoVocab';
  view.replaceChildren(
    el('div', { class: 'card' },
      el('h2', {}, '從詞源理解單字，而不是死背'),
      el('p', {}, '查一個英文字，看它如何拆解、從哪些語言一路演變而來，再沿著同一個詞根找到整個字族。'),
      el('p', { class: 'muted small' }, '資料每次都即時查詢 Wiktionary，並標示所引用的修訂版。'),
      el('h3', {}, '試試看'),
      el('div', { class: 'chips' }, EXAMPLES.map((w) => el('a', { class: 'chip', href: wordHref(w) }, el('span', { class: 'term' }, w)))),
    ),
  );
}

function chip(term, gloss, href) {
  const children = [el('span', { class: 'term' }, term), gloss ? el('span', { class: 'gloss' }, gloss) : null];
  return href ? el('a', { class: 'chip', href, target: href.startsWith('http') ? '_blank' : null, rel: 'noopener' }, children)
    : el('span', { class: 'chip' }, children);
}

function renderMorphology(group, label) {
  const row = el('div', { class: 'morph' });
  if (label) row.append(el('span', { class: 'label' }, label));
  group.parts.forEach((part, i) => {
    if (i > 0) row.append(el('span', { class: 'plus' }, '+'));
    row.append(chip(part.term, part.gloss || part.hint, part.url));
  });
  return row;
}

function morphLabel(group) {
  return `${group.langName}・${MORPH[group.kind] || group.kind}`;
}

function renderTimeline(word, steps) {
  const list = el('ol', { class: 'timeline' });
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    const proto = step.term.startsWith('*') || /^Proto-/.test(step.langName);
    const flags = [
      step.uncertain ? el('span', { class: 'flag' }, '可能（來源標示不確定）') : null,
      step.ambiguous ? el('span', { class: 'flag' }, '同形詞未確認') : null,
    ];
    const term = step.term
      ? (step.url ? el('a', { class: 'term', href: step.url, target: '_blank', rel: 'noopener' }, step.display) : el('span', { class: 'term' }, step.display))
      : el('span', { class: 'term muted' }, '（僅標示語言）');
    list.append(el('li', { class: 'node' + (proto ? ' proto' : '') },
      el('span', { class: 'lang' }, step.langName), term, flags,
      step.gloss ? el('div', { class: 'gloss', title: step.glossSource === 'definition' ? '取自該詞條的第一個釋義' : '詞源說明中的釋義' }, step.gloss) : null,
      step.morphology.map((m) => renderMorphology(m, morphLabel(m))),
    ));
    const relation = RELATION[step.relation] || step.relation;
    list.append(el('li', { class: 'edge' }, '↓ ' + relation + (step.note ? `（${step.note}）` : '')));
  }
  list.append(el('li', { class: 'node current' }, el('span', { class: 'lang' }, 'English'), el('span', { class: 'term' }, word)));
  return list;
}

function renderEtymology(result, ety, index, total) {
  const card = el('section', { class: 'card' });
  if (total > 1) card.append(el('h2', {}, `詞源 ${index + 1}` + (ety.id ? `：${ety.id}` : '')));
  if (ety.uncertain) card.append(el('div', { class: 'notice' }, 'Wiktionary 將此詞源標示為不確定。'));

  let morphology = ety.morphology;
  let via = null;
  if (morphology.length === 0) {
    const step = ety.steps.find((s) => s.morphology.length > 0);
    if (step) { morphology = step.morphology; via = step; }
  }
  if (morphology.length > 0) {
    card.append(el('h3', {}, via ? `拆解（經由 ${via.langName} ${via.display}）` : '拆解'));
    morphology.forEach((m) => card.append(renderMorphology(m, morphLabel(m))));
  }

  if (ety.steps.length > 0) {
    card.append(el('h3', {}, '演變路徑（由古至今）'), renderTimeline(result.word, ety.steps));
  }

  if (ety.roots.length > 0) {
    card.append(el('h3', {}, '詞根與字族'),
      el('div', { class: 'chips' }, ety.roots.map((r) => chip(r.root, [r.langName, r.gloss].filter(Boolean).join('・'), rootHref(r.lang, r.root)))));
  }

  if (ety.doublets.length > 0) {
    card.append(el('h3', {}, '同源異形詞（doublet）'),
      el('div', { class: 'chips' }, ety.doublets.map((d) => chip(d.term, null, d.lang === 'en' ? wordHref(d.term) : d.url))));
  }

  const withSenses = ety.partsOfSpeech.filter((p) => p.senses.length > 0);
  if (withSenses.length > 0) {
    card.append(el('h3', {}, '英文釋義'));
    withSenses.forEach((p) => card.append(
      el('div', { class: 'pos' }, POS[p.pos] || p.pos),
      el('ol', { class: 'senses' }, p.senses.map((s) => el('li', {}, s))),
    ));
  }

  const translations = ety.partsOfSpeech.flatMap((p) => p.translations.map((t) => ({ pos: p.pos, ...t })));
  if (translations.length > 0) {
    card.append(el('h3', {}, '中文翻譯（Wiktionary 翻譯表，依詞義）'),
      el('dl', { class: 'translations' }, translations.flatMap((t) => [
        el('dt', {}, `${POS[t.pos] || t.pos}${t.sense ? '：' + t.sense : ''}`),
        el('dd', {}, t.mandarin.join('、')),
      ])),
      el('p', { class: 'muted small' }, '依 Wiktionary 原文呈現，部分詞條為簡體字。'));
  }

  if (ety.text) {
    card.append(el('details', {}, el('summary', {}, '詞源原文'), el('p', {}, ety.text)));
  }
  return card;
}

async function renderWord(word) {
  document.title = `${word} · EtymoVocab`;
  input.value = word;
  showLoading(`正在查詢 Wiktionary：${word}…`);
  let result;
  try {
    result = await getJson('/api/words/' + encodeURIComponent(word));
  } catch (error) {
    showError(error, () => renderWord(word));
    return;
  }
  const revisionDate = new Date(result.source.revisionTimestamp).toLocaleDateString('zh-TW');
  const children = [
    el('h1', {}, result.word),
    el('p', { class: 'meta' },
      '來源：', el('a', { href: result.source.url, target: '_blank', rel: 'noopener' }, `Wiktionary 修訂版 ${result.source.revisionId}`),
      `（${revisionDate}）・${result.source.license}`),
  ];
  result.warnings.forEach((w) => children.push(el('div', { class: 'notice' }, w)));
  result.etymologies.forEach((ety, i) => children.push(renderEtymology(result, ety, i, result.etymologies.length)));
  view.replaceChildren(...children);
}

async function renderRoot(lang, root) {
  document.title = `${root} · EtymoVocab`;
  showLoading(`正在讀取 ${root} 的字族…`);
  let family;
  try {
    family = await getJson(`/api/roots/family?lang=${encodeURIComponent(lang)}&root=${encodeURIComponent(root)}`);
  } catch (error) {
    showError(error, () => renderRoot(lang, root));
    return;
  }

  const filter = el('input', { type: 'search', placeholder: '篩選，例如 spect', 'aria-label': '篩選字族' });
  const sort = el('select', { 'aria-label': '排序方式' },
    el('option', { value: 'length' }, '依字長（暫代詞頻）'),
    el('option', { value: 'alpha' }, '依字母'));
  const list = el('div', { class: 'chips' });
  const count = el('p', { class: 'muted small' });

  const draw = () => {
    const needle = filter.value.trim().toLowerCase();
    const members = family.members.filter((m) => m.toLowerCase().includes(needle));
    if (sort.value === 'length') members.sort((a, b) => a.length - b.length || a.localeCompare(b));
    list.replaceChildren(...members.map((m) => chip(m, null, wordHref(m))));
    const shown = family.total > family.members.length ? `（分類共 ${family.total} 筆，列出前 ${family.members.length} 筆）` : '';
    count.textContent = `顯示 ${members.length} 個字${shown}`;
  };
  filter.addEventListener('input', draw);
  sort.addEventListener('change', draw);

  view.replaceChildren(el('div', { class: 'card' },
    el('h1', {}, family.root),
    el('p', { class: 'meta' }, family.langName, family.gloss ? `・${family.gloss}` : '', '・',
      el('a', { href: family.categoryUrl, target: '_blank', rel: 'noopener' }, 'Wiktionary 分類')),
    el('div', { class: 'filter-row' }, filter, sort),
    count,
    list,
    el('p', { class: 'muted small' }, '依詞頻排序與常用字優先將在後續版本加入。'),
  ));
  draw();
}

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [kind, ...rest] = hash.split('/');
  try {
    if (kind === 'w' && rest[0]) return renderWord(decodeURIComponent(rest.join('/')));
    if (kind === 'root' && rest.length >= 2) return renderRoot(decodeURIComponent(rest[0]), decodeURIComponent(rest.slice(1).join('/')));
  } catch {
    /* malformed URI: fall through to home */
  }
  renderHome();
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const word = input.value.trim();
  if (!word) return;
  const target = wordHref(word);
  if (location.hash === target) route();
  else location.hash = target;
});

let suggestTimer;
input.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = input.value.trim();
  if (q.length < 2) return;
  suggestTimer = setTimeout(async () => {
    try {
      const titles = await getJson('/api/suggest?q=' + encodeURIComponent(q));
      suggestions.replaceChildren(...titles.map((t) => el('option', { value: t })));
    } catch { /* suggestions are optional */ }
  }, 300);
});

window.addEventListener('hashchange', route);
route();
