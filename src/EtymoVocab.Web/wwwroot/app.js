import * as engine from './engine.js';
import { layoutTree, edgePath } from './map-layout.js';
import { fitZoom, mapGeometry, zoomScroll } from './map-viewport.js';
import { attachEtymologicalWords, addVerifiedOrigin, addEtymologicalWord, familySource, familyHref, familyComparator } from './map-related.js';
import { loadFrequencyRanks } from './frequency.js';
import { buildWordStory, feelLines, langZh } from './word-story.js';
import { createReverseDiscovery } from './reverse-index-view.js';
import { createLearningView } from './learning.js';
import { createSavedWordsStore } from './saved-words.js';
import { createVocabularyView, thesaurusLinks } from './vocabulary.js';

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

const EXAMPLES = ['nice', 'inspect', 'transport', 'father', 'hotel', 'spectacle', 'bank'];

const view = document.getElementById('view');
const form = document.getElementById('search');
const input = document.getElementById('q');
const suggestions = document.getElementById('suggestions');
let navigation = 0;

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

const learningView = createLearningView({ view, el });

const wordHref = (word) => '#/w/' + encodeURIComponent(word);
const exploreHref = (word) => '#/explore/' + encodeURIComponent(word);
const external = (href, label, text) => el('a', { class: 'ext', href, target: '_blank', rel: 'noopener', 'aria-label': label, title: label }, text);
const savedWords = createSavedWordsStore();
const vocabularyView = createVocabularyView({ view, el, store: savedWords, lookup: engine.lookupRelated, lookupBatch: engine.lookupRelatedBatch, preload: engine.preload,
  getBackoffUntil: engine.getBackoffUntil, wordHref, exploreHref, sourceNote, inflectionNote, posNames: POS });

function showLoading(label) {
  view.replaceChildren(el('p', { class: 'muted' }, label));
}

function errorCard(error, retry) {
  const parts = [el('h2', {}, error.message)];
  if (error.status === 429 || error.status === 503) {
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
/** What a family adds: words sharing a root, or English words built with the same prefix. */
const familyNoun = (node) => node.familyKind === 'prefix'
  ? (isMasked(node) ? '同字首的字' : `${node.familyRoot} 開頭的字`) : '同根詞';

/** Why nothing was added when Wiktionary splits the form into senses and the entry names none. */
function ambiguousFamilyMessage(kind, term, senses) {
  return `Wiktionary 把 ${term} 分成幾個不同意思的${kind === 'prefix' ? '字首' : '詞根'}（${senses.map(s => s.id).join('、')}），`
    + '這個詞條沒有標示是哪一個，所以不自動加入，以免混入其他意思的字。可在「字族清單」選擇意思。';
}

/** Marks a node as able to list its shared-origin words: a root category or an English prefix category. */
function withFamily(node, source) {
  return source
    ? Object.assign(node, { family: familyHref(source), familyRoot: source.term, familyKind: source.kind, familyId: source.id })
    : node;
}

function displayAnchor(anchor) {
  return isMasked({ maskable: true, key: nodeKey(anchor.lang, anchor.term) }) ? '？' : anchor.term;
}

function nodeLabel(node) {
  if (!node.verifiedAnchor) return isMasked(node) ? '？' : node.term || node.label;
  const origin = displayAnchor(node.verifiedAnchor);
  return node.kind === 'group' ? `${node.label}：${origin}（已核對）` : `${node.relationLabel}：${origin}`;
}

function partNode(part, group, familyAllowed) {
  const lang = part.lang || group.lang;
  return withFamily({
    key: nodeKey(lang, part.term),
    kind: 'part',
    familyAllowed,
    lang,
    langName: part.langName || (lang === group.lang ? group.langName : lang),
    term: part.term,
    gloss: part.gloss || part.hint,
    glossIsHint: !part.gloss && !!part.hint,
    url: part.url,
    lookup: part.url ? { lang, term: part.term, id: part.hint } : null,
    maskable: true,
    children: [],
  }, familyAllowed && familySource({ lang, term: part.term, id: part.hint }));
}

function groupNode(group, familyAllowed, componentAnchors) {
  return {
    key: `group:${group.lang}:${group.kind}:${JSON.stringify(group.parts.map(p => [p.lang || group.lang, p.term, p.hint ?? null]))}`,
    kind: 'group',
    label: `${group.langName}・${MORPH[group.kind] || group.kind}`,
    collapsed: true,
    children: group.parts.map(part => partNode(part, group, familyAllowed && (!componentAnchors ||
      componentAnchors.some(anchor => matchesAnchor(anchor, 'component', part.lang || group.lang, part.term, part.hint))))),
  };
}

function matchesAnchor(anchor, kind, lang, term, id) {
  return anchor.kind === kind && anchor.lang === lang && anchor.term === term && (!id || id === anchor.etymonId);
}

function stepNode(step, isOldest, familyAllowed, anchors) {
  const id = step.id ?? step.etymonId ?? null;
  return withFamily({
    key: nodeKey(step.lang, step.term || step.langName),
    kind: 'step',
    familyAllowed,
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
    lookup: isOldest && step.url && step.term ? { lang: step.lang, term: step.term, id } : null,
    maskable: !!step.term,
    children: step.morphology.map(group => groupNode(group, familyAllowed && !step.ancestryUncertain, anchors)),
  }, familyAllowed && familySource({ lang: step.lang, term: step.term, id }));
}

function rootNode(root) {
  // An explicit {{root}} reference always has a family category, whatever its form.
  return withFamily({
    key: nodeKey(root.lang, root.root),
    kind: 'root',
    explicitRoot: true,
    lang: root.lang,
    langName: root.langName,
    term: root.root,
    gloss: root.gloss,
    url: root.url,
    proto: true,
    maskable: true,
    children: [],
  }, { kind: 'root', lang: root.lang, term: root.root, id: root.id || null });
}

// A retry can fill in glosses, identities and children on nodes already visible from a partial lookup.
function mergeOriginNode(parent, incoming) {
  const current = parent.children.find(child => child.key === incoming.key);
  if (!current) {
    parent.children.push(incoming);
    return incoming;
  }
  const { children, collapsed, ...details } = incoming;
  Object.assign(current, details);
  for (const child of children) mergeOriginNode(current, child);
  return current;
}

function attachEtymology(node, ety, word = node.term, lang = node.lang) {
  const originalCount = node.children.length;
  const sectionCertain = !ety.uncertain && node.familyAllowed !== false;
  for (const group of ety.morphology) mergeOriginNode(node, groupNode(group, sectionCertain));
  const anchors = ety.originAnchors || [];
  let qualifiedChain = sectionCertain;
  let parent = node;
  ety.steps.forEach((step, i) => {
    qualifiedChain = qualifiedChain && !step.uncertain && !step.ambiguous && step.transitive !== false &&
      anchors.some(anchor => matchesAnchor(anchor, 'ancestor', step.lang, step.term, step.id ?? step.etymonId));
    parent = mergeOriginNode(parent, stepNode(step, i === ety.steps.length - 1, qualifiedChain, anchors));
    if (step.ancestryUncertain) qualifiedChain = false;
  });
  for (const root of (sectionCertain ? ety.roots : []).map(rootNode)) {
    let match;
    walk(node, child => {
      if (child.key === root.key && child.familyAllowed !== false && (child.familyId ?? null) === root.familyId) match = child;
    });
    if (match) Object.assign(match, { family: root.family, familyRoot: root.term, familyKind: 'root', familyId: root.familyId, explicitRoot: true, proto: true });
    else node.children.push({ ...root, rootReference: true });
  }
  return node.children.length - originalCount + attachEtymologicalWords(node, ety, word, lang);
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
// Horizontal etymology map

class EtymologyMap {
  constructor(tree, etymology) {
    this.tree = tree;
    this.zoom = 1;
    this.stage = el('div', { class: 'map-stage' });
    this.canvas = el('div', { class: 'map-canvas' }, this.stage);
    this.viewport = el('div', {
      class: 'map-viewport', tabindex: '0', role: 'region', 'aria-label': '互動詞源地圖，可水平與垂直捲動、拖曳移動，方向鍵捲動，雙指或加減鍵縮放',
    }, this.canvas);
    this.zoomLabel = el('output', { class: 'zoom-label', 'aria-label': '地圖縮放比例' }, '100%');
    this.relatedOptions = el('div', { class: 'map-related-options' });
    this.relatedStatus = el('p', { class: 'muted small', role: 'status', 'aria-live': 'polite' });
    this.relatedFilter = el('input', { type: 'search', placeholder: '篩選相關字', 'aria-label': '篩選詞源相關字',
      oninput: () => { this.renderRelatedOptions(); this.reverse.setFilter(this.relatedFilter.value); } });
    this.reverse = createReverseDiscovery({ word: tree.term, etymology, lookup: engine.lookupWord,
      isActive: () => this.element?.isConnected, displayAnchor,
      getBackoffUntil: engine.getBackoffUntil, observeBackoff: engine.observeBackoff,
      getExcluded: () => {
        const words = new Set();
        walk(tree, node => {
          for (const group of node.etymologicalGroups || []) for (const item of group.terms) if (item.lang === 'en') words.add(item.term);
          for (const word of node.familyMembers || []) words.add(word);
        });
        return words;
      },
      onVerified: (match, manual) => {
        const node = addVerifiedOrigin(tree, match);
        if (!node) return;
        if (manual) this.revealNode(node);
        this.render();
        if (manual) this.focusNode(node);
      },
    });
    this.relatedPanel = el('details', { class: 'map-related', open: true },
      el('summary', {}, '詞源相關字：派生詞、同族詞與同根詞'),
      el('p', { class: 'muted small' }, '依詞條記載分組，先顯示每組 8 字；其餘可在清單搜尋加入。展開構詞成分的來源，也能找到該成分的字族。'),
      this.relatedFilter, this.relatedOptions, this.relatedStatus, this.reverse.element);
    this.element = el('div', { class: 'map-panel' },
      el('div', { class: 'map-controls' },
        el('span', { class: 'map-direction' }, '單字 → 來源 → 詞源相關字'),
        el('div', { class: 'map-buttons' },
          el('button', { type: 'button', class: 'secondary', 'aria-label': '縮小地圖', onclick: () => this.zoomBy(1 / 1.2) }, '−'),
          this.zoomLabel,
          el('button', { type: 'button', class: 'secondary', 'aria-label': '放大地圖', onclick: () => this.zoomBy(1.2) }, '+'),
          el('button', { type: 'button', class: 'secondary', onclick: () => this.fit() }, '顯示全圖'),
          el('button', { type: 'button', class: 'secondary', onclick: () => this.focusWord() }, '回到單字'),
          el('button', { type: 'button', class: 'secondary', onclick: async () => {
            try {
              if (document.fullscreenElement) await document.exitFullscreen();
              else await this.element.requestFullscreen();
            } catch { this.element.classList.toggle('map-expanded'); }
            this.fit();
          } }, '切換全螢幕'))),
      this.relatedPanel,
      this.viewport,
      el('div', { class: 'map-legend' },
        el('span', {}, '捲動、拖曳或方向鍵移動 · 雙指或 ＋／− 縮放'),
        el('span', { class: 'legend-origin' }, '實線：來源／構詞'),
        el('span', { class: 'legend-family' }, '虛線：詞源相關字（關係見分組標籤）')));
    this.stats = el('p', { class: 'muted small' });
    this.enablePinchZoom();
    let drag;
    this.viewport.addEventListener('pointerdown', event => {
      if (event.pointerType === 'touch') return; // Let the browser handle touch scrolling.
      if (event.button !== 0 || event.target.closest('button, a, input, select')) return;
      const rect = this.viewport.getBoundingClientRect();
      if (event.clientX - rect.left >= this.viewport.clientWidth || event.clientY - rect.top >= this.viewport.clientHeight) return;
      drag = { x: event.clientX + this.viewport.scrollLeft, y: event.clientY + this.viewport.scrollTop, id: event.pointerId };
      this.viewport.setPointerCapture(event.pointerId);
      this.viewport.classList.add('dragging');
    });
    this.viewport.addEventListener('pointermove', event => {
      if (!drag || drag.id !== event.pointerId) return;
      this.viewport.scrollTo(drag.x - event.clientX, drag.y - event.clientY);
    });
    const endDrag = () => { drag = null; this.viewport.classList.remove('dragging'); };
    this.viewport.addEventListener('pointerup', endDrag);
    this.viewport.addEventListener('pointercancel', endDrag);
    this.viewport.addEventListener('lostpointercapture', endDrag);
    this.viewport.addEventListener('keydown', event => {
      if (event.target !== this.viewport) return;
      const moves = { ArrowLeft: [-60, 0], ArrowRight: [60, 0], ArrowUp: [0, -60], ArrowDown: [0, 60] };
      if (moves[event.key]) {
        event.preventDefault();
        this.viewport.scrollBy(...moves[event.key]);
      } else if (event.key === '+' || event.key === '=') { event.preventDefault(); this.zoomBy(1.2); }
      else if (event.key === '-') { event.preventDefault(); this.zoomBy(1 / 1.2); }
      else if (event.key === '0') { event.preventDefault(); this.fit(); }
    });
    this.viewport.addEventListener('wheel', event => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      this.zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1);
    }, { passive: false });
  }

  enablePinchZoom() {
    let start;
    let suppressTap = false;
    const measure = touches => {
      const a = touches[0], b = touches[1];
      const rect = this.viewport.getBoundingClientRect();
      return {
        distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        point: { x: (a.clientX + b.clientX) / 2 - rect.left - this.viewport.clientLeft,
          y: (a.clientY + b.clientY) / 2 - rect.top - this.viewport.clientTop },
      };
    };
    const onContactsChanged = event => {
      start = null;
      const touches = event.touches;
      if (event.type === 'touchstart' && touches.length === 1) suppressTap = false;
      if (touches.length !== 2 || !this.layout || !this.viewport.contains(touches[0].target) ||
        !this.viewport.contains(touches[1].target)) return;
      const gesture = measure(touches);
      if (!gesture.distance) return;
      if (event.cancelable) event.preventDefault();
      suppressTap = true;
      start = { ...gesture, zoom: this.zoom, scroll: { x: this.viewport.scrollLeft, y: this.viewport.scrollTop } };
    };
    this.viewport.addEventListener('touchstart', onContactsChanged, { passive: false });
    this.viewport.addEventListener('touchend', event => {
      // Lifting the last finger over a node control must not activate it after a pinch.
      if (suppressTap && event.cancelable) event.preventDefault();
      if (!event.touches.length) suppressTap = false;
      onContactsChanged(event);
    }, { passive: false });
    this.viewport.addEventListener('touchcancel', () => { start = null; suppressTap = false; });
    this.viewport.addEventListener('touchmove', event => {
      if (!start || event.touches.length !== 2) return;
      if (event.cancelable) event.preventDefault();
      const current = measure(event.touches);
      this.zoomBy(current.distance / start.distance, start, current.point);
    }, { passive: false });
  }

  render(anchor) {
    const focused = this.element.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused?.closest('[data-key]')?.dataset.key;
    const focusLabel = focused?.getAttribute('aria-label') || focused?.textContent;
    const anchorKey = anchor?.key || focusKey;
    const previous = anchorKey && this.layout?.nodes.find(point => point.node.key === anchorKey);
    const scroll = { x: this.viewport.scrollLeft, y: this.viewport.scrollTop };
    const previousOffset = this.geometry || { offsetX: 0, offsetY: 0 };
    const cards = new Map();
    const collect = (node, ancestors = new Set()) => {
      if (ancestors.has(node.key)) return;
      const next = new Set(ancestors).add(node.key);
      cards.set(node, this.renderNode(node));
      if (!node.collapsed) node.children.forEach(child => collect(child, next));
    };
    collect(this.tree);
    this.stage.replaceChildren(...cards.values());
    this.layout = layoutTree(this.tree, node => cards.get(node).offsetHeight || 170);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'map-edges');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', this.layout.width);
    svg.setAttribute('height', this.layout.height);
    this.layout.edges.forEach(edge => {
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', edgePath(edge));
      path.setAttribute('class', edge.to.node.sharedOrigin || edge.to.node.kind === 'family' || edge.to.node.rootReference ? 'family-edge' : 'origin-edge');
      svg.append(path);
    });
    this.stage.prepend(svg);
    this.stage.style.width = `${this.layout.width}px`;
    this.stage.style.height = `${this.layout.height}px`;
    this.layout.nodes.forEach(point => {
      const card = cards.get(point.node);
      card.style.left = `${point.x}px`; card.style.top = `${point.y}px`;
    });
    const current = previous && this.layout.nodes.find(point => point.node.key === anchorKey);
    this.transform();
    if (current) this.viewport.scrollTo(
      scroll.x + (current.x - previous.x) * this.zoom + this.geometry.offsetX - previousOffset.offsetX,
      scroll.y + (current.y - previous.y) * this.zoom + this.geometry.offsetY - previousOffset.offsetY);
    if (focused && focusKey) {
      const card = [...cards.values()].find(item => item.dataset.key === focusKey);
      const replacement = card && [...card.querySelectorAll('button, a')].find(item => (item.getAttribute('aria-label') || item.textContent) === focusLabel);
      (replacement || this.viewport).focus({ preventScroll: true });
    }
    let total = 0;
    let remembered = 0;
    walk(this.tree, (n) => {
      if (!n.maskable) return;
      total += 1;
      if (memory.remembered.has(n.key)) remembered += 1;
    });
    this.stats.textContent = total ? `${total} 個來源 · 已記住 ${remembered} 個。可搜尋字族清單，或展開構詞成分與相關字的來源。` : '目前未解析出祖源鏈；詞條明列的派生詞與詞源關聯仍會顯示。';
    this.relatedStatus.hidden = !!this.statusOwner && isMasked(this.statusOwner);
    this.renderRelatedOptions();
    this.reverse.refresh();
  }

  setRelatedStatus(text, owner) {
    this.statusOwner = owner;
    this.relatedStatus.textContent = text;
  }

  renderRelatedOptions() {
    const focusedKey = document.activeElement?.dataset.relatedKey;
    const filter = this.relatedFilter.value.normalize('NFC').trim().toLocaleLowerCase();
    const matches = term => !filter || term.toLocaleLowerCase().includes(filter);
    const sections = [];
    const roots = new Map();
    let candidates = 0;
    walk(this.tree, owner => {
      if (owner.family && !roots.has(owner.family)) roots.set(owner.family, owner);
      for (const group of owner.etymologicalGroups || []) {
        const terms = group.terms.filter(term => matches(term.term));
        candidates += terms.length;
        if (!terms.length) continue;
        const present = new Set(owner.children.find(child => child.key === group.key)?.children.map(child => JSON.stringify([child.lang, child.term])));
        const sourceUrl = group.terms.find(term => term.sourceUrl)?.sourceUrl;
        sections.push(el('section', { class: 'map-related-group' },
          el('h3', {}, `${nodeLabel(owner)} · ${group.label}（${terms.length} / ${group.terms.length}）`,
            sourceUrl ? external(sourceUrl, 'Wiktionary 記載此關係的來源', ' 來源 ↗') : null),
          el('div', { class: 'chips' }, terms.map(term => {
            const key = JSON.stringify([term.lang, term.term]);
            return el('button', {
              type: 'button', class: 'secondary', disabled: present.has(key),
              'data-related-key': `${group.key}:${key}`, 'aria-label': `${present.has(key) ? '已加入' : '加入'}${group.label} ${term.term}`,
              onclick: () => {
                const node = addEtymologicalWord(owner, group, term);
                if (!node) return;
                this.revealNode(node);
                this.setRelatedStatus(`已將${group.label} ${term.term} 加入地圖。`, owner);
                this.render(owner);
                this.focusNode(node);
              },
            }, `${present.has(key) ? '已加入' : '＋'} ${term.term}`);
          }))));
      }
    });
    for (const node of roots.values()) {
      const masked = isMasked(node);
      const term = masked ? '已遮住的來源' : node.familyRoot || node.term;
      const noun = node.familyKind === 'prefix' ? '同字首的字' : '同根詞';
      const members = (node.familyMembers || []).filter(word => word !== this.tree.term);
      const found = members.filter(matches);
      candidates += found.length;
      const present = new Set(node.children.filter(child => child.kind === 'family').map(child => child.term));
      sections.push(el('section', { class: 'map-related-group' },
        el('h3', {}, `${term} · ${noun}`, node.familySource ? external(node.familySource, '字族分類來源', ' 來源 ↗') : null),
        el('button', {
          type: 'button', class: 'secondary', 'data-related-key': `family:${node.key}`,
          disabled: node.familyLoading || node.familyExhausted,
          onclick: async () => {
            this.revealNode(node);
            await this.loadFamily(node);
            this.focusNode(node);
          },
        }, node.familyLoading ? '讀取字族中…' : node.familyAmbiguous ? `${term}：意思未標示`
          : node.familyExhausted ? `已加入 ${present.size} 個${noun}` : node.familyMembers ? `加入更多${noun}`
          : node.familyKind === 'prefix' ? `＋ ${familyNoun(node)}` : `＋ ${term} 的${noun}`),
        node.familyMembers && !node.familyAmbiguous ? el('details', { open: !!filter },
          el('summary', {}, `查看${noun}清單（${found.length} / ${members.length}）`),
          el('div', { class: 'chips' }, found.map(word => el('button', {
            type: 'button', class: 'secondary', disabled: present.has(word),
            'data-related-key': `family:${node.key}:${word}`, 'aria-label': `${present.has(word) ? '已加入' : '加入'}${noun} ${word}`,
            onclick: () => {
              const added = this.addFamilyWord(node, word);
              if (!added) return;
              this.revealNode(added);
              this.setRelatedStatus(`已將${noun} ${word} 加入地圖。`, node);
              this.render(node);
              this.focusNode(added);
            },
          }, `${present.has(word) ? '已加入' : '＋'} ${word}`)))) : null,
        node.message && !masked ? el('p', { class: 'muted small' }, node.message) : null));
    }
    if (!candidates) sections.push(el('p', { class: 'muted small' }, filter
      ? '詞條明列與詞根分類中沒有符合的字。' + (this.reverse.element.hidden ? '可展開其他來源繼續查詢。' : '可查看下方共同來源的候選。')
      : '目前沒有讀取到明列的相關字，不代表沒有詞源關聯。可展開構詞成分，或查看詞源原文與 Wiktionary 來源。'));
    this.relatedOptions.replaceChildren(...sections);
    if (focusedKey) {
      const button = [...this.relatedOptions.querySelectorAll('button')].find(item => item.dataset.relatedKey === focusedKey);
      (button && !button.disabled ? button : this.relatedPanel.querySelector('summary')).focus({ preventScroll: true });
    }
  }

  async loadInitialFamilies() {
    const roots = new Map();
    walk(this.tree, node => {
      if (node.explicitRoot && !roots.has(node.family)) roots.set(node.family, node);
    });
    // Show the dictionary relationships first; family requests run afterwards, one at a time.
    for (const node of roots.values()) {
      if (!this.element.isConnected || engine.backgroundPaused()) return;
      const loaded = await this.loadFamily(node, true);
      if (loaded === false) break;
    }
  }

  revealNode(target) {
    const reveal = node => {
      if (node === target || node.children.some(reveal)) {
        node.collapsed = false;
        return true;
      }
      return false;
    };
    reveal(this.tree);
  }

  focusNode(node) {
    const point = this.layout?.nodes.find(item => item.node === node);
    if (!point) return;
    this.viewport.scrollTo((point.x + point.width / 2) * this.zoom + this.geometry.offsetX - this.viewport.clientWidth / 2,
      (point.y + point.height / 2) * this.zoom + this.geometry.offsetY - this.viewport.clientHeight / 2);
  }

  transform() {
    if (!this.layout) return;
    this.geometry = mapGeometry(this.layout, { width: this.viewport.clientWidth, height: this.viewport.clientHeight }, this.zoom);
    this.canvas.style.width = `${this.geometry.width}px`;
    this.canvas.style.height = `${this.geometry.height}px`;
    this.stage.style.left = `${this.geometry.offsetX}px`;
    this.stage.style.top = `${this.geometry.offsetY}px`;
    this.stage.style.transform = `scale(${this.zoom})`;
    this.zoomLabel.textContent = this.zoom < .01 ? '<1%' : `${Math.round(this.zoom * 100)}%`;
  }

  zoomBy(factor, start, point) {
    if (!this.layout) return;
    const fromZoom = start?.zoom ?? this.zoom;
    const fromScroll = start?.scroll ?? { x: this.viewport.scrollLeft, y: this.viewport.scrollTop };
    const viewport = { width: this.viewport.clientWidth, height: this.viewport.clientHeight };
    const minZoom = Math.min(.12, fitZoom(this.layout, viewport));
    const zoom = Math.min(1.8, Math.max(minZoom, fromZoom * factor));
    const scroll = zoomScroll(this.layout, viewport, fromScroll, fromZoom, zoom, start?.point, point);
    this.zoom = zoom; this.transform();
    this.viewport.scrollTo(scroll.x, scroll.y);
  }

  fit() {
    if (!this.layout) return;
    this.zoom = fitZoom(this.layout, { width: this.viewport.clientWidth, height: this.viewport.clientHeight });
    this.transform();
    this.viewport.scrollTo(0, 0);
  }

  focusWord() {
    if (!this.layout) return;
    this.zoom = 1;
    this.transform();
    const word = this.layout.nodes[0];
    this.viewport.scrollTo(word.x + this.geometry.offsetX - 24,
      word.y + word.height / 2 + this.geometry.offsetY - this.viewport.clientHeight / 2);
  }

  setAll(collapsed) {
    walk(this.tree, (n) => { n.collapsed = collapsed && n.kind !== 'word'; });
    this.render(this.tree);
  }

  renderNode(node) {
    const hasChildren = node.children.length > 0;
    const item = el('article', {
      class: `tnode map-node kind-${node.kind}` + (node.proto ? ' proto' : ''),
      'data-key': node.key,
    });

    const twisty = hasChildren
      ? el('button', {
          type: 'button', class: 'twisty', 'aria-label': `${node.collapsed ? '展開' : '收合'} ${nodeLabel(node)}`, 'aria-expanded': String(!node.collapsed),
          onclick: () => { node.collapsed = !node.collapsed; this.render(); },
        }, node.collapsed ? '+' : '−')
      : el('span', { class: 'twisty spacer', 'aria-hidden': 'true' });

    item.append(el('div', { class: 'row' }, twisty, this.renderBody(node), this.renderActions(node)));
    return item;
  }

  renderBody(node) {
    if (node.kind === 'group') return el('div', { class: 'body' },
      el('span', { class: 'group-label' }, nodeLabel(node)),
      node.children.every(child => child.kind === 'part')
        ? el('div', { class: 'gloss' }, node.children.map(child => isMasked(child) ? '？' : child.term).join(' + ')) : null);

    const label = node.kind === 'step'
      ? (RELATION[node.relation] || node.relation) + (node.note && !isMasked(node) ? `（${node.note}）` : '')
      : node.kind === 'part' ? '構詞成分' : node.kind === 'root' ? '詞根關聯' : node.kind === 'family' ? node.relationLabel
        : node.verifiedAnchor ? nodeLabel(node) : node.relationLabel || (node.kind === 'doublet' ? '同源異形詞（共同來源）' : '探索中的單字');
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
      node.familySource ? external(node.familySource, 'Wiktionary 的字族分類來源', '字族分類 ↗') : null,
      node.relationSource ? external(node.relationSource, 'Wiktionary 記載此關係的來源', '關係來源 ↗') : null,
      node.originSource ? external(node.originSource, '已核對的共同來源詞條', '共同來源 ↗') : null,
      node.message ? el('div', { class: 'muted small' }, node.message) : null);
  }

  renderActions(node) {
    const actions = [];
    if (node.family) {
      actions.push(el('button', { type: 'button', class: 'action', disabled: node.familyLoading || node.familyExhausted, onclick: () => this.loadFamily(node) },
        node.familyLoading ? '讀取字族中…' : node.familyAmbiguous ? '意思未標示' : node.familyExhausted ? `已加入全部${familyNoun(node)}`
          : node.familyMembers ? `加入更多${familyNoun(node)}` : `找${familyNoun(node)}`));
      actions.push(el('a', { class: 'action', href: node.family }, '字族清單'));
    }
    if (node.kind === 'family' || (node.relationLabel && node.lang === 'en')) actions.push(el('a', { class: 'action', href: exploreHref(node.term) }, '探索詞源'));
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
    this.render(node);
    try {
      const result = await engine.lookupEntry(node.lookup.lang, node.lookup.term, node.lookup.id);
      const etymologies = result.etymologies;
      let added = 0;
      if (etymologies.length === 1) {
        added = attachEtymology(node, etymologies[0], result.word, result.lang);
      } else {
        etymologies.forEach((ety, i) => {
          if (!(ety.steps.length || ety.morphology.length || ety.roots.length || ety.doublets?.length || ety.etymologicalRelations?.length)) return;
          const key = `${node.key}#${i + 1}`;
          let group = node.children.find(child => child.key === key);
          if (!group) {
            group = { key, kind: 'group', familyAllowed: node.familyAllowed, label: `同形詞 ${i + 1}${ety.id ? `：${ety.id}` : ''}`, children: [] };
            node.children.push(group);
          }
          added += attachEtymology(group, ety, result.word, result.lang);
        });
      }
      node.loaded = result.complete !== false;
      node.collapsed = false;
      node.message = !node.loaded ? [...(result.warnings || []), '資料尚未完整，可再按「展開來源」重試。'].join(' ')
        : added || node.children.length ? null : '目前未解析出更多來源或詞源相關字；不代表沒有關聯，可開啟 Wiktionary 查看原文。';
    } catch (error) {
      node.message = error.status === 429 || error.status === 503 ? 'Wiktionary 暫時限流，請稍後再試。' : error.message;
    } finally {
      node.loading = false;
      this.render(node);
    }
  }

  async loadFamily(node, background = false) {
    if (node.familyLoading || node.familyExhausted) return;
    node.familyLoading = true;
    this.render(background ? undefined : node);
    try {
      if (!node.familyMembers) {
        const family = node.familyKind === 'prefix'
          ? await engine.prefixFamily(node.lang, node.familyRoot, node.familyId)
          : await engine.rootFamily(node.lang, node.familyRoot || node.term, node.familyId);
        // Common words first; without the frequency file the list still sorts by form and length.
        const ranks = await loadFrequencyRanks().catch(() => null);
        node.familyMembers = [...family.members].sort(familyComparator(ranks));
        node.familySource = family.categoryUrl;
        node.familyTotal = family.total;
        node.familyAmbiguous = family.ambiguous;
        node.familySenses = family.senses;
      }
      if (node.familyAmbiguous) {
        node.familyExhausted = true;
        node.message = ambiguousFamilyMessage(node.familyKind, node.familyRoot, node.familySenses);
        this.setRelatedStatus(node.message, node);
        return;
      }
      const present = new Set(node.children.filter(n => n.kind === 'family').map(n => n.term));
      const more = node.familyMembers.filter(term => term !== this.tree.term && !present.has(term)).slice(0, 8);
      more.forEach(term => this.addFamilyWord(node, term));
      if (!background) node.collapsed = false;
      this.updateFamilyMessage(node);
      this.setRelatedStatus(node.message, node);
    } catch (error) {
      node.message = `${error.message}，可再按字族按鈕重試。`;
      this.setRelatedStatus(node.message, node);
      return error.status === 404 ? undefined : false;
    } finally {
      node.familyLoading = false;
      this.render(background ? undefined : node);
    }
  }

  addFamilyWord(owner, term) {
    if (!owner.familyMembers?.includes(term) || term === this.tree.term || owner.children.some(child => child.kind === 'family' && child.term === term)) return null;
    const node = {
      key: `family:${owner.key}:${term}`, kind: 'family', term, lang: 'en', langName: 'English', maskable: false, children: [],
      lookup: { lang: 'en', term, id: null },
      url: 'https://en.wiktionary.org/wiki/' + encodeURIComponent(term) + '#English',
      relationSource: owner.familySource,
      relationLabel: owner.familyKind === 'prefix' ? '同字首的字（共同構詞）' : '同根詞（共同來源）',
    };
    owner.children.push(node);
    this.updateFamilyMessage(owner);
    return node;
  }

  updateFamilyMessage(owner) {
    const count = owner.children.filter(child => child.kind === 'family').length;
    owner.familyExhausted = owner.familyMembers.filter(word => word !== this.tree.term).length <= count;
    const noun = owner.familyKind === 'prefix' ? '同字首的字' : '同根詞';
    owner.message = count ? `已加入 ${count} 個${noun}。${owner.familyExhausted ? `已顯示本次取得的全部${noun}。` : '可繼續加入，或搜尋已取得的清單。'}` : '這個分類目前沒有其他英語詞條；不代表沒有同源詞。';
    if (owner.familyTotal > owner.familyMembers.length) owner.message += ` 此分類共 ${owner.familyTotal} 筆，目前取得前 ${owner.familyMembers.length} 筆。`;
  }
}

function toolbar(views, story) {
  const each = (fn) => views.forEach((v) => fn(v));
  const hideToggle = el('input', { type: 'checkbox', checked: memory.hideRemembered, onchange: (e) => { memory.hideRemembered = e.target.checked; memory.peeked.clear(); each((v) => v.render()); } });
  const quizButton = el('button', { type: 'button', class: 'secondary' }, memory.quiz ? '結束測驗' : '測驗：全部遮住');
  quizButton.addEventListener('click', () => {
    memory.quiz = !memory.quiz;
    story.hidden = memory.quiz;
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
    el('section', { class: 'home-hero' },
      el('p', { class: 'eyebrow' }, 'FOLLOW YOUR CURIOSITY'),
      el('h1', {}, '從一個意思，', el('br'), '發現一整個字族。'),
      el('p', { class: 'hero-description' }, '先找同義詞與反義詞，挑一個感興趣的字，再沿著詞源地圖，看看它和哪些字有共同的起點。'),
      el('div', { class: 'bulk-actions' }, el('a', { class: 'primary-link', href: '#/bulk' }, '批次掃描同反義詞 →'),
        el('a', { href: '#/saved' }, '查看收藏單字')),
      el('div', { class: 'learning-home-callout' },
        el('div', {}, el('h2', {}, '這個連結，能幫你讀懂下一個字嗎？'),
          el('p', {}, '從兩個例子開始，用新句子練習推論，也學會判斷何時需要更多語境。')),
        el('a', { class: 'primary-link', href: '#/learn' }, '開始推論練習 →')),
      el('div', { class: 'chips example-chips' }, EXAMPLES.map(w => el('a', { class: 'chip', href: wordHref(w) }, w, ' ↗'))),
      el('p', { class: 'muted small' }, '在上方輸入單字，或從這些字開始。')),
    el('div', { class: 'journey' },
      el('section', { class: 'card' }, el('span', { class: 'step-number' }, '01'), el('h2', {}, '從意思出發'), el('p', {}, '比較同義與反義，依詞性和詞義找到你想深入了解的字。')),
      el('section', { class: 'card' }, el('span', { class: 'step-number' }, '02'), el('h2', {}, '沿著來源探索'), el('p', {}, '在大地圖上橫向追溯語言演變，展開詞素，看清每個字如何形成。')),
      el('section', { class: 'card' }, el('span', { class: 'step-number' }, '03'), el('h2', {}, '讓字族長出來'), el('p', {}, '找到詞根，將同根詞加入同一張地圖，把單字連成有意義的脈絡。'))),
    el('p', { class: 'source-note' }, '同義、反義描述意思；同根詞描述來源。意思相近的字，不一定有相同詞源。資料即時取自 Wiktionary。'),
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

  const tree = new EtymologyMap(buildTree(result, ety), ety);
  views.push(tree);
  card.append(tree.element, tree.stats);
  tree.render();

  if (ety.doublets.length > 0) {
    card.append(el('h3', {}, '同源異形詞（doublet）'),
      el('div', { class: 'chips' }, ety.doublets.map((d) => chip(d.term, null, d.lang === 'en' ? exploreHref(d.term) : d.url))));
  }

  // The story card already states today's meaning; the full lists stay one click away.
  const withSenses = ety.partsOfSpeech.filter((p) => p.senses.length > 0);
  const translations = ety.partsOfSpeech.flatMap((p) => p.translations.map((t) => ({ pos: p.pos, ...t })));
  const senseCount = withSenses.reduce((sum, p) => sum + p.senses.length, 0);
  if (withSenses.length > 0 || translations.length > 0) {
    card.append(el('details', { class: 'more-senses' },
      el('summary', {}, `全部釋義（${senseCount}）${translations.length ? '與中文翻譯' : ''}`),
      withSenses.flatMap((p) => [
        el('div', { class: 'pos' }, POS[p.pos] || p.pos),
        el('ol', { class: 'senses' }, p.senses.map((s) => el('li', {}, s))),
      ]),
      translations.length ? [
        el('h3', {}, '中文翻譯（Wiktionary 翻譯表，依詞義）'),
        el('dl', { class: 'translations' }, translations.flatMap((t) => [
          el('dt', {}, `${POS[t.pos] || t.pos}${t.sense ? '：' + t.sense : ''}`),
          el('dd', {}, t.mandarin.join('、')),
        ])),
        el('p', { class: 'muted small' }, '依 Wiktionary 原文呈現，部分詞條為簡體字。'),
      ] : null));
  }

  if (ety.text) card.append(el('details', {}, el('summary', {}, '詞源原文'), el('p', {}, ety.text)));
  return card;
}

/**
 * Answer first: the same three questions for every word, each answered in a line or two from the
 * lookup, before the map that holds the evidence. Nothing here is generated beyond the data.
 */
function storyCard(result, ety) {
  const story = buildWordStory(result, ety);
  const card = el('section', { class: 'card story-card', 'aria-labelledby': 'story-title' },
    el('p', { class: 'eyebrow' }, 'WHY THIS WORD'),
    el('h2', { id: 'story-title' }, `為什麼 ${result.word} 是這個意思？`));
  if (story.empty) {
    card.append(el('p', { class: 'muted' }, '這個詞條的資料不足以整理成三個答案，可以直接看下方的地圖與詞源原文。'));
    return card;
  }
  if (story.headline) card.append(el('p', { class: 'story-headline' }, story.headline));

  const term = (text) => el('span', { class: 'story-term' }, text);
  const gloss = (text) => text ? el('span', { class: 'story-gloss' }, `「${text}」`) : null;
  const answers = el('ol', { class: 'story-answers' });

  if (story.literal) {
    answers.append(el('li', {}, el('h3', {}, '字面上是什麼？'),
      el('p', { class: 'story-literal' },
        story.literal.parts.flatMap((part, i) => [i ? el('span', { class: 'plus' }, ' + ') : null, term(part.term), gloss(part.gloss)]),
        el('span', { class: 'muted small' }, ` ${langZh(story.literal.langName)}`)),
      story.literal.via ? el('p', { class: 'muted small' }, `經由${langZh(story.literal.via.langName)} ${story.literal.via.term} 的構詞。`) : null));
  }

  if (story.path.length > 1 || story.stable) {
    answers.append(el('li', {}, el('h3', {}, '意思怎麼走到今天？'),
      el('ol', { class: 'story-path' }, story.path.map(point => el('li', { class: `story-point ${point.kind}` },
        el('span', { class: 'story-lang' }, point.kind === 'today' ? '今天' : point.kind === 'older' ? `英語舊義（${point.label}）` : langZh(point.langName)),
        term(point.term), ' ', el('span', { class: 'story-gloss' }, point.gloss),
        point.zh?.length ? el('span', { class: 'story-zh' }, point.zh.join('、')) : null))),
      story.stable ? el('p', { class: 'muted small' }, '祖源詞的釋義相近，這裡只列出最早的祖源詞。') : null));
  }

  const feel = feelLines(story);
  if (feel.length) {
    answers.append(el('li', {}, el('h3', {}, '為什麼是這種語感？'), feel.map(line => el('p', {}, line))));
  }

  card.append(answers,
    el('p', { class: 'muted small story-source' }, '以上只從 Wiktionary 詞條挑出並排列，沒有額外推測；完整證據在下方地圖。'));
  return card;
}

async function renderWord(word) {
  const request = navigation;
  document.title = `${word} · EtymoVocab`;
  input.value = word;
  showLoading(`正在查詢 ${word} 的同義詞與反義詞…`);
  let result;
  try {
    result = await engine.lookupRelated(word);
  } catch (error) {
    if (request === navigation) view.replaceChildren(errorCard(error, () => renderWord(word)));
    return;
  }
  if (request !== navigation) return;

  const posNames = [...new Set(result.etymologies.flatMap(ety => ety.partsOfSpeech.map(p => p.pos)))];
  const posFilter = el('select', { 'aria-label': '篩選詞性' }, el('option', { value: '' }, '所有詞性'),
    posNames.map(pos => el('option', { value: pos }, POS[pos] || pos)));
  const etyFilter = el('select', { 'aria-label': '篩選詞源詞條' }, el('option', { value: '' }, '所有詞源詞條'),
    result.etymologies.map((ety, i) => el('option', { value: String(i) }, `詞源 ${i + 1}${ety.id ? ` · ${ety.id}` : ''}`)));
  const columns = el('div', { class: 'relation-columns' });
  const definition = el('div', { class: 'discovery-definition' });
  const draw = () => {
    const entries = result.etymologies.flatMap((ety, index) =>
      (etyFilter.value === '' || Number(etyFilter.value) === index)
        ? ety.partsOfSpeech.filter(pos => !posFilter.value || pos.pos === posFilter.value).map(pos => ({ ...pos, ety: index })) : []);
    definition.replaceChildren(...entries.slice(0, 3).map(pos => el('p', {},
      el('span', { class: 'pos-tag' }, POS[pos.pos] || pos.pos), ' ', pos.senses[0] || '',
      pos.translations[0]?.mandarin.length ? el('span', { class: 'translation-summary' }, pos.translations[0].mandarin.join('、')) : null)));
    columns.replaceChildren(...['synonym', 'antonym'].map(kind => {
      const groups = entries.flatMap(pos => (pos.relations || []).filter(relation => relation.kind === kind).map(relation => ({ ...relation, pos: pos.pos, ety: pos.ety })));
      const count = new Set(groups.flatMap(group => group.terms)).size;
      return el('section', { class: `card relation-column ${kind}` },
        el('div', { class: 'relation-heading' }, el('h2', {}, kind === 'synonym' ? '同義詞' : '反義詞'), el('span', { class: 'count' }, count)),
        el('p', { class: 'muted small' }, kind === 'synonym' ? '相近的意思，另一種表達。' : '從相反的方向，理解這個意思。'),
        groups.length ? groups.map(group => el('div', { class: 'relation-group' },
          el('p', { class: 'relation-sense' }, el('span', { class: 'pos-tag' }, POS[group.pos] || group.pos),
            result.etymologies.length > 1 ? ` 詞源 ${group.ety + 1} · ` : ' ', group.sense || '未標示詞義'),
          el('div', { class: 'chips' }, group.terms.map(term => el('div', { class: 'discovery-word' },
            el('a', { class: 'pick-word', href: exploreHref(term), title: `探索 ${term} 的詞源` }, term, ' ↗'),
            el('a', { class: 'lookup-related', href: wordHref(term), 'aria-label': `查詢 ${term} 的同義詞與反義詞`, title: '繼續查同反義詞' }, '↔'),
            vocabularyView.saveButton(term, { query: word, sourceWord: result.word, relation: kind, pos: group.pos,
              sense: group.sense, etymologyId: String(result.etymologies[group.ety].id || result.etymologies[group.ety].number || ''), sourceUrl: result.source.url })))), thesaurusLinks(el, group.thesaurusTargets)))
          : el('div', { class: 'empty-state' }, el('p', {}, `Wiktionary 尚未列出${kind === 'synonym' ? '同義詞' : '反義詞'}。`),
            el('p', { class: 'muted small' }, '可以直接探索這個字的詞源，或換個詞性與詞條。')));
    }));
  };
  posFilter.addEventListener('change', draw);
  etyFilter.addEventListener('change', draw);
  view.replaceChildren(
    el('nav', { class: 'breadcrumbs', 'aria-label': '探索步驟' }, el('a', { href: '#/' }, '單字探索'), ' / ', '同義與反義'),
    el('div', { class: 'page-heading' },
      el('div', {}, el('p', { class: 'eyebrow' }, '01 / DISCOVER'), el('h1', { class: 'word-title' }, result.word)),
      el('div', { class: 'bulk-actions' }, vocabularyView.saveButton(result.word, { query: word, sourceWord: result.word, sourceUrl: result.source.url }),
        el('a', { class: 'primary-link', href: exploreHref(result.word) }, `為什麼 ${result.word} 是這個意思？→`))),
    inflectionNote(result),
    ...result.warnings.map(w => el('div', { class: 'notice' }, w)),
    el('div', { class: 'filter-row' }, posFilter, result.etymologies.length > 1 ? etyFilter : null),
    definition,
    el('p', { class: 'muted small' }, '點單字開啟詞源地圖；點 ↔ 繼續找同反義詞；按「＋ 收藏」加入獨立清單。'),
    columns,
    sourceNote(result),
  );
  draw();
}

function inflectionNote(result, exploring = false) {
  // Native replaceChildren() turns null into visible text; an empty fragment inserts nothing.
  if (!result.resolvedFrom && !result.baseForms?.length) return document.createDocumentFragment();
  return el('div', { class: 'notice' },
    result.resolvedFrom ? el('p', {}, `「${result.resolvedFrom}」是詞形變化，以下顯示原形「${result.word}」的資料。`) : null,
    result.baseForms?.length ? el('p', {}, '詞條也列出以下原形，可繼續查詢：',
      result.baseForms.map((term, index) => el('span', {}, index ? '、' : '',
        el('a', { href: exploring ? exploreHref(term) : wordHref(term) }, term)))) : null);
}

function sourceNote(result) {
  const revisionDate = new Date(result.source.revisionTimestamp).toLocaleDateString('zh-TW');
  return el('p', { class: 'meta source-note' },
    '來源：', el('a', { href: result.source.url, target: '_blank', rel: 'noopener' }, `Wiktionary 修訂版 ${result.source.revisionId}`),
    `（${revisionDate}）· ${result.source.license}`);
}

async function renderExplore(word) {
  const request = navigation;
  document.title = `${word} 詞源地圖 · EtymoVocab`;
  input.value = word;
  memory.peeked.clear();
  showLoading(`正在追溯 ${word} 的詞源…`);
  let result;
  try {
    result = await engine.lookupWord(word);
  } catch (error) {
    if (request === navigation) view.replaceChildren(errorCard(error, () => renderExplore(word)));
    return;
  }
  if (request !== navigation) return;
  const content = el('div');
  const selector = el('select', { 'aria-label': '選擇詞源' }, result.etymologies.map((ety, i) =>
    el('option', { value: String(i) }, `詞源 ${i + 1}${ety.id ? ` · ${ety.id}` : ''}${ety.partsOfSpeech[0]?.senses[0] ? ' · ' + ety.partsOfSpeech[0].senses[0].slice(0, 70) : ''}`)));
  const draw = () => {
    memory.peeked.clear();
    const views = [];
    const ety = result.etymologies[Number(selector.value) || 0];
    if (!ety) { content.replaceChildren(el('p', { class: 'notice' }, '這個詞條尚無詞源資料。')); return; }
    const card = renderEtymologyCard(result, ety, 0, 1, views);
    const story = storyCard(result, ety);
    story.hidden = memory.quiz && views.length > 0;
    content.replaceChildren(story,
      el('h2', { class: 'evidence-title' }, '證據：完整詞源地圖'),
      views.length ? toolbar(views, story) : el('p', { class: 'notice' }, '尚無結構化詞源，可查看釋義與詞源原文。'), card);
    views.forEach(tree => { tree.render(); tree.focusWord(); void tree.loadInitialFamilies(); void tree.reverse.start(); });
  };
  selector.addEventListener('change', draw);
  view.replaceChildren(
    el('nav', { class: 'breadcrumbs', 'aria-label': '探索步驟' }, el('a', { href: wordHref(word) }, '← 同義詞與反義詞'), ' / 詞源地圖'),
    el('div', { class: 'page-heading' },
      el('div', {}, el('p', { class: 'eyebrow' }, '02 / EXPLORE THE ORIGINS'), el('h1', { class: 'word-title' }, result.word)),
      el('div', { class: 'bulk-actions' }, vocabularyView.saveButton(result.word, { query: word, sourceWord: result.word, sourceUrl: result.source.url }),
        el('p', { class: 'muted small' }, '沿著來源向右探索，在詞根上找同根詞。'))),
    inflectionNote(result, true),
    ...(result.etymologies.length > 1 ? [el('div', { class: 'filter-row' }, el('label', {}, '不同詞源分開探索 ', selector))] : []),
    ...result.warnings.map((w) => el('div', { class: 'notice' }, w)),
    content,
    sourceNote(result),
  );
  draw();
}

async function renderRoot(lang, root, { kind = 'root', id = null } = {}) {
  const request = navigation;
  const prefix = kind === 'prefix';
  document.title = `${root} · EtymoVocab`;
  showLoading(prefix ? `正在讀取 ${root} 開頭的字…` : `正在讀取 ${root} 的字族…`);
  const ranksLoading = loadFrequencyRanks().catch(() => null); // in parallel with the category request
  let family;
  try {
    family = prefix ? await engine.prefixFamily(lang, root, id) : await engine.rootFamily(lang, root, id);
  } catch (error) {
    if (request === navigation) view.replaceChildren(errorCard(error, () => renderRoot(lang, root, { kind, id })));
    return;
  }
  const ranks = await ranksLoading;
  if (request !== navigation) return;

  if (family.ambiguous) {
    view.replaceChildren(el('div', { class: 'card' },
      el('h1', {}, family.root),
      el('p', { class: 'meta' }, family.langName, prefix ? '・字首' : '', '・',
        el('a', { href: family.categoryUrl, target: '_blank', rel: 'noopener' }, 'Wiktionary 分類')),
      el('p', {}, ambiguousFamilyMessage(kind, family.root, family.senses).replace('可在「字族清單」選擇意思。', '請選擇一個意思：')),
      el('div', { class: 'chips' }, family.senses.map(sense =>
        chip(`${family.root} (${sense.id})`, `${sense.size} 個字`, familyHref({ kind, lang, term: family.root, id: sense.id }))))));
    return;
  }

  const filter = el('input', { type: 'search', placeholder: '篩選，例如 spect', 'aria-label': '篩選字族' });
  const sort = el('select', { 'aria-label': '排序方式' },
    el('option', { value: 'common' }, ranks ? '常用字優先（依詞頻）' : '常用字優先（暫依字長）'),
    el('option', { value: 'alpha' }, '依字母'));
  const byCommonness = familyComparator(ranks);
  const list = el('div', { class: 'chips' });
  const count = el('p', { class: 'muted small' });

  const draw = () => {
    const needle = filter.value.trim().toLowerCase();
    const members = family.members.filter((m) => m.toLowerCase().includes(needle));
    if (sort.value === 'common') members.sort(byCommonness);
    list.replaceChildren(...members.map((m) => chip(m, null, exploreHref(m))));
    const shown = family.total > family.members.length ? `（分類共 ${family.total} 筆，列出前 ${family.members.length} 筆）` : '';
    count.textContent = `顯示 ${members.length} 個字${shown}`;
  };
  filter.addEventListener('input', draw);
  sort.addEventListener('change', draw);

  view.replaceChildren(el('div', { class: 'card' },
    el('h1', {}, family.root),
    el('p', { class: 'meta' }, family.langName, prefix ? '・字首' : '', family.gloss ? `・${family.gloss}` : '', '・',
      el('a', { href: family.categoryUrl, target: '_blank', rel: 'noopener' }, 'Wiktionary 分類')),
    el('div', { class: 'filter-row' }, filter, sort),
    count,
    list,
    el('p', { class: 'muted small' }, ranks
      ? ['常用字優先依英文詞頻（wordfreq，CC BY-SA 4.0）排序；不在前 5 萬常用字內的字、人名與片語排在後面。',
        el('a', { href: 'data/README.md', target: '_blank', rel: 'noopener' }, '詞頻資料來源')]
      : '詞頻資料暫時無法載入，目前依字形與字長排序。'),
  ));
  draw();
}

function route() {
  clearSearchSuggestions();
  vocabularyView.leave();
  navigation += 1;
  const hash = location.hash.replace(/^#\/?/, '');
  const [kind, ...rest] = hash.split('/');
  document.querySelectorAll('.site-nav a').forEach(link => {
    const section = ['learn', 'bulk', 'saved'].includes(kind) ? kind : 'explore';
    const active = link.dataset.section === section;
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  try {
    if (kind === 'bulk') return vocabularyView.renderBulk();
    if (kind === 'saved') return vocabularyView.renderSaved();
    if (kind === 'learn' && rest.length <= 2) return learningView.render(rest[0] ? decodeURIComponent(rest[0]) : null, rest[1]);
    if (kind === 'w' && rest[0]) return renderWord(decodeURIComponent(rest.join('/')));
    if (kind === 'explore' && rest[0]) return renderExplore(decodeURIComponent(rest.join('/')));
    if (kind === 'root' && rest.length >= 2) {
      // #/root/{lang}/{term}?kind=prefix&id=fare — encoded terms never contain a raw "?".
      const [term, search = ''] = rest.slice(1).join('/').split('?');
      const query = new URLSearchParams(search);
      return renderRoot(decodeURIComponent(rest[0]), decodeURIComponent(term),
        { kind: query.get('kind') === 'prefix' ? 'prefix' : 'root', id: query.get('id') });
    }
  } catch {
    /* malformed URI: fall through to home */
  }
  return renderHome();
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const word = input.value.trim();
  if (!word) return;
  clearSearchSuggestions();
  const target = wordHref(word);
  if (location.hash === target) route();
  else location.hash = target;
});

let suggestTimer;
let searchVersion = 0;
let activePrediction;
let nextPrediction;

function clearSearchSuggestions() {
  clearTimeout(suggestTimer);
  searchVersion++;
  nextPrediction = undefined;
  suggestions.replaceChildren();
}

async function predict(title) {
  nextPrediction = title === activePrediction ? undefined : title;
  if (activePrediction) return;
  try {
    while (nextPrediction && !engine.backgroundPaused()) {
      activePrediction = nextPrediction;
      nextPrediction = undefined;
      try {
        // renderWord uses the same pending promise and completed-result cache.
        await engine.lookupRelated(activePrediction);
      } catch { /* A failed guess is silent; a submitted search handles its own errors. */ }
    }
  } finally {
    activePrediction = undefined;
    nextPrediction = undefined;
  }
}

input.addEventListener('focus', () => engine.preload().catch(() => {}), { once: true });
input.addEventListener('input', () => {
  clearSearchSuggestions();
  const q = input.value.trim();
  if (q.length < 2 || engine.backgroundPaused()) return;
  const version = searchVersion;
  suggestTimer = setTimeout(async () => {
    try {
      if (engine.backgroundPaused()) return;
      const titles = await engine.suggest(q);
      if (version !== searchVersion) return;
      suggestions.replaceChildren(...titles.map((t) => el('option', { value: t })));
      if (titles.length) void predict(titles[0]);
    } catch { /* suggestions are optional */ }
  }, 300);
});

window.addEventListener('hashchange', route);
route();
