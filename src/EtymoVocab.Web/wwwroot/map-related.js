// Only relationships stated in this etymology's dictionary sections belong on the map.
// The allowlist deliberately excludes semantic relations and arbitrary page links.
const labels = {
  doublet: '同源異形詞', derived: '派生詞', related: '同族詞', cognate: '跨語言同源詞',
};
const descriptions = {
  doublet: '共同來源，非直接演變', derived: '由此詞構成', related: '詞條明列的詞源關聯', cognate: '共同來源，非直接演變',
};

export function etymologicalGroups(etymology, word, lang = 'en') {
  const groups = new Map();
  const records = [
    ...(etymology.doublets || []).filter(Boolean).map(item => ({ ...item, kind: 'doublet' })),
    ...(etymology.etymologicalRelations || []),
  ];
  for (const item of records) {
    if (!Object.hasOwn(labels, item?.kind) || typeof item.lang !== 'string' || typeof item.term !== 'string' || !item.lang || !item.term) continue;
    if (item.lang === lang && item.term.normalize('NFC') === word?.normalize('NFC')) continue;
    const key = item.kind === 'doublet' ? 'etymological:doublets' : `etymological:${item.kind}`;
    if (!groups.has(key)) groups.set(key, { key, kind: item.kind, label: labels[item.kind], terms: [] });
    const group = groups.get(key);
    if (group.terms.some(term => term.lang === item.lang && term.term === item.term)) continue;
    group.terms.push({ lang: item.lang, term: item.term, url: item.url || null,
      ...(item.sourceUrl ? { sourceUrl: item.sourceUrl, sourceSection: item.sourceSection } : {}) });
  }
  return [...groups.values()];
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
 * Family list order, common words first. With frequency ranks (frequency.js), lowercase words found in the
 * list come first, most frequent first. The rest follow by tier (plain lowercase, hyphenated, then names,
 * phrases and accented forms) and length, which is also the whole order when the ranks could not be loaded.
 * Capitalized titles never use a rank: "Sánchez" is frequent as a surname, which says nothing about the root.
 */
export function familyComparator(ranks = null) {
  const rankOf = (term) => (ranks && /^\p{Ll}[\p{Ll}'-]*$/u.test(term) ? ranks.get(term) ?? null : null);
  const tier = (term) => /^[a-z]+$/.test(term) ? 0 : /^[a-z][a-z'-]*$/.test(term) ? 1 : 2;
  return (a, b) => {
    const rankA = rankOf(a);
    const rankB = rankOf(b);
    if (rankA !== rankB) {
      if (rankA === null) return 1;
      if (rankB === null) return -1;
      return rankA - rankB;
    }
    return tier(a) - tier(b) || a.length - b.length || a.localeCompare(b);
  };
}

export const familyOrder = familyComparator();

/** The hash route of a family list; the sense id selects split categories such as "*per- (fare)". */
export function familyHref({ kind, lang, term, id }) {
  const query = new URLSearchParams();
  if (kind === 'prefix') query.set('kind', 'prefix');
  if (id) query.set('id', id);
  const search = query.toString();
  return `#/root/${encodeURIComponent(lang)}/${encodeURIComponent(term)}${search ? `?${search}` : ''}`;
}

export function addEtymologicalWord(tree, group, candidate) {
  if (!Object.hasOwn(labels, group?.kind)) return null;
  const source = group.terms.find(item => item.lang === candidate?.lang && item.term === candidate?.term);
  if (!source) return null;
  let branch = tree.children.find(child => child.key === group.key);
  if (branch?.children.some(child => child.lang === source.lang && child.term === source.term)) return null;
  if (!branch) {
    branch = {
      key: group.key, kind: 'group', sharedOrigin: true,
      label: `${labels[group.kind]}（${descriptions[group.kind]}）`, children: [],
    };
    tree.children.push(branch);
  }
  branch.collapsed = false;
  const node = {
    key: `${tree.key || 'word'}:${group.kind}:${JSON.stringify([source.lang, source.term])}`, kind: group.kind, sharedOrigin: true,
    lang: source.lang, langName: source.lang === 'en' ? 'English' : source.lang,
    term: source.term, maskable: false, children: [],
    lookup: { lang: source.lang, term: source.term, id: null }, url: source.url,
    relationSource: source.sourceUrl, relationLabel: labels[group.kind],
  };
  branch.children.push(node);
  return node;
}

// Keep every candidate available even when only the first few fit on the initial map.
export function attachEtymologicalWords(node, etymology, word = node.term, lang = node.lang) {
  const groups = etymologicalGroups(etymology, word, lang).map(group => ({ ...group, key: `${node.key}:${group.key}` }));
  node.etymologicalGroups = groups;
  let added = 0;
  for (const group of groups) {
    for (const term of group.terms.slice(0, 8)) {
      if (addEtymologicalWord(node, group, term)) added++;
    }
  }
  return added;
}

// This path is separate from dictionary-listed groups: the relationship was checked across two entries.
export function addVerifiedOrigin(tree, match) {
  if (match?.verified !== true || !match.memberSource?.url || !match.anchor?.key
    || match.anchor.key !== match.candidateAnchor?.key || !match.term) return null;
  const kind = match.component ? '共用構詞成分' : '共同來源';
  const key = `${tree.key}:verified:${match.component ? 'component' : 'origin'}:${match.anchor.key}`;
  let branch = tree.children.find(child => child.key === key);
  if (branch?.children.some(child => child.term === match.term && child.lang === match.lang)) return null;
  if (!branch) {
    branch = { key, kind: 'group', sharedOrigin: true, label: kind, verifiedAnchor: match.anchor, children: [] };
    tree.children.push(branch);
  }
  const node = {
    key: `${key}:${match.lang}:${match.term}`, kind: 'verified-origin', sharedOrigin: true,
    lang: match.lang, langName: match.lang === 'en' ? 'English' : match.lang, term: match.term,
    maskable: false, children: [], lookup: { lang: match.lang, term: match.term, id: match.etymonId },
    url: match.memberSource.url, relationSource: match.memberSource.url, originSource: match.anchor.sourceUrl || match.anchor.url,
    relationLabel: kind, verifiedAnchor: match.anchor,
  };
  branch.children.push(node);
  return node;
}
