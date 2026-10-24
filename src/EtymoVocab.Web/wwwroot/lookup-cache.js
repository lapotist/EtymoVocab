// Parsed results supplement the engine's raw-page cache; they stay in this tab only.
// Keys must include the lookup operation and preserve case-sensitive dictionary titles.
export function createLookupCache({ maxEntries = 100, ttlMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isFinite(ttlMs) || ttlMs <= 0 || typeof now !== 'function') {
    throw new TypeError('A positive cache size, lifetime, and clock are required.');
  }
  const entries = new Map();
  const pending = new Map();

  function get(key) {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (now() >= entry.expiresAt) { entries.delete(key); return undefined; }
    entries.delete(key);
    entries.set(key, entry);
    return entry.data;
  }

  function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }

  function set(key, data) {
    // Partial/failed lookups must be retried rather than becoming a successful cache hit.
    if (!data || data.complete !== true) return data;
    const snapshot = freeze(structuredClone(data));
    entries.delete(key);
    entries.set(key, { data: snapshot, expiresAt: now() + ttlMs });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    return snapshot;
  }

  function load(key, loader) {
    const cached = get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    if (pending.has(key)) return pending.get(key);
    const work = Promise.resolve().then(loader).then(data => set(key, data)).finally(() => {
      if (pending.get(key) === work) pending.delete(key);
    });
    pending.set(key, work);
    return work;
  }

  return { get, set, load };
}
