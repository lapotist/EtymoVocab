const labels = { synonym: '同義詞', antonym: '反義詞' };

export function relatedGroups(etymology, word) {
  return etymology.partsOfSpeech.flatMap((part, posIndex) => (part.relations || [])
    .filter(relation => labels[relation.kind])
    .map((relation, relationIndex) => ({
      key: `related-group:${posIndex}:${relationIndex}`,
      kind: relation.kind,
      label: labels[relation.kind],
      pos: part.pos,
      sense: relation.sense,
      terms: [...new Set(relation.terms)].filter(term => term !== word),
    })).filter(group => group.terms.length));
}

// Keep meaning relationships separate from ancestry and preserve the dictionary's sense groups.
export function addRelatedWord(tree, group, term) {
  if (!group.terms.includes(term)) return null;
  let branch = tree.children.find(child => child.key === group.key);
  if (branch?.children.some(child => child.term === term)) return null;
  if (!branch) {
    branch = {
      key: group.key, kind: 'group', relatedRelation: group.kind,
      label: `${group.label} · ${group.pos}${group.sense ? ' · ' + group.sense : ''}`,
      children: [],
    };
    tree.children.push(branch);
  }
  branch.collapsed = false;
  const node = {
    key: `${group.key}:${term}`, kind: 'related', relatedRelation: group.kind,
    lang: 'en', langName: 'English', term, maskable: false, children: [],
    lookup: { lang: 'en', term, id: null },
    url: 'https://en.wiktionary.org/wiki/' + encodeURIComponent(term) + '#English',
  };
  branch.children.push(node);
  return node;
}
