// Loads the .NET WebAssembly engine (src/EtymoVocab.Web) once and exposes promise-based lookups.
import { createLookupCache } from './lookup-cache.js';

let enginePromise;
let backgroundRetryAt = 0;
let retryAt = 0;
let retryStatus = 429;
export const getBackoffUntil = () => backgroundRetryAt;
export const backgroundPaused = () => Date.now() < backgroundRetryAt;

export function observeBackoff(error) {
  if (error?.status === 429 || error?.status === 503) {
    const hasRetryAfter = Number.isFinite(error.retryAfter) && error.retryAfter >= 0;
    const until = Date.now() + (hasRetryAfter ? error.retryAfter : 5) * 1000;
    backgroundRetryAt = Math.max(backgroundRetryAt, until);
    if ((error.status === 429 || hasRetryAfter) && until > retryAt) {
      retryAt = until;
      retryStatus = error.status;
    }
  }
}
const results = createLookupCache();
const wordKey = (kind, word) => JSON.stringify([kind, word.normalize('NFC').trim()]);

function load() {
  enginePromise ??= (async () => {
    // Local lessons and the home page remain usable if the runtime cannot be downloaded.
    const { dotnet } = await import('./_framework/dotnet.js');
    const runtime = await dotnet.create();
    runtime.setModuleImports('etymovocab', { normalizeNfc: (text) => text.normalize('NFC') });
    const exports = await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName);
    await runtime.runMain();
    return exports.EtymoVocab.Web.Engine;
  })().catch(error => {
    enginePromise = undefined;
    throw new EngineError({
      title: '無法載入查詢引擎',
      detail: `${error.message}。可稍後重試；推論練習仍可使用。`,
    });
  });
  return enginePromise;
}

export class EngineError extends Error {
  constructor(failure) {
    super(failure.title);
    this.status = failure.status;
    this.detail = failure.detail;
    this.retryAfter = failure.retryAfter;
  }
}

async function call(name, ...args) {
  const wait = retryAt - Date.now();
  if (wait > 0) {
    throw new EngineError({ status: retryStatus, title: 'Wiktionary 要求稍候', retryAfter: Math.ceil(wait / 1000) });
  }
  const engine = await load();
  const result = JSON.parse(await engine[name](...args));
  if (!result.ok) {
    observeBackoff(result);
    throw new EngineError(result);
  }
  observeBackoff(result.data?.upstreamError);
  return result.data;
}

export const preload = load;
export const lookupWord = (word) => results.load(wordKey('word', word), () => call('LookupWord', word));
export const lookupRelated = (word) => results.load(wordKey('related', word), () => call('LookupRelated', word));
export async function lookupRelatedBatch(words) {
  const cached = new Map();
  const missing = [];
  for (const word of words) {
    const data = results.get(wordKey('related', word));
    if (data) cached.set(word, { word, data, error: null });
    else missing.push(word);
  }
  if (missing.length) {
    try {
      const fresh = await call('LookupRelatedBatch', JSON.stringify(missing));
      for (const item of fresh) {
        observeBackoff(item.error);
        observeBackoff(item.data?.upstreamError);
        cached.set(item.word, item.data ? { ...item, data: results.set(wordKey('related', item.word), item.data) } : item);
      }
    } catch (error) {
      if (!cached.size) throw error;
      for (const word of missing) cached.set(word, { word, data: null, error });
    }
  }
  return words.map(word => cached.get(word) || { word, data: null,
    error: { status: 500, title: '查詢結果缺少詞條', detail: word, retryAfter: null } });
}
export const lookupEntry = (lang, term, etymonId) => results.load(
  JSON.stringify(['entry', lang, term.normalize('NFC').trim(), etymonId ?? null]),
  () => call('LookupEntry', lang, term, etymonId ?? null));
export const rootFamily = (lang, root, id) => call('RootFamily', lang, root, id ?? null);
export const prefixFamily = (lang, prefix, id) => call('PrefixFamily', lang, prefix, id ?? null);
export const suggest = (prefix) => call('Suggest', prefix);
