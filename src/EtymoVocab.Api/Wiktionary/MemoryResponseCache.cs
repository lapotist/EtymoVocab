using EtymoVocab.Core.Lookup;
using Microsoft.Extensions.Caching.Memory;

namespace EtymoVocab.Api.Wiktionary;

/// <summary><see cref="IResponseCache"/> over ASP.NET Core's size-limited memory cache.</summary>
public sealed class MemoryResponseCache(IMemoryCache cache) : IResponseCache
{
    public bool TryGet<T>(string key, out T? value) => cache.TryGetValue(key, out value);

    public void Set<T>(string key, T? value, TimeSpan timeToLive, int sizeKb) =>
        cache.Set(key, value, new MemoryCacheEntryOptions
        {
            AbsoluteExpirationRelativeToNow = timeToLive,
            Size = Math.Max(1, sizeKb),
        });
}
