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
