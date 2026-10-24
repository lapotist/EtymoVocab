// Saved vocabulary is a personal list. Its provenance never creates an etymology-tree edge.
export const SAVED_WORDS_STORAGE_KEY = 'etymovocab.saved-words.v1';
const SCHEMA_VERSION = 1;
const MAX_CONTEXTS = 20;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const CONFIRMED_RELATIONS = new Set(['synonym', 'antonym']);
const validTime = value => Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;

export function normalizeSavedWord(value) {
  if (typeof value !== 'string' || CONTROL.test(value)) throw new TypeError('A word or phrase without control characters is required.');
  const word = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (!word || word.length > 200) throw new TypeError('A word or phrase must contain 1 to 200 characters.');
  return Object.freeze({ word, key: word.toLowerCase() });
}

function optionalText(value, limit, field) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || CONTROL.test(value)) throw new TypeError(`${field} must be plain text.`);
  const result = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (result.length > limit) throw new TypeError(`${field} is too long.`);
  return result || null;
}

function normalizeContext(context) {
  if (context == null) return null;
  if (typeof context !== 'object' || Array.isArray(context)) throw new TypeError('Word provenance must be an object.');
  const relation = context.relation ?? null;
  if (relation !== null && !CONFIRMED_RELATIONS.has(relation)) throw new TypeError('A relation must be synonym, antonym, or null.');
  const etymologyId = typeof context.etymologyId === 'number' && Number.isSafeInteger(context.etymologyId)
    ? String(context.etymologyId) : context.etymologyId;
  const sourceUrl = optionalText(context.sourceUrl, 2048, 'sourceUrl');
  if (sourceUrl) {
    let url;
    try { url = new URL(sourceUrl); } catch { throw new TypeError('A valid HTTPS source URL is required.'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new TypeError('A valid HTTPS source URL is required.');
  }
  const normalized = {
    query: optionalText(context.query, 200, 'query'),
    sourceWord: optionalText(context.sourceWord, 200, 'sourceWord'),
    relation,
    pos: optionalText(context.pos, 80, 'pos'),
    sense: optionalText(context.sense, 500, 'sense'),
    etymologyId: optionalText(etymologyId, 200, 'etymologyId'),
    sourceUrl,
  };
  return Object.values(normalized).some(value => value !== null) ? Object.freeze(normalized) : null;
}

function contextKey(context) {
  return JSON.stringify({ ...context, query: context.query?.toLowerCase() ?? null, sourceWord: context.sourceWord?.toLowerCase() ?? null });
}

function uniqueContexts(contexts) {
  const seen = new Set();
  const output = [];
  for (const context of contexts) {
    if (!context) continue;
    const key = contextKey(context);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(context);
  }
  return Object.freeze(output.slice(-MAX_CONTEXTS));
}

function savedItem(record) {
  return Object.freeze({
    word: record.word, key: record.key, savedAt: record.savedAt,
    contexts: Object.freeze(record.contexts.map(context => Object.freeze({ ...context }))),
  });
}

/**
 * A local collection with bounded, sense-specific discovery provenance.
 * Per-word revisions and tombstones preserve removals during sequential stale-tab writes.
 * localStorage has no cross-tab transaction, so simultaneous writes are not a sync service.
 */
export function createSavedWordsStore({ storage, now = () => Date.now() } = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  let persistence = storage;
  let available = true;
  if (persistence === undefined) {
    try { persistence = globalThis.localStorage; } catch { available = false; }
  }
  if (!persistence || typeof persistence.getItem !== 'function' || typeof persistence.setItem !== 'function') available = false;
  const records = new Map();
  const listeners = new Set();
  let sequence = 0;

  function currentTime() {
    const value = now();
    if (!validTime(value)) throw new TypeError('now must return a valid timestamp in milliseconds.');
    return value;
  }

  function readRecord(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    try {
      const { word, key } = normalizeSavedWord(input.word);
      if (input.key !== key || !validTime(input.savedAt) || !validTime(input.updatedAt)
        || input.updatedAt < input.savedAt || !Number.isSafeInteger(input.revision) || input.revision < 1
        || typeof input.deleted !== 'boolean' || typeof input.operationId !== 'string'
        || !input.operationId || input.operationId.length > 120 || CONTROL.test(input.operationId)
        || !Array.isArray(input.contexts)) return null;
      const contexts = [];
      if (!input.deleted) {
        for (const item of input.contexts) {
          try { contexts.push(normalizeContext(item)); } catch { /* keep valid provenance in an otherwise useful saved word */ }
        }
      }
      return Object.freeze({
        word, key, savedAt: input.savedAt, updatedAt: input.updatedAt,
        revision: input.revision, operationId: input.operationId, deleted: input.deleted,
        contexts: uniqueContexts(contexts),
      });
    } catch { return null; }
  }

  function compareRecords(first, second) {
    return first.revision - second.revision || first.updatedAt - second.updatedAt
      || (first.operationId === second.operationId ? 0 : first.operationId < second.operationId ? -1 : 1);
  }

  function synchronize() {
    if (!available) return false;
    let raw;
    try { raw = persistence.getItem(SAVED_WORDS_STORAGE_KEY); } catch { available = false; return false; }
    if (raw == null) return false;
    let payload;
    try { payload = JSON.parse(raw); } catch { return false; }
    if (payload?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(payload.records)) return false;
    let changed = false;
    for (const input of payload.records) {
      const candidate = readRecord(input);
      if (!candidate) continue;
      const existing = records.get(candidate.key);
      if (!existing || compareRecords(candidate, existing) > 0) {
        records.set(candidate.key, candidate);
        changed = true;
      }
    }
    return changed;
  }

  function snapshot() {
    return Object.freeze([...records.values()].filter(record => !record.deleted)
      .sort((first, second) => second.savedAt - first.savedAt || first.key.localeCompare(second.key))
      .map(savedItem));
  }

  function persist() {
    if (!available) return;
    try { persistence.setItem(SAVED_WORDS_STORAGE_KEY, JSON.stringify({ schemaVersion: SCHEMA_VERSION, records: [...records.values()] })); }
    catch { available = false; }
  }

  function notify() {
    const words = snapshot();
    for (const listener of [...listeners]) {
      try { listener(words); } catch { /* one view must not stop other views or discard saved vocabulary */ }
    }
  }

  function storageChanged(event) {
    if ((event.key === SAVED_WORDS_STORAGE_KEY || event.key === null)
      && (!event.storageArea || event.storageArea === persistence) && synchronize()) notify();
  }

  function nextRecord(existing, values) {
    const timestamp = currentTime();
    const revision = (existing?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new RangeError('This saved word has too many revisions.');
    sequence += 1;
    return Object.freeze({
      ...values, updatedAt: Math.max(timestamp, existing?.updatedAt ?? 0, values.savedAt), revision,
      operationId: `saved-${timestamp.toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2, 12)}`,
    });
  }

  synchronize();
  return Object.freeze({
    list() { synchronize(); return snapshot(); },
    has(word) {
      const { key } = normalizeSavedWord(word);
      synchronize();
      const record = records.get(key);
      return !!record && !record.deleted;
    },
    save(value, context) {
      const { key, word } = normalizeSavedWord(value);
      const provenance = normalizeContext(context);
      const changed = synchronize();
      const existing = records.get(key);
      const active = existing && !existing.deleted;
      const contexts = uniqueContexts([...(active ? existing.contexts : []), provenance]);
      if (active && JSON.stringify(contexts) === JSON.stringify(existing.contexts)) {
        if (changed) notify();
        return savedItem(existing);
      }
      const record = nextRecord(existing, {
        key, word: active ? existing.word : word, savedAt: active ? existing.savedAt : currentTime(),
        deleted: false, contexts,
      });
      records.set(key, record);
      persist();
      notify();
      return savedItem(record);
    },
    remove(value) {
      const { key } = normalizeSavedWord(value);
      const changed = synchronize();
      const existing = records.get(key);
      if (!existing || existing.deleted) {
        if (changed) notify();
        return false;
      }
      records.set(key, nextRecord(existing, { key, word: existing.word, savedAt: existing.savedAt, deleted: true, contexts: Object.freeze([]) }));
      persist();
      notify();
      return true;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('A saved-word listener must be a function.');
      if (!listeners.size && typeof globalThis.addEventListener === 'function') globalThis.addEventListener('storage', storageChanged);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size && typeof globalThis.removeEventListener === 'function') globalThis.removeEventListener('storage', storageChanged);
      };
    },
    exportData() {
      synchronize();
      return Object.freeze({ schemaVersion: SCHEMA_VERSION, exportedAt: currentTime(), words: snapshot() });
    },
    get storageAvailable() { return available; },
  });
}
