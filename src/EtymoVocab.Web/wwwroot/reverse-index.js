// The snapshot proposes words. Only current, identity-qualified dictionary evidence verifies them.
const genericAffixes = new Set(['-s', '-es', '-ed', '-ing', '-ly', '-ness', '-er', '-est', '-y', '-al', '-ic', '-ity', '-tion', '-ment',
  'un-', 're-', 'in-', 'de-', 'dis-', 'non-', 'pre-', 'post-', 'a-', 'en-', 'com-', 'con-', 'co-', 'ad-', 'ab-', 'sub-', 'super-',
  'trans-', 'inter-', 'pro-', 'ob-', 'ex-', '-us', '-um', '-a', '-o', '-i', '-io', '-is', '-ia']);
const priorities = { self: 0, ancestor: 1, component: 2, root: 3 };

export const originBucketKey = (anchor, title = anchor.title) => JSON.stringify([anchor.lang, title.normalize('NFC')]);

function discoveryKeys(anchor) {
  return [...new Set([anchor.title, ...(anchor.lookupAliases || [])].map(title => originBucketKey(anchor, title)))];
}

export function indexShard(key) {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(key)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return (hash & 255).toString(16).padStart(2, '0');
}

export function usableOrigins(etymology) {
  const seen = new Set();
  return (etymology?.originAnchors || []).filter(anchor => {
    if (!Object.hasOwn(priorities, anchor?.kind) || !anchor.key || !anchor.lang || !anchor.title || !anchor.url) return false;
    // A word still has a lexical identity when its older history is uncertain. Only that identity
    // can be used; speculative parents/components must never become verified shared sources.
    if (etymology.uncertain && anchor.kind !== 'self') return false;
    if (anchor.kind !== 'root' && genericAffixes.has(anchor.title)) return false;
    const identity = JSON.stringify([anchor.key, anchor.kind]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function candidateWords(anchors, origins, word, excluded = new Set()) {
  const found = new Map();
  for (const anchor of anchors) {
    const terms = new Set(discoveryKeys(anchor).flatMap(key => origins[key] || []));
    for (const term of terms) {
      if (typeof term !== 'string' || term === word || excluded.has(term)) continue;
      let item = found.get(term);
      if (!item) found.set(term, item = { word: term, anchors: [], priority: priorities[anchor.kind] });
      item.priority = Math.min(item.priority, priorities[anchor.kind]);
      if (!item.anchors.some(existing => existing.key === anchor.key)) item.anchors.push(anchor);
    }
  }
  return [...found.values()].sort((a, b) => a.priority - b.priority || b.anchors.length - a.anchors.length
    || Number(/\s/.test(a.word)) - Number(/\s/.test(b.word)) || a.word.length - b.word.length || a.word.localeCompare(b.word));
}

export function verifySharedOrigin(queryEtymology, result, queryWord) {
  if (!result?.complete || result.lang !== 'en' || result.word === queryWord || !result.source?.url) return null;
  const query = usableOrigins(queryEtymology);
  const matches = [];
  for (const etymology of result.etymologies || []) {
    for (const candidate of usableOrigins(etymology)) {
      for (const anchor of query) {
        // Equal spelling is insufficient. Keys include language, canonical title, and a resolved sense id.
        if (anchor.key !== candidate.key || anchor.lang !== candidate.lang || anchor.title !== candidate.title) continue;
        const component = anchor.kind === 'component' || candidate.kind === 'component';
        matches.push({ verified: true, term: result.word, lang: result.lang,
          etymonId: etymology.id || null, anchor, candidateAnchor: candidate, component,
          memberSource: result.source, priority: priorities[anchor.kind] + priorities[candidate.kind] });
      }
    }
  }
  return matches.sort((a, b) => a.priority - b.priority)[0] || null;
}

export function createReverseIndexClient({ baseUrl = new URL('./data/etymology-index/', import.meta.url), fetcher = globalThis.fetch,
  digest = bytes => crypto.subtle.digest('SHA-256', bytes), maxCachedShards = 24 } = {}) {
  if (!Number.isInteger(maxCachedShards) || maxCachedShards < 1) throw new TypeError('A positive shard cache size is required.');
  let manifestPromise;
  const cache = new Map();
  async function manifest() {
    manifestPromise ??= (async () => {
      const response = await fetcher(new URL('manifest.json', baseUrl));
      if (!response.ok) throw new Error('暫時無法讀取字族索引');
      const data = await response.json();
      if (data.schemaVersion !== 1 || !data.buildId || !data.source || !data.shards) throw new Error('字族索引版本不相容');
      return data;
    })().catch(error => { manifestPromise = undefined; throw error; });
    return manifestPromise;
  }
  async function shard(info, name) {
    const entry = info.shards[name];
    if (!entry) return {};
    if (!/^[a-f0-9]{2}-[a-f0-9]{64}\.json$/.test(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('字族索引檔案資訊不完整');
    const key = entry.file;
    if (cache.has(key)) {
      const pending = cache.get(key); cache.delete(key); cache.set(key, pending); return pending;
    }
    const pending = (async () => {
      const response = await fetcher(new URL(key, baseUrl));
      if (!response.ok) throw new Error('暫時無法讀取這個字族的索引');
      const bytes = await response.arrayBuffer();
      const hash = [...new Uint8Array(await digest(bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (hash !== entry.sha256) throw new Error('字族索引正在更新，請重新整理後重試');
      const data = JSON.parse(new TextDecoder().decode(bytes));
      if (data.schemaVersion !== 1 || !data.origins) throw new Error('字族索引格式不相容');
      return data.origins;
    })().catch(error => { if (cache.get(key) === pending) cache.delete(key); throw error; });
    cache.set(key, pending);
    while (cache.size > maxCachedShards) cache.delete(cache.keys().next().value);
    return pending;
  }
  return {
    async discover(etymology, word, excluded) {
      const anchors = usableOrigins(etymology);
      if (!anchors.length) return { candidates: [], manifest: null };
      const info = await manifest();
      const names = [...new Set(anchors.flatMap(discoveryKeys).map(indexShard))];
      const origins = {};
      // Small shards are fetched only for this word's sources, two at a time.
      for (let index = 0; index < names.length; index += 2) {
        for (const result of await Promise.all(names.slice(index, index + 2).map(name => shard(info, name)))) Object.assign(origins, result);
      }
      return { candidates: candidateWords(anchors, origins, word, excluded), manifest: info };
    },
  };
}
