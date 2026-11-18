// Only relationships stated in the selected etymology belong on this map.
// Synonyms and antonyms describe meaning and deliberately never enter these groups.
export function etymologicalGroups(etymology, word, lang = 'en') {
  const seen = new Set();
  const terms = (etymology.doublets || []).filter(item => {
    if (typeof item?.lang !== 'string' || typeof item.term !== 'string' || !item.lang || !item.term) return false;
    if (item.lang === lang && item.term === word) return false;
    const key = JSON.stringify([item.lang, item.term]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(item => ({ lang: item.lang, term: item.term, url: item.url || null }));
  return terms.length ? [{ key: 'etymological:doublets', kind: 'doublet', label: '同源異形詞', terms }] : [];
}

/**
 * Where a map node's shared-origin words can be read, or null. Only forms Wiktionary itself groups into
 * English categories qualify: a reconstructed root that appears in the chain or a breakdown (a proto-language
 * form ending in "-", such as PIE *seh₂k-), and an English prefix (trans-). Reconstructed suffixes (*-tḗr),
 * reconstructed words (*fadēr), suffixes (-ed) and non-English affixes (Latin trāns-) do not.
 */
export function familySource({ lang, term, id = null }) {
  if (typeof lang !== 'string' || typeof term !== 'string') return null;
  if (/-pro$/.test(lang) && /^\*[^-].*-$/.test(term)) return { kind: 'root', lang, term, id: id || null };
  if (lang === 'en' && /^[a-z]{2,}-$/i.test(term)) return { kind: 'prefix', lang, term, id: id || null };
  return null;
}

/**
 * Family list order until frequency data exists: plain lowercase words first, then hyphenated ones, then
 * proper names, phrases and accented forms; shorter first within each tier (word length roughly tracks frequency).
 */
export function familyOrder(a, b) {
  const tier = (term) => /^[a-z]+$/.test(term) ? 0 : /^[a-z][a-z'-]*$/.test(term) ? 1 : 2;
  return tier(a) - tier(b) || a.length - b.length || a.localeCompare(b);
}

/** The hash route of a family list; the sense id selects split categories such as "*per- (fare)". */
export function familyHref({ kind, lang, term, id }) {
  const query = new URLSearchParams();
  if (kind === 'prefix') query.set('kind', 'prefix');
  if (id) query.set('id', id);
  const search = query.toString();
  return `#/root/${encodeURIComponent(lang)}/${encodeURIComponent(term)}${search ? `?${search}` : ''}`;
}

export function addEtymologicalWord(tree, group, candidate) {
  if (group?.kind !== 'doublet') return null;
  const source = group.terms.find(item => item.lang === candidate?.lang && item.term === candidate?.term);
  if (!source) return null;
  let branch = tree.children.find(child => child.key === group.key);
  if (branch?.children.some(child => child.lang === source.lang && child.term === source.term)) return null;
  if (!branch) {
    branch = {
      key: group.key, kind: 'group', sharedOrigin: true,
      label: '同源異形詞（共同來源，非直接演變）', children: [],
    };
    tree.children.push(branch);
  }
  branch.collapsed = false;
  const node = {
    key: `doublet:${JSON.stringify([source.lang, source.term])}`, kind: 'doublet', sharedOrigin: true,
    lang: source.lang, langName: source.lang === 'en' ? 'English' : source.lang,
    term: source.term, maskable: false, children: [],
    lookup: { lang: source.lang, term: source.term, id: null }, url: source.url,
  };
  branch.children.push(node);
  return node;
}
