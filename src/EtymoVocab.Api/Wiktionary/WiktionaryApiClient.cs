using System.Net;
using System.Text.Json;
using EtymoVocab.Core.Lookup;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

namespace EtymoVocab.Api.Wiktionary;

/// <summary>Process-wide cap on concurrent Wiktionary requests (typed HttpClients are transient).</summary>
public sealed class WiktionaryThrottle(IOptions<WiktionaryOptions> options)
{
    public SemaphoreSlim Gate { get; } = new(options.Value.MaxConcurrency, options.Value.MaxConcurrency);
}

/// <summary>
/// MediaWiki Action API client for en.wiktionary.org: batched page reads, category listings and
/// title suggestions, with an in-memory cache and polite throttling. It does not serve stale data
/// or switch sources when Wiktionary is down; that fallback is planned (docs/PLAN.md).
/// </summary>
public sealed class WiktionaryApiClient(
    HttpClient http,
    IMemoryCache cache,
    WiktionaryThrottle throttle,
    IOptions<WiktionaryOptions> options,
    ILogger<WiktionaryApiClient> logger) : IWiktionaryClient
{
    private const int MaxTitlesPerRequest = 50;
    private const int MaxContinuations = 5;
    private readonly WiktionaryOptions _options = options.Value;

    public async Task<IReadOnlyDictionary<string, WikiPage?>> GetPagesAsync(IReadOnlyCollection<string> titles, CancellationToken ct)
    {
        var result = new Dictionary<string, WikiPage?>(StringComparer.Ordinal);
        var toFetch = new List<string>();
        foreach (var title in titles.Distinct(StringComparer.Ordinal))
        {
            if (cache.TryGetValue(PageKey(title), out WikiPage? cached))
                result[title] = cached; // a cached null means "known to be missing"
            else
                toFetch.Add(title);
        }

        foreach (var chunk in toFetch.Chunk(MaxTitlesPerRequest))
        {
            var fetched = await FetchPagesAsync(chunk, ct);
            foreach (var title in chunk)
            {
                if (!fetched.TryGetValue(title, out var page))
                {
                    result[title] = null; // no definitive answer (e.g. continuation cut short): do not cache
                    continue;
                }
                result[title] = page;
                cache.Set(PageKey(title), page, new MemoryCacheEntryOptions
                {
                    AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(
                        page is null ? _options.MissingPageCacheMinutes : _options.PageCacheMinutes),
                    Size = page is null ? 1 : 1 + page.Wikitext.Length / 1024,
                });
            }
        }
        return result;
    }

    public async Task<CategoryListing?> GetCategoryMembersAsync(string categoryTitle, int limit, CancellationToken ct)
    {
        var key = $"cat:{limit}:{categoryTitle}";
        if (cache.TryGetValue(key, out CategoryListing? cached))
            return cached;

        using var doc = await GetJsonAsync(new Dictionary<string, string>
        {
            ["action"] = "query",
            ["list"] = "categorymembers",
            ["cmtitle"] = categoryTitle,
            ["cmnamespace"] = "0",
            ["cmlimit"] = Math.Clamp(limit, 1, 500).ToString(),
            ["cmprop"] = "title",
            ["prop"] = "categoryinfo",
            ["titles"] = categoryTitle,
            ["format"] = "json",
            ["formatversion"] = "2",
        }, ct);

        var query = doc.RootElement.GetProperty("query");
        var members = query.TryGetProperty("categorymembers", out var list)
            ? list.EnumerateArray().Select(m => m.GetProperty("title").GetString()!).ToList()
            : [];
        int? total = null;
        var categoryPageMissing = false;
        if (query.TryGetProperty("pages", out var pages) && pages.GetArrayLength() > 0)
        {
            var page = pages[0];
            categoryPageMissing = page.TryGetProperty("missing", out _);
            if (page.TryGetProperty("categoryinfo", out var info) && info.TryGetProperty("pages", out var count))
                total = count.GetInt32();
        }

        var listing = members.Count == 0 && categoryPageMissing ? null : new CategoryListing(categoryTitle, total ?? members.Count, members);
        cache.Set(key, listing, new MemoryCacheEntryOptions
        {
            AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(_options.PageCacheMinutes),
            Size = 1 + members.Count / 64,
        });
        return listing;
    }

    public async Task<IReadOnlyList<string>> SuggestAsync(string prefix, int limit, CancellationToken ct)
    {
        var key = $"suggest:{limit}:{prefix}";
        if (cache.TryGetValue(key, out IReadOnlyList<string>? cached) && cached is not null)
            return cached;

        using var doc = await GetJsonAsync(new Dictionary<string, string>
        {
            ["action"] = "opensearch",
            ["search"] = prefix,
            ["limit"] = Math.Clamp(limit, 1, 20).ToString(),
            ["namespace"] = "0",
            ["format"] = "json",
        }, ct);

        // opensearch: [query, [titles], [descriptions], [urls]]
        IReadOnlyList<string> titles = doc.RootElement.ValueKind == JsonValueKind.Array && doc.RootElement.GetArrayLength() > 1
            ? doc.RootElement[1].EnumerateArray().Select(t => t.GetString()!).ToList()
            : [];
        cache.Set(key, titles, new MemoryCacheEntryOptions
        {
            AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(_options.PageCacheMinutes),
            Size = 1,
        });
        return titles;
    }

    /// <summary>Returns only titles with a definitive answer: a page, or null when missing/invalid.</summary>
    private async Task<Dictionary<string, WikiPage?>> FetchPagesAsync(IReadOnlyList<string> titles, CancellationToken ct)
    {
        var parameters = new Dictionary<string, string>
        {
            ["action"] = "query",
            ["prop"] = "revisions",
            ["rvprop"] = "ids|timestamp|content",
            ["rvslots"] = "main",
            ["titles"] = string.Join('|', titles),
            ["redirects"] = "1",
            ["format"] = "json",
            ["formatversion"] = "2",
        };

        var renames = new Dictionary<string, string>(StringComparer.Ordinal);
        var pages = new Dictionary<string, WikiPage?>(StringComparer.Ordinal);
        for (var round = 0; round < MaxContinuations; round++)
        {
            using var doc = await GetJsonAsync(parameters, ct);
            var root = doc.RootElement;
            if (root.TryGetProperty("query", out var query))
            {
                foreach (var listName in new[] { "normalized", "redirects" })
                {
                    if (!query.TryGetProperty(listName, out var list))
                        continue;
                    foreach (var item in list.EnumerateArray())
                        renames[item.GetProperty("from").GetString()!] = item.GetProperty("to").GetString()!;
                }
                if (query.TryGetProperty("pages", out var pageList))
                {
                    foreach (var page in pageList.EnumerateArray())
                        ReadPage(page, pages);
                }
            }

            // Large batches can be split by the API; follow its continuation parameters.
            if (!root.TryGetProperty("continue", out var next))
                break;
            foreach (var property in next.EnumerateObject())
                parameters[property.Name] = property.Value.ToString();
        }

        var result = new Dictionary<string, WikiPage?>(StringComparer.Ordinal);
        foreach (var requested in titles)
        {
            var title = requested;
            for (var hop = 0; hop < 3 && renames.TryGetValue(title, out var renamed); hop++)
                title = renamed;
            if (pages.TryGetValue(title, out var page))
                result[requested] = page;
        }
        return result;
    }

    private static void ReadPage(JsonElement page, Dictionary<string, WikiPage?> pages)
    {
        var title = page.GetProperty("title").GetString()!;
        if (page.TryGetProperty("missing", out _) || page.TryGetProperty("invalid", out _))
        {
            pages[title] = null;
            return;
        }
        if (!page.TryGetProperty("revisions", out var revisions) || revisions.GetArrayLength() == 0)
            return; // content deferred to a continuation
        var revision = revisions[0];
        var content = revision.GetProperty("slots").GetProperty("main").GetProperty("content").GetString() ?? "";
        pages[title] = new WikiPage(
            title,
            revision.GetProperty("revid").GetInt64(),
            revision.GetProperty("timestamp").GetDateTimeOffset(),
            content);
    }

    private async Task<JsonDocument> GetJsonAsync(Dictionary<string, string> parameters, CancellationToken ct)
    {
        var url = _options.ApiUrl + "?" + string.Join('&',
            parameters.Select(p => $"{Uri.EscapeDataString(p.Key)}={Uri.EscapeDataString(p.Value)}"));

        for (var attempt = 0; ; attempt++)
        {
            var status = default(HttpStatusCode);
            TimeSpan? retryAfter = null;

            await throttle.Gate.WaitAsync(ct);
            try
            {
                using var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
                status = response.StatusCode;
                if (response.IsSuccessStatusCode && response.Content.Headers.ContentType?.MediaType == "application/json")
                {
                    await using var stream = await response.Content.ReadAsStreamAsync(ct);
                    var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
                    if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("error", out var error))
                    {
                        var code = error.TryGetProperty("code", out var c) ? c.GetString() : "unknown";
                        doc.Dispose();
                        throw new UpstreamUnavailableException($"Wiktionary API 回報錯誤（{code}）。");
                    }
                    return doc;
                }
                retryAfter = response.Headers.RetryAfter?.Delta
                    ?? (response.Headers.RetryAfter?.Date is { } date ? date - DateTimeOffset.UtcNow : null);
            }
            catch (HttpRequestException ex)
            {
                throw new UpstreamUnavailableException("無法連線至 Wiktionary。", null, ex);
            }
            catch (TaskCanceledException ex) when (!ct.IsCancellationRequested)
            {
                throw new UpstreamUnavailableException("Wiktionary 回應逾時。", null, ex);
            }
            catch (JsonException ex)
            {
                throw new UpstreamUnavailableException("Wiktionary 回傳無法解析的內容。", null, ex);
            }
            finally
            {
                throttle.Gate.Release();
            }

            var retryable = status is HttpStatusCode.TooManyRequests or HttpStatusCode.BadGateway
                or HttpStatusCode.ServiceUnavailable or HttpStatusCode.GatewayTimeout;
            var delay = retryAfter ?? TimeSpan.FromSeconds(1 << attempt);
            if (!retryable || attempt >= _options.MaxRetries || delay > TimeSpan.FromSeconds(_options.MaxRetryDelaySeconds))
            {
                logger.LogWarning("Wiktionary request failed with HTTP {Status} (Retry-After: {RetryAfter})", (int)status, retryAfter);
                throw new UpstreamUnavailableException($"Wiktionary 暫時無法使用（HTTP {(int)status}）。", retryAfter);
            }
            logger.LogInformation("Wiktionary returned HTTP {Status}; retrying in {Delay}", (int)status, delay);
            await Task.Delay(delay, ct);
        }
    }

    private static string PageKey(string title) => "page:" + title;
}
