// Loads the .NET WebAssembly engine (src/EtymoVocab.Web) once and exposes promise-based lookups.
import { dotnet } from './_framework/dotnet.js';

let enginePromise;

function load() {
  enginePromise ??= (async () => {
    const runtime = await dotnet.create();
    runtime.setModuleImports('etymovocab', { normalizeNfc: (text) => text.normalize('NFC') });
    const exports = await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName);
    await runtime.runMain();
    return exports.EtymoVocab.Web.Engine;
  })();
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
export const lookupWord = (word) => call('LookupWord', word);
export const lookupEntry = (lang, term, etymonId) => call('LookupEntry', lang, term, etymonId ?? null);
export const rootFamily = (lang, root) => call('RootFamily', lang, root);
export const suggest = (prefix) => call('Suggest', prefix);
