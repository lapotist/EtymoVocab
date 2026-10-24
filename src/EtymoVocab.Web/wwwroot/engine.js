// Loads the .NET WebAssembly engine (src/EtymoVocab.Web) once and exposes promise-based lookups.
import { createLookupCache } from './lookup-cache.js';

let enginePromise;
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
  const engine = await load();
  const result = JSON.parse(await engine[name](...args));
  if (!result.ok) throw new EngineError(result);
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
    const fresh = await call('LookupRelatedBatch', JSON.stringify(missing));
    for (const item of fresh) {
      cached.set(item.word, item.data ? { ...item, data: results.set(wordKey('related', item.word), item.data) } : item);
    }
  }
  return words.map(word => cached.get(word) || { word, data: null,
    error: { status: 500, title: '查詢結果缺少詞條', detail: word, retryAfter: null } });
}
export const lookupEntry = (lang, term, etymonId) => call('LookupEntry', lang, term, etymonId ?? null);
export const rootFamily = (lang, root) => call('RootFamily', lang, root);
export const suggest = (prefix) => call('Suggest', prefix);
