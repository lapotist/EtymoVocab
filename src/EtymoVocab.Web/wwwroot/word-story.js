// Answer-first summary of one etymology: the same three questions for every word, filled only from
// the Wiktionary data already fetched (no inference beyond picking and ordering facts):
//   1. 字面上是什麼？   the glossed word-formation parts
//   2. 意思怎麼走到今天？ ancestors whose recorded meaning differs from the one before, then today's sense
//   3. 為什麼是這種語感？ today's register labels and the route the word took into English
// The map remains the evidence; this module only decides what to show first.

const LANG_ZH = {
  English: '英語', 'Middle English': '中古英語', 'Old English': '古英語', Latin: '拉丁語', 'Late Latin': '晚期拉丁語',
  'Medieval Latin': '中世紀拉丁語', 'New Latin': '新拉丁語', 'Vulgar Latin': '通俗拉丁語', 'Old French': '古法語',
  'Middle French': '中古法語', French: '法語', 'Anglo-Norman': '盎格魯-諾曼語', 'Ancient Greek': '古希臘語', Greek: '希臘語',
  'Old Norse': '古諾斯語', 'Proto-Indo-European': '原始印歐語', 'Proto-Germanic': '原始日耳曼語',
  'Proto-West Germanic': '原始西日耳曼語', 'Proto-Italic': '原始義大利語', Italian: '義大利語', Spanish: '西班牙語',
  Portuguese: '葡萄牙語', German: '德語', Dutch: '荷蘭語', 'Middle Dutch': '中古荷蘭語', Arabic: '阿拉伯語',
  Persian: '波斯語', Sanskrit: '梵語', Japanese: '日語', Chinese: '漢語', Frankish: '法蘭克語',
};

const ENGLISH_LINEAGE = new Set(['en', 'enm', 'ang', 'sco']);
const GERMANIC_PROTO = new Set(['gmw-pro', 'gem-pro', 'ine-pro']);
const FRENCH = new Set(['fro', 'frm', 'fr', 'xno', 'fro-nor']);
const LATIN = /^(la|la-.+|itc-.+)$/;
const GREEK = /^(grc|grc-.+|el|gkm)$/;

const REGISTER = /(formal|informal|colloquial|slang|literary|poetic|dated|humorous|derogatory|offensive|vulgar|euphemistic|childish|jargon)/i;
const OLDER = /(obsolete|archaic|now rare)/i;
// A sense about a past practice ("deport to a penal colony"): neither today's meaning nor an older one.
const HISTORICAL = /historical/i;
const NOT_A_MEANING = /\b(inflection|form|plural|participle|tense|spelling|singular|comparative|superlative) of\b/i;
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'one', 'someone', 'something',
  'especially', 'used', 'which', 'who', 'its', 'their', 'are', 'was', 'very', 'being', 'having']);

export const langZh = (name) => LANG_ZH[name] || name;

/** Splits a rendered sense such as "(chiefly informal) Pleasant, satisfactory." into labels and text. */
export function splitLabels(sense) {
  const match = /^\(([^)]*)\)\s*(.*)$/s.exec(sense.trim());
  return match
    ? { labels: match[1].split(',').map(l => l.trim()).filter(Boolean), text: match[2].trim() }
    : { labels: [], text: sense.trim() };
}

/** A gloss short enough to read at a glance: first clause when long, no trailing period. */
export function shortGloss(text, max = 60) {
  let gloss = splitLabels(text || '').text.replace(/[.。]\s*$/, '').trim();
  if (gloss.length > max) gloss = gloss.replace(/\s*\([^)]*\)/g, '').trim();
  if (gloss.length > max) gloss = gloss.split(';')[0].trim();
  if (gloss.length > max) gloss = gloss.split(',')[0].trim();
  if (gloss.length > max) gloss = gloss.slice(0, max).replace(/\s+\S*$/, '') + '…';
  return gloss;
}

const tokens = (text) => new Set(text.toLowerCase().split(/[^a-zÀ-ɏ]+/)
  .filter(w => w.length >= 3 && !STOPWORDS.has(w)));

const negated = (words) => words.has('not') || words.has('never') || words.has('without');

/** True when two glosses describe the same meaning: half the words of the shorter one recur, same polarity. */
export function sameMeaning(a, b) {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size || negated(x) !== negated(y)) return false;
  let shared = 0;
  for (const word of x) if (y.has(word)) shared += 1;
  return shared / Math.min(x.size, y.size) >= 0.5;
}

function pickLiteral(ety) {
  const candidates = [
    ...ety.morphology.map(group => ({ group, via: null })),
    ...ety.steps.flatMap(step => step.morphology.map(group => ({ group, via: step }))),
  ];
  let best = null;
  candidates.forEach((candidate, index) => {
    const glossed = candidate.group.parts.filter(p => p.gloss).length;
    if (!glossed) return;
    const score = glossed * 10 + (glossed === candidate.group.parts.length ? 5 : 0);
    if (!best || score > best.score || (score === best.score && index < best.index)) best = { ...candidate, score, index };
  });
  if (!best) return null;
  return {
    langName: best.group.langName,
    parts: best.group.parts.map(p => ({ term: p.term, gloss: p.gloss ? shortGloss(p.gloss, 32) : null })),
    via: best.via ? { langName: best.via.langName, term: best.via.display || best.via.term } : null,
  };
}

function todaySense(ety) {
  for (const pos of ety.partsOfSpeech) {
    for (const sense of pos.senses) {
      const { labels, text } = splitLabels(sense);
      if (!text || NOT_A_MEANING.test(text) || labels.some(l => OLDER.test(l) || HISTORICAL.test(l))) continue;
      return { pos: pos.pos, gloss: shortGloss(text), labels: labels.filter(l => REGISTER.test(l)),
        zh: pos.translations[0]?.mandarin.slice(0, 2) || [] };
    }
  }
  return null;
}

function olderEnglishSense(ety) {
  for (const pos of ety.partsOfSpeech) {
    for (const sense of pos.senses) {
      const { labels, text } = splitLabels(sense);
      if (text && labels.some(l => OLDER.test(l)) && !labels.some(l => HISTORICAL.test(l)) && !NOT_A_MEANING.test(text)) {
        return { gloss: shortGloss(text), label: labels.find(l => OLDER.test(l)) };
      }
    }
  }
  return null;
}

function meaningPath(word, ety, today) {
  const ancestors = [...ety.steps].reverse()
    .filter(step => step.gloss && step.term && !NOT_A_MEANING.test(step.gloss))
    .map(step => ({ langName: step.langName, term: step.display || step.term, gloss: shortGloss(step.gloss, 44), kind: 'ancestor' }));
  const kept = [];
  for (const point of ancestors) {
    if (!kept.length || !sameMeaning(kept[kept.length - 1].gloss, point.gloss)) kept.push(point);
  }
  const stable = ancestors.length >= 2 && kept.length === 1;
  // Keep the origin and the two most recent changes, so the path stays readable.
  const path = kept.length > 3 ? [kept[0], ...kept.slice(-2)] : kept;

  const older = olderEnglishSense(ety);
  const last = path[path.length - 1];
  if (older && (!last || !sameMeaning(last.gloss, older.gloss)) && (!today || !sameMeaning(today.gloss, older.gloss))) {
    path.push({ langName: 'English', term: word, gloss: older.gloss, kind: 'older', label: older.label });
  }
  if (today) path.push({ langName: 'English', term: word, gloss: today.gloss, kind: 'today', zh: today.zh });
  return { path, stable, origin: ancestors[0] || null };
}

/** How the word entered English, read from the first ancestor outside the English lineage. */
function entryRoute(ety) {
  if (!ety.steps.length) return null;
  const langs = ety.steps.map(s => s.lang);
  const period = langs.includes('ang') ? 'old' : langs.includes('enm') ? 'middle' : null;
  const entry = ety.steps.find(s => !ENGLISH_LINEAGE.has(s.lang));
  if (!entry) return period ? { kind: 'native', period } : null;
  if (GERMANIC_PROTO.has(entry.lang)) return { kind: 'native', period };
  const kind = entry.lang === 'non' ? 'norse' : FRENCH.has(entry.lang) ? 'french'
    : LATIN.test(entry.lang) ? 'latin' : GREEK.test(entry.lang) ? 'greek' : 'other';
  return { kind, period, langName: entry.langName, term: entry.display || entry.term, learned: entry.relation === 'lbor' };
}

export function buildWordStory(result, ety) {
  const today = todaySense(ety);
  const literal = pickLiteral(ety);
  const { path, stable, origin } = meaningPath(result.word, ety, today);
  const route = entryRoute(ety);
  const register = today?.labels || [];
  const empty = !literal && path.length <= 1 && !route && !register.length;
  return { word: result.word, literal, path, stable, origin, today, route, register, empty, headline: headline(result.word, { literal, stable, origin, today }) };
}

/**
 * One sentence that answers the question before any detail. It juxtaposes recorded meanings instead of
 * asserting a change: gloss overlap cannot tell a real shift from two wordings of one meaning.
 */
function headline(word, { literal, stable, origin, today }) {
  if (stable && origin) return `${word} 的意思一路相近：最早可追溯到${langZh(origin.langName)} ${origin.term}「${origin.gloss}」。`;
  if (origin && today && !sameMeaning(origin.gloss, today.gloss)) {
    return `${word} 最早記錄的意思是「${origin.gloss}」（${langZh(origin.langName)} ${origin.term}），今天是「${today.gloss}」。`;
  }
  if (literal) return `${word} 字面上是 ${literal.parts.map(p => p.gloss ? `${p.term}「${p.gloss}」` : p.term).join(' + ')}。`;
  return null;
}

/** Chinese explanation lines for the register question; tendencies are labelled as such. */
export function feelLines(story) {
  const lines = [];
  if (story.register.length) lines.push(`今天的語感：Wiktionary 標示為「${story.register.join('、')}」。`);
  const route = story.route;
  if (!route) return lines;
  // Periods are the conventional approximate ranges, stated only when the chain names that stage.
  const inMiddleEnglish = route.period === 'middle' ? '在中古英語時期（約 1150–1500 年）' : '';
  switch (route.kind) {
    case 'native':
      lines.push(`英語本土字${route.period === 'old' ? '，古英語時期（約 450–1150 年）就已存在' : ''}。這類字多半是最基本、日常的說法（一般傾向）。`);
      break;
    case 'norse':
      lines.push(`${inMiddleEnglish}經古諾斯語進入英語。這類借字多半也是日常詞彙（一般傾向）。`);
      break;
    case 'french':
      lines.push(`${inMiddleEnglish}經${langZh(route.langName)} ${route.term} 進入英語。`);
      break;
    case 'latin':
    case 'greek':
      lines.push(`${route.learned ? '學術借入' : '直接借自'}${langZh(route.langName)} ${route.term}。這類字常偏書面或專業（一般傾向）。`);
      break;
    default:
      lines.push(`借自${langZh(route.langName)} ${route.term}。`);
  }
  return lines;
}
