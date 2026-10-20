import * as engine from './engine.js';

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

// ---------------------------------------------------------------------------------------------
// DOM helpers

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const wordHref = (word) => '#/w/' + encodeURIComponent(word);
const rootHref = (lang, root) => '#/root/' + encodeURIComponent(lang) + '/' + encodeURIComponent(root);
const external = (href, label, text) => el('a', { class: 'ext', href, target: '_blank', rel: 'noopener', 'aria-label': label, title: label }, text);

function showLoading(label) {
  view.replaceChildren(el('p', { class: 'muted' }, label));
}

function errorCard(error, retry) {
  const parts = [el('h2', {}, error.message)];
  if (error.status === 503) {
    parts.push(el('p', {}, 'Wiktionary 暫時拒絕或無法回應請求（可能是限流）。這個版本不使用備援資料，請稍後再試。'));
    if (error.retryAfter) parts.push(el('p', { class: 'muted small' }, `建議等待約 ${error.retryAfter} 秒。`));
  } else if (error.detail) {
    parts.push(el('p', { class: 'muted' }, error.detail));
  }
  if (retry) parts.push(el('button', { type: 'button', onclick: retry }, '重試'));
  return el('div', { class: 'card' }, parts);
}

// ---------------------------------------------------------------------------------------------
// Memory state: which origins the learner says they remember. Per-browser convenience only.

const STORAGE_KEY = 'etymovocab.remembered.v1';

const memory = {
  remembered: new Set(load()),
  peeked: new Set(),       // revealed for this view only
  hideRemembered: true,    // mask origins marked as remembered
  quiz: false,             // mask every origin until peeked
};

function load() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...memory.remembered]));
  } catch {
    /* storage unavailable (private mode): state lasts for this page only */
  }
}

function isMasked(node) {
  if (!node.maskable || memory.peeked.has(node.key)) return false;
  return memory.quiz || (memory.hideRemembered && memory.remembered.has(node.key));
}

// ---------------------------------------------------------------------------------------------
// Tree model. The searched word is the root; children are where it came from: word formation
// (morphology groups → parts), the next older ancestor, and the reconstructed root.

const nodeKey = (lang, term) => `${lang}:${term}`;

function partNode(part, group) {
  return {
    key: nodeKey(group.lang, part.term),
    kind: 'part',
    lang: group.lang,
    langName: group.langName,
    term: part.term,
    gloss: part.gloss || part.hint,
    glossIsHint: !part.gloss && !!part.hint,
    url: part.url,
    lookup: part.url ? { lang: group.lang, term: part.term, id: part.hint } : null,
    maskable: true,
    children: [],
  };
}

function groupNode(group) {
  return {
    key: `group:${group.lang}:${group.parts.map((p) => p.term).join('+')}`,
    kind: 'group',
    label: `${group.langName}・${MORPH[group.kind] || group.kind}`,
    children: group.parts.map((p) => partNode(p, group)),
  };
}

function stepNode(step, isOldest) {
  return {
    key: nodeKey(step.lang, step.term || step.langName),
    kind: 'step',
    lang: step.lang,
    langName: step.langName,
    term: step.display || step.term,
    gloss: step.gloss,
    glossFromDefinition: step.glossSource === 'definition',
    relation: step.relation,
    note: step.note,
    uncertain: step.uncertain,
    ambiguous: step.ambiguous,
    url: step.url,
    proto: (step.term || '').startsWith('*') || /^Proto-/.test(step.langName),
    lookup: isOldest && step.url && step.term ? { lang: step.lang, term: step.term, id: null } : null,
    maskable: !!step.term,
    children: step.morphology.map(groupNode),
  };
}

function rootNode(root) {
  return {
    key: nodeKey(root.lang, root.root),
    kind: 'root',
    lang: root.lang,
    langName: root.langName,
    term: root.root,
    gloss: root.gloss,
    url: root.url,
    family: rootHref(root.lang, root.root),
    proto: true,
    maskable: true,
    children: [],
  };
}

/** Adds an etymology's formation, ancestor chain and roots under `node`, skipping groups it already has. */
function attachEtymology(node, ety) {
  const existing = new Set(node.children.map((c) => c.key));
  const added = [];
  for (const group of ety.morphology.map(groupNode)) {
    if (!existing.has(group.key)) added.push(group);
  }
  // The chain nests: each older ancestor is a child of the newer one. Reuse a node already present.
  let parent = null;
  ety.steps.forEach((step, i) => {
    const child = stepNode(step, i === ety.steps.length - 1);
    const siblings = parent ? parent.children : [...node.children, ...added];
    const same = siblings.find((c) => c.key === child.key);
    if (same) {
      parent = same;
      return;
    }
    if (parent) parent.children.push(child);
    else added.push(child);
    parent = child;
  });
  for (const root of ety.roots.map(rootNode)) {
    if (!existing.has(root.key)) added.push(root);
  }
  node.children.push(...added);
  return added.length;
}

function buildTree(result, ety) {
  const root = { key: nodeKey(result.lang, result.word), kind: 'word', lang: result.lang, langName: result.langName, term: result.word, maskable: false, children: [] };
  attachEtymology(root, ety);
  return root;
}

function walk(node, visit) {
  visit(node);
  node.children.forEach((c) => walk(c, visit));
}

// ---------------------------------------------------------------------------------------------
// Tree rendering

class TreeView {
  constructor(tree) {
    this.tree = tree;
    this.element = el('ul', { class: 'tree', role: 'tree' });
    this.stats = el('p', { class: 'muted small' });
  }

  render() {
    this.element.replaceChildren(this.renderNode(this.tree));
    let total = 0;
    let remembered = 0;
    walk(this.tree, (n) => {
      if (!n.maskable) return;
      total += 1;
      if (memory.remembered.has(n.key)) remembered += 1;
    });
    this.stats.textContent = total ? `這棵樹有 ${total} 個來源，已記住 ${remembered} 個。` : '';
  }

  setAll(collapsed) {
    walk(this.tree, (n) => { n.collapsed = collapsed && n.kind !== 'word'; });
    this.render();
  }

  renderNode(node) {
    const hasChildren = node.children.length > 0;
    const item = el('li', {
      role: 'treeitem',
      class: `tnode kind-${node.kind}` + (node.proto ? ' proto' : ''),
      'aria-expanded': hasChildren ? String(!node.collapsed) : null,
    });

    const twisty = hasChildren
      ? el('button', {
          type: 'button', class: 'twisty', 'aria-label': node.collapsed ? '展開' : '收合',
          onclick: () => { node.collapsed = !node.collapsed; this.render(); },
        }, node.collapsed ? '▸' : '▾')
      : el('span', { class: 'twisty spacer', 'aria-hidden': 'true' });

    item.append(el('div', { class: 'row' }, twisty, this.renderBody(node), this.renderActions(node)));
    if (hasChildren && !node.collapsed) {
      item.append(el('ul', { role: 'group' }, node.children.map((c) => this.renderNode(c))));
    }
    return item;
  }

  renderBody(node) {
    if (node.kind === 'group') return el('div', { class: 'body' }, el('span', { class: 'group-label' }, node.label));

    const label = node.kind === 'step'
      ? (RELATION[node.relation] || node.relation) + (node.note ? `（${node.note}）` : '')
      : node.kind === 'part' ? '構詞成分' : node.kind === 'root' ? '詞根' : null;
    const head = [
      label ? el('div', { class: 'edge-label' }, label) : null,
      el('span', { class: 'lang' }, node.langName),
    ];

    if (isMasked(node)) {
      const text = memory.quiz && !memory.remembered.has(node.key) ? '？ 想一想，再點一下看答案' : '已記住・點一下回看';
      return el('div', { class: 'body' }, head,
        el('button', { type: 'button', class: 'mask', onclick: () => { memory.peeked.add(node.key); this.render(); } }, text));
    }

    const term = node.kind === 'word'
      ? el('span', { class: 'term current' }, node.term)
      : el('span', { class: 'term' }, node.term || '（僅標示語言）');
    return el('div', { class: 'body' }, head, term,
      node.url ? external(node.url, '在 Wiktionary 開啟', '↗') : null,
      node.uncertain ? el('span', { class: 'flag' }, '可能（來源標示不確定）') : null,
      node.ambiguous ? el('span', { class: 'flag' }, '同形詞未確認') : null,
      node.gloss ? el('div', { class: 'gloss' + (node.glossIsHint ? ' hint' : ''), title: node.glossFromDefinition ? '取自該詞條的第一個釋義' : null }, node.gloss) : null,
      node.message ? el('div', { class: 'muted small' }, node.message) : null);
  }

  renderActions(node) {
    const actions = [];
    if (node.family) actions.push(el('a', { class: 'action', href: node.family }, '字族'));
    if (node.lookup && !node.loaded) {
      actions.push(el('button', {
        type: 'button', class: 'action', disabled: node.loading,
        onclick: () => this.expand(node),
      }, node.loading ? '讀取中…' : '展開來源'));
    }
    if (node.maskable) {
      const remembered = memory.remembered.has(node.key);
      if (memory.peeked.has(node.key) && (remembered || memory.quiz)) {
        actions.push(el('button', { type: 'button', class: 'action', onclick: () => { memory.peeked.delete(node.key); this.render(); } }, '遮回去'));
      }
      actions.push(el('button', {
        type: 'button', class: 'action' + (remembered ? ' on' : ''), 'aria-pressed': String(remembered),
        onclick: () => {
          if (remembered) memory.remembered.delete(node.key);
          else { memory.remembered.add(node.key); memory.peeked.delete(node.key); }
          save();
          this.render();
        },
      }, remembered ? '忘了' : '記得'));
    }
    return actions.length ? el('div', { class: 'actions' }, actions) : null;
  }

  async expand(node) {
    node.loading = true;
    this.render();
    try {
      const result = await engine.lookupEntry(node.lookup.lang, node.lookup.term, node.lookup.id);
      const etymologies = result.etymologies.filter((e) => e.steps.length || e.morphology.length || e.roots.length);
      let added = 0;
      if (etymologies.length === 1) {
        added = attachEtymology(node, etymologies[0]);
      } else {
        etymologies.forEach((ety, i) => {
          const group = { key: `${node.key}#${i + 1}`, kind: 'group', label: `同形詞 ${i + 1}${ety.id ? `：${ety.id}` : ''}`, children: [] };
          attachEtymology(group, ety);
          node.children.push(group);
          added += 1;
        });
      }
      node.loaded = true;
      node.collapsed = false;
      node.message = added ? null : 'Wiktionary 沒有更多詞源資料。';
    } catch (error) {
      node.message = error.status === 503 ? 'Wiktionary 暫時限流，請稍後再試。' : error.message;
    } finally {
      node.loading = false;
      this.render();
    }
  }
}

function toolbar(views) {
  const each = (fn) => views.forEach((v) => fn(v));
  const hideToggle = el('input', { type: 'checkbox', checked: memory.hideRemembered, onchange: (e) => { memory.hideRemembered = e.target.checked; memory.peeked.clear(); each((v) => v.render()); } });
  const quizButton = el('button', { type: 'button', class: 'secondary' }, memory.quiz ? '結束測驗' : '測驗：全部遮住');
  quizButton.addEventListener('click', () => {
    memory.quiz = !memory.quiz;
    memory.peeked.clear();
    quizButton.textContent = memory.quiz ? '結束測驗' : '測驗：全部遮住';
    each((v) => v.render());
  });
  return el('div', { class: 'toolbar' },
    el('button', { type: 'button', class: 'secondary', onclick: () => each((v) => v.setAll(false)) }, '全部展開'),
    el('button', { type: 'button', class: 'secondary', onclick: () => each((v) => v.setAll(true)) }, '全部收合'),
    quizButton,
    el('label', { class: 'check' }, hideToggle, '遮住已記住的來源'));
}

// ---------------------------------------------------------------------------------------------
// Pages

function renderHome() {
  document.title = 'EtymoVocab';
  view.replaceChildren(
    el('div', { class: 'card' },
      el('h2', {}, '從詞源理解單字，而不是死背'),
      el('p', {}, '查一個英文字，展開它的詞源樹：怎麼拆解、從哪些語言一路演變而來，再沿著同一個詞根找到整個字族。'),
      el('p', {}, '記住某個來源後按「記得」，它就會被遮住，讓你專心看還沒記住的部分；忘了的時候點一下就能回看。'),
      el('p', { class: 'muted small' }, '資料每次都由你的瀏覽器即時查詢 Wiktionary，並標示所引用的修訂版。'),
      el('h3', {}, '試試看'),
      el('div', { class: 'chips' }, EXAMPLES.map((w) => el('a', { class: 'chip', href: wordHref(w) }, el('span', { class: 'term' }, w)))),
    ),
  );
}

function chip(term, gloss, href) {
  const children = [el('span', { class: 'term' }, term), gloss ? el('span', { class: 'gloss' }, gloss) : null];
  return href
    ? el('a', { class: 'chip', href, target: href.startsWith('http') ? '_blank' : null, rel: 'noopener' }, children)
    : el('span', { class: 'chip' }, children);
}

function renderEtymologyCard(result, ety, index, total, views) {
  const card = el('section', { class: 'card' });
  if (total > 1) card.append(el('h2', {}, `詞源 ${index + 1}` + (ety.id ? `：${ety.id}` : '')));
  if (ety.uncertain) card.append(el('div', { class: 'notice' }, 'Wiktionary 將此詞源標示為不確定。'));

  if (ety.steps.length || ety.morphology.length || ety.roots.length) {
    const tree = new TreeView(buildTree(result, ety));
    views.push(tree);
    card.append(el('h3', {}, '詞源樹'), tree.element, tree.stats);
    tree.render();
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

  if (ety.text) card.append(el('details', {}, el('summary', {}, '詞源原文'), el('p', {}, ety.text)));
  return card;
}

async function renderWord(word) {
  document.title = `${word} · EtymoVocab`;
  input.value = word;
  memory.peeked.clear();
  showLoading(`正在查詢 Wiktionary：${word}…`);
  let result;
  try {
    result = await engine.lookupWord(word);
  } catch (error) {
    view.replaceChildren(errorCard(error, () => renderWord(word)));
    return;
  }

  const revisionDate = new Date(result.source.revisionTimestamp).toLocaleDateString('zh-TW');
  const views = [];
  const cards = result.etymologies.map((ety, i) => renderEtymologyCard(result, ety, i, result.etymologies.length, views));
  view.replaceChildren(
    el('h1', {}, result.word),
    el('p', { class: 'meta' },
      '來源：', el('a', { href: result.source.url, target: '_blank', rel: 'noopener' }, `Wiktionary 修訂版 ${result.source.revisionId}`),
      `（${revisionDate}）・${result.source.license}`),
    ...result.warnings.map((w) => el('div', { class: 'notice' }, w)),
    views.length ? toolbar(views) : null,
    ...cards,
  );
}

async function renderRoot(lang, root) {
  document.title = `${root} · EtymoVocab`;
  showLoading(`正在讀取 ${root} 的字族…`);
  let family;
  try {
    family = await engine.rootFamily(lang, root);
  } catch (error) {
    view.replaceChildren(errorCard(error, () => renderRoot(lang, root)));
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
  return renderHome();
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
      const titles = await engine.suggest(q);
      suggestions.replaceChildren(...titles.map((t) => el('option', { value: t })));
    } catch { /* suggestions are optional */ }
  }, 300);
});

window.addEventListener('hashchange', route);
engine.preload().catch((error) => {
  view.replaceChildren(errorCard({ message: '無法載入查詢引擎', detail: `${error.message}（需要支援 WebAssembly 的瀏覽器）` }));
});
route();
