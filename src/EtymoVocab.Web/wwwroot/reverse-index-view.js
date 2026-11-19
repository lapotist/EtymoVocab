import { createReverseIndexClient, usableOrigins, verifySharedOrigin } from './reverse-index.js';

const client = createReverseIndexClient();
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child != null) node.append(child?.nodeType ? child : document.createTextNode(String(child)));
  return node;
}

export function createReverseDiscovery({ word, etymology, lookup, onVerified, isActive,
  displayAnchor, getBackoffUntil, observeBackoff, getExcluded = () => new Set(), index = client, now = () => Date.now() }) {
  let started = false, candidates = [], filter = '', visible = 12, queue = Promise.resolve();
  let status = '正在尋找共同來源…', manifest;
  const states = new Map();
  const summary = el('summary', {}, '從共同來源發現更多字');
  const message = el('p', { class: 'muted small', role: 'status', 'aria-live': 'polite' });
  const list = el('div', { class: 'chips reverse-candidate-list' });
  const more = el('button', { type: 'button', class: 'secondary', onclick: () => { visible += 24; render(); } }, '顯示更多候選');
  const next = el('button', { type: 'button', class: 'secondary', onclick: () => verifyNext() }, '核對下一批');
  const retry = el('button', { type: 'button', class: 'secondary', onclick: () => start() }, '重新讀取索引');
  const attribution = el('p', { class: 'muted small' });
  const element = el('details', { class: 'reverse-discovery', hidden: !usableOrigins(etymology).length }, summary,
    el('p', { class: 'muted small' }, '從字典快照找出候選，再核對目前詞源；成功核對的字才會加入地圖。可用上方搜尋欄篩選。'),
    message, list, el('div', { class: 'bulk-actions' }, more, next, retry), attribution);

  function filtered() { return candidates.filter(item => !filter || item.word.toLocaleLowerCase().includes(filter)); }
  function render() {
    const focused = element.contains(document.activeElement) ? document.activeElement?.dataset.indexWord : null;
    const matches = filtered();
    const count = [...states.values()].filter(state => state.kind === 'verified').length;
    summary.textContent = `從共同來源發現更多字（已核對 ${count} 字／候選 ${candidates.length} 字）`;
    const seconds = Math.ceil((getBackoffUntil() - now()) / 1000);
    const notice = seconds > 0 ? `Wiktionary 暫時限流，約 ${seconds} 秒後可再核對。` : status;
    message.textContent = notice + (filter ? ` 符合篩選 ${matches.length} 字。` : '');
    list.replaceChildren(...matches.slice(0, visible).map(item => {
      const state = states.get(item.word);
      const label = state?.kind === 'verified' ? `已加入 ${state.match.term}`
        : state?.kind === 'pending' ? `核對中 ${item.word}` : state?.kind === 'unconfirmed' ? `未確認 ${item.word}` : `核對 ${item.word}`;
      return el('button', { type: 'button', class: 'secondary', 'data-index-word': item.word,
        disabled: ['verified', 'pending', 'unconfirmed'].includes(state?.kind),
        title: state?.kind === 'unconfirmed' ? '目前未找到相同且可確認的詞源或構詞身分；未加入地圖。' : `候選來源：${item.anchors.map(displayAnchor).join('、')}`,
        onclick: () => verify(item, true),
      }, label);
    }));
    more.hidden = matches.length <= visible;
    next.hidden = !matches.some(item => !states.has(item.word));
    retry.hidden = started;
    if (focused) {
      const replacement = [...list.querySelectorAll('button')].find(button => button.dataset.indexWord === focused && !button.disabled);
      (replacement || summary).focus({ preventScroll: true });
    }
  }

  function verify(item, manual = false) {
    if (['verified', 'pending', 'unconfirmed'].includes(states.get(item.word)?.kind)) return queue;
    if (now() < getBackoffUntil()) { render(); return queue; }
    states.set(item.word, { kind: 'pending' });
    render();
    const task = queue.then(async () => {
      if (!isActive() || now() < getBackoffUntil()) { states.delete(item.word); render(); return; }
      try {
        const result = await lookup(item.word);
        if (!isActive()) return;
        if (result?.complete !== true) throw result?.upstreamError || new Error('詞源資料尚未完整讀取');
        const match = verifySharedOrigin(etymology, result, word);
        states.set(item.word, match ? { kind: 'verified', match } : { kind: 'unconfirmed' });
        if (match) {
          onVerified(match, manual);
          status = `已確認 ${match.term}：${match.component ? '共用構詞成分' : '共同來源'}。`;
        } else status = `${item.word} 目前未能確認相同來源，沒有加入地圖。`;
      } catch (error) {
        observeBackoff(error);
        if (!isActive()) return;
        states.set(item.word, { kind: 'error' });
        status = `${item.word} 核對失敗，可稍後重試。`;
      }
      render();
    });
    queue = task.catch(() => {});
    return task;
  }

  async function verifyNext() {
    // A small first batch keeps ordinary searches quick; every candidate remains selectable.
    for (const item of filtered().filter(item => !states.has(item.word)).slice(0, 4)) {
      if (!isActive() || now() < getBackoffUntil()) break;
      await verify(item);
    }
  }

  async function start() {
    if (started || element.hidden || !isActive()) return;
    started = true;
    status = '正在尋找共同來源…'; render();
    try {
      const result = await index.discover(etymology, word, getExcluded());
      if (!isActive()) return;
      const excluded = getExcluded();
      candidates = result.candidates.filter(item => !excluded.has(item.word));
      manifest = result.manifest;
      if (manifest) attribution.replaceChildren(`字典快照：${manifest.source.dumpDate} · 索引包含 ${manifest.entryCount.toLocaleString()} 個字 · `,
        el('a', { href: 'https://kaikki.org/dictionary/English/index.html', target: '_blank', rel: 'noopener' }, 'Wiktionary／Kaikki'),
        ' · ', el('a', { href: manifest.source.licenseUrl || 'https://en.wiktionary.org/wiki/Wiktionary:Copyrights', target: '_blank', rel: 'noopener' }, manifest.source.license),
        '。索引涵蓋可解析的明確關係，並非完整字族。');
      status = candidates.length ? `找到 ${candidates.length} 個額外候選，先核對前 4 字；可自行篩選或繼續核對。`
        : '目前索引未找到額外候選；不代表沒有其他相關字。';
      render();
      await verifyNext();
    } catch (error) {
      if (!isActive()) return;
      started = false;
      status = `${error.message}；詞條明列的關係仍可使用。`;
      render();
    }
  }

  render();
  return { element, start, refresh: render, setFilter(value) {
    filter = value.normalize('NFC').trim().toLocaleLowerCase(); visible = 12;
    if (filter && !element.hidden) element.open = true;
    render();
  } };
}
