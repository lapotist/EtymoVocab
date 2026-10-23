import * as engine from './engine.js';
import { layoutTree, edgePath } from './map-layout.js';
import { mapGeometry, zoomScroll } from './map-viewport.js';
import { relatedGroups, addRelatedWord } from './map-related.js';

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

const wordHref = (word) => '#/w/' + encodeURIComponent(word);
const exploreHref = (word) => '#/explore/' + encodeURIComponent(word);
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
    collapsed: true,
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
    let match;
    [...node.children, ...added].forEach(child => walk(child, n => { if (n.key === root.key) match = n; }));
    if (match) Object.assign(match, { family: root.family, familyRoot: root.term, proto: true });
    else if (node.key === root.key) Object.assign(node, { family: root.family, familyRoot: root.term, proto: true });
    else if (!existing.has(root.key)) added.push({ ...root, rootReference: true });
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
// Horizontal etymology map

class EtymologyMap {
  constructor(tree, etymology) {
    this.tree = tree;
    this.relatedGroups = relatedGroups(etymology, tree.term);
    this.zoom = 1;
    this.stage = el('div', { class: 'map-stage' });
    this.canvas = el('div', { class: 'map-canvas' }, this.stage);
    this.viewport = el('div', {
      class: 'map-viewport', tabindex: '0', role: 'region', 'aria-label': '互動詞源地圖，可水平與垂直捲動、拖曳移動，方向鍵捲動，加減鍵縮放',
    }, this.canvas);
    this.zoomLabel = el('output', { class: 'zoom-label', 'aria-label': '地圖縮放比例' }, '100%');
    this.relatedOptions = el('div', { class: 'map-related-options' });
    this.relatedStatus = el('p', { class: 'muted small', role: 'status', 'aria-live': 'polite' });
    this.relatedPanel = el('details', { class: 'map-related', open: true },
      el('summary', {}, '將相關字加入地圖'),
      el('p', { class: 'muted small' }, '同義／反義表示意思；同根詞表示共同來源。按 ＋ 加入，再在新單字上展開來源。'),
      this.relatedOptions, this.relatedStatus);
    this.element = el('div', { class: 'map-panel' },
      el('div', { class: 'map-controls' },
        el('span', { class: 'map-direction' }, '單字 → 來源 · 加入同義、反義與同根詞'),
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
        el('span', {}, '捲動、拖曳或方向鍵移動 · ＋／− 縮放'),
        el('span', { class: 'legend-origin' }, '實線：來源／構詞'),
        el('span', { class: 'legend-family' }, '虛線：詞根關聯／同根詞'),
        el('span', { class: 'legend-related' }, '點線：同義／反義')));
    this.stats = el('p', { class: 'muted small' });
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
      path.setAttribute('class', edge.to.node.relatedRelation ? 'related-edge' :
        edge.to.node.kind === 'family' || edge.to.node.rootReference ? 'family-edge' : 'origin-edge');
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
    this.stats.textContent = total ? `${total} 個來源 · 已記住 ${remembered} 個。從上方加入相關字，或在詞根上找同根詞。` : 'Wiktionary 尚未提供結構化來源，仍可從上方加入相關字。';
    this.renderRelatedOptions();
  }

  renderRelatedOptions() {
    const focusedKey = document.activeElement?.dataset.relatedKey;
    const roots = new Map();
    walk(this.tree, node => {
      const key = `${node.lang}:${node.familyRoot || node.term}`;
      if (node.family && !roots.has(key)) roots.set(key, node);
    });
    this.relatedOptions.replaceChildren(
      el('section', { class: 'map-related-group' }, el('h3', {}, '同根詞'),
        roots.size ? el('div', { class: 'chips' }, [...roots.values()].map(node => {
          const term = isMasked(node) ? '已遮住的詞根' : node.familyRoot || node.term;
          return el('button', {
          type: 'button', class: 'secondary', 'data-related-key': `family:${node.key}`,
          disabled: node.familyLoading || node.familyExhausted,
          onclick: async () => {
            this.revealNode(node);
            await this.loadFamily(node);
            this.focusNode(node);
          },
        }, node.familyLoading ? '讀取字族中…' : node.familyExhausted ? `已加入全部 ${term} 同根詞` : `＋ ${term} 的同根詞`);
        }))
          : el('p', { class: 'muted small' }, '這個詞條未列出可查詢的詞根。')),
      ...this.relatedGroups.map(group => {
        const present = new Set(this.tree.children.find(child => child.key === group.key)?.children.map(child => child.term));
        return el('section', { class: 'map-related-group' },
          el('h3', {}, `${group.label} · ${POS[group.pos] || group.pos}${group.sense ? ' · ' + group.sense : ''}`),
          el('div', { class: 'chips' }, group.terms.map(term => el('button', {
            type: 'button', class: 'secondary', disabled: present.has(term),
            'data-related-key': `${group.key}:${term}`, 'aria-label': `${present.has(term) ? '已加入' : '加入'}${group.label} ${term}`,
            onclick: () => {
              const node = addRelatedWord(this.tree, group, term);
              if (!node) return;
              this.relatedStatus.textContent = `已將${group.label} ${term} 加入地圖。`;
              this.render(this.tree);
              this.focusNode(node);
            },
          }, `${present.has(term) ? '已加入' : '＋'} ${term}`))));
      }),
      ...(!this.relatedGroups.length ? [el('p', { class: 'muted small' }, 'Wiktionary 尚未列出這個詞條的同義詞或反義詞。')] : []));
    if (focusedKey) {
      const button = [...this.relatedOptions.querySelectorAll('button')].find(item => item.dataset.relatedKey === focusedKey);
      (button && !button.disabled ? button : this.relatedPanel.querySelector('summary')).focus({ preventScroll: true });
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
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
  }

  zoomBy(factor) {
    if (!this.layout) return;
    const zoom = Math.min(1.8, Math.max(.12, this.zoom * factor));
    const scroll = zoomScroll(this.layout, { width: this.viewport.clientWidth, height: this.viewport.clientHeight },
      { x: this.viewport.scrollLeft, y: this.viewport.scrollTop }, this.zoom, zoom);
    this.zoom = zoom; this.transform();
    this.viewport.scrollTo(scroll.x, scroll.y);
  }

  fit() {
    if (!this.layout) return;
    this.zoom = Math.max(.12, Math.min(1, (this.viewport.clientWidth - 32) / this.layout.width, (this.viewport.clientHeight - 32) / this.layout.height));
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
          type: 'button', class: 'twisty', 'aria-label': `${node.collapsed ? '展開' : '收合'} ${node.term || node.label}`, 'aria-expanded': String(!node.collapsed),
          onclick: () => { node.collapsed = !node.collapsed; this.render(); },
        }, node.collapsed ? '+' : '−')
      : el('span', { class: 'twisty spacer', 'aria-hidden': 'true' });

    item.append(el('div', { class: 'row' }, twisty, this.renderBody(node), this.renderActions(node)));
    return item;
  }

  renderBody(node) {
    if (node.kind === 'group') return el('div', { class: 'body' },
      el('span', { class: 'group-label' }, node.label),
      node.children.every(child => child.kind === 'part')
        ? el('div', { class: 'gloss' }, node.children.map(child => isMasked(child) ? '？' : child.term).join(' + ')) : null);

    const label = node.kind === 'step'
      ? (RELATION[node.relation] || node.relation) + (node.note ? `（${node.note}）` : '')
      : node.kind === 'part' ? '構詞成分' : node.kind === 'root' ? '詞根關聯' : node.kind === 'family' ? '同根詞（共同來源）'
        : node.kind === 'related' ? (node.relatedRelation === 'synonym' ? '同義詞（意思相近）' : '反義詞（意思相反）') : '探索中的單字';
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
      node.familySource ? external(node.familySource, '同根詞的 Wiktionary 分類來源', '字族分類 ↗') : null,
      node.message ? el('div', { class: 'muted small' }, node.message) : null);
  }

  renderActions(node) {
    const actions = [];
    if (node.family) {
      actions.push(el('button', { type: 'button', class: 'action', disabled: node.familyLoading || node.familyExhausted, onclick: () => this.loadFamily(node) },
        node.familyLoading ? '讀取字族中…' : node.familyExhausted ? '已加入全部同根詞' : node.familyMembers ? '加入更多同根詞' : '找同根詞'));
      actions.push(el('a', { class: 'action', href: node.family }, '字族清單'));
    }
    if (node.kind === 'family' || node.kind === 'related') actions.push(el('a', { class: 'action', href: exploreHref(node.term) }, '探索詞源'));
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
      this.render(node);
    }
  }

  async loadFamily(node) {
    node.familyLoading = true;
    this.render(node);
    try {
      if (!node.familyMembers) {
        const family = await engine.rootFamily(node.lang, node.familyRoot || node.term);
        node.familyMembers = [...family.members].sort((a, b) => a.length - b.length || a.localeCompare(b));
        node.familySource = family.categoryUrl;
        node.familyTotal = family.total;
      }
      const present = new Set(node.children.filter(n => n.kind === 'family').map(n => n.term));
      const more = node.familyMembers.filter(term => term !== this.tree.term && !present.has(term)).slice(0, 8);
      node.children.push(...more.map(term => ({
        key: `family:${node.key}:${term}`, kind: 'family', term, lang: 'en', langName: 'English', maskable: false, children: [],
        lookup: { lang: 'en', term, id: null },
        url: 'https://en.wiktionary.org/wiki/' + encodeURIComponent(term) + '#English',
      })));
      node.collapsed = false;
      node.familyExhausted = node.familyMembers.filter(term => term !== this.tree.term).length <= present.size + more.length;
      node.message = more.length ? `已加入 ${present.size + more.length} 個同根詞。${node.familyExhausted ? '已顯示所有可用的同根詞。' : '可繼續加入。'}` : '已顯示所有可用的同根詞。';
      if (node.familyTotal > node.familyMembers.length) node.message += ` 此分類共 ${node.familyTotal} 筆，目前取得前 ${node.familyMembers.length} 筆。`;
      this.relatedStatus.textContent = node.message;
    } catch (error) {
      node.message = `${error.message}，可再按「找同根詞」重試。`;
    } finally {
      node.familyLoading = false;
      this.render(node);
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
    el('section', { class: 'home-hero' },
      el('p', { class: 'eyebrow' }, 'FOLLOW YOUR CURIOSITY'),
      el('h1', {}, '從一個意思，', el('br'), '發現一整個字族。'),
      el('p', { class: 'hero-description' }, '先找同義詞與反義詞，挑一個感興趣的字，再沿著詞源地圖，看看它和哪些字有共同的起點。'),
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
            el('a', { class: 'lookup-related', href: wordHref(term), 'aria-label': `查詢 ${term} 的同義詞與反義詞`, title: '繼續查同反義詞' }, '↔'))))))
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
      el('a', { class: 'primary-link', href: exploreHref(result.word) }, `探索 ${result.word} 的詞源 →`)),
    inflectionNote(result),
    ...result.warnings.map(w => el('div', { class: 'notice' }, w)),
    el('div', { class: 'filter-row' }, posFilter, result.etymologies.length > 1 ? etyFilter : null),
    definition,
    el('p', { class: 'muted small' }, '點單字開啟詞源地圖；點 ↔ 繼續找它的同反義詞。'),
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
    content.replaceChildren(views.length ? toolbar(views) : el('p', { class: 'notice' }, '尚無結構化詞源，可查看釋義與詞源原文。'), card);
    views.forEach(tree => { tree.render(); tree.focusWord(); });
  };
  selector.addEventListener('change', draw);
  view.replaceChildren(
    el('nav', { class: 'breadcrumbs', 'aria-label': '探索步驟' }, el('a', { href: wordHref(word) }, '← 同義詞與反義詞'), ' / 詞源地圖'),
    el('div', { class: 'page-heading' },
      el('div', {}, el('p', { class: 'eyebrow' }, '02 / EXPLORE THE ORIGINS'), el('h1', { class: 'word-title' }, result.word)),
      el('p', { class: 'muted small' }, '沿著來源向右探索，在詞根上找同根詞。')),
    inflectionNote(result, true),
    ...(result.etymologies.length > 1 ? [el('div', { class: 'filter-row' }, el('label', {}, '不同詞源分開探索 ', selector))] : []),
    ...result.warnings.map((w) => el('div', { class: 'notice' }, w)),
    content,
    sourceNote(result),
  );
  draw();
}

async function renderRoot(lang, root) {
  const request = navigation;
  document.title = `${root} · EtymoVocab`;
  showLoading(`正在讀取 ${root} 的字族…`);
  let family;
  try {
    family = await engine.rootFamily(lang, root);
  } catch (error) {
    if (request === navigation) view.replaceChildren(errorCard(error, () => renderRoot(lang, root)));
    return;
  }
  if (request !== navigation) return;

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
    list.replaceChildren(...members.map((m) => chip(m, null, exploreHref(m))));
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
  navigation += 1;
  const hash = location.hash.replace(/^#\/?/, '');
  const [kind, ...rest] = hash.split('/');
  try {
    if (kind === 'w' && rest[0]) return renderWord(decodeURIComponent(rest.join('/')));
    if (kind === 'explore' && rest[0]) return renderExplore(decodeURIComponent(rest.join('/')));
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
  suggestions.replaceChildren();
  if (q.length < 2) return;
  suggestTimer = setTimeout(async () => {
    try {
      const titles = await engine.suggest(q);
      if (input.value.trim() !== q) return;
      suggestions.replaceChildren(...titles.map((t) => el('option', { value: t })));
    } catch { /* suggestions are optional */ }
  }, 300);
});

window.addEventListener('hashchange', route);
engine.preload().catch((error) => {
  view.replaceChildren(errorCard({ message: '無法載入查詢引擎', detail: `${error.message}（需要支援 WebAssembly 的瀏覽器）` }));
});
route();
