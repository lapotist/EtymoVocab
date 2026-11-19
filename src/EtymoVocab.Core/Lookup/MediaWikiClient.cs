using System.Net;
using System.Text.Json;

namespace EtymoVocab.Core.Lookup;

public sealed class MediaWikiOptions
{
    public const string Section = "Wiktionary";

    public string ApiUrl { get; set; } = "https://en.wiktionary.org/w/api.php";

    /// <summary>
    /// Wikimedia's User-Agent policy asks for a descriptive agent with contact information. Servers send
    /// it as <c>User-Agent</c>; browsers forbid that header, so browser mode sends <c>Api-User-Agent</c>.
    /// </summary>
    public string UserAgent { get; set; } = "EtymoVocab/0.1 (https://github.com/lapotist/EtymoVocab)";

    /// <summary>Anonymous CORS requests (<c>origin=*</c>) from a web page instead of a server.</summary>
    public bool BrowserMode { get; set; }

    /// <summary>Wikimedia asks API clients to keep concurrent requests at 3 or fewer.</summary>
    public int MaxConcurrency { get; set; } = 3;

    public int TimeoutSeconds { get; set; } = 15;

    /// <summary>Retries for 429/502/503/504, only when the wait (Retry-After or backoff) is short.</summary>
    public int MaxRetries { get; set; } = 2;

    public int MaxRetryDelaySeconds { get; set; } = 5;

    public int PageCacheMinutes { get; set; } = 30;

    public int MissingPageCacheMinutes { get; set; } = 10;
}

/// <summary>Host-provided cache; a stored null is a valid value ("known to be missing").</summary>
public interface IResponseCache
{
    bool TryGet<T>(string key, out T? value);

    void Set<T>(string key, T? value, TimeSpan timeToLive, int sizeKb);
}

/// <summary>Bounded in-process cache for hosts without <c>IMemoryCache</c>, such as the browser.</summary>
public sealed class SimpleResponseCache(int maxEntries = 2000, TimeProvider? time = null) : IResponseCache
{
    private readonly Dictionary<string, (object? Value, DateTimeOffset Expires)> _entries = new(StringComparer.Ordinal);
    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private readonly Lock _lock = new();

    public bool TryGet<T>(string key, out T? value)
    {
        lock (_lock)
        {
            if (_entries.TryGetValue(key, out var entry) && entry.Expires > _time.GetUtcNow())
            {
                value = (T?)entry.Value;
                return true;
            }
            _entries.Remove(key);
            value = default;
            return false;
        }
    }

    public void Set<T>(string key, T? value, TimeSpan timeToLive, int sizeKb)
    {
        lock (_lock)
        {
            if (_entries.Count >= maxEntries && !_entries.ContainsKey(key))
                Evict();
            _entries[key] = (value, _time.GetUtcNow() + timeToLive);
        }
    }

    private void Evict()
    {
        var now = _time.GetUtcNow();
        foreach (var expired in _entries.Where(e => e.Value.Expires <= now).Select(e => e.Key).ToList())
            _entries.Remove(expired);
        if (_entries.Count >= maxEntries)
            _entries.Remove(_entries.MinBy(e => e.Value.Expires).Key);
    }
}

/// <summary>
/// MediaWiki Action API client for en.wiktionary.org: batched page reads, category listings and title
/// suggestions, with caching and polite throttling. It does not serve stale data or switch sources when
/// Wiktionary is down; that fallback is planned (docs/PLAN.md §5).
/// </summary>
public sealed class MediaWikiClient(HttpClient http, IResponseCache cache, MediaWikiOptions options, Action<string>? log = null)
    : IWiktionaryClient
{
    private const int MaxTitlesPerRequest = 50;
    private const int MaxCategoryMembersPerRequest = 500;
    private const int MaxContinuations = 5;
    private readonly SemaphoreSlim _gate = new(options.MaxConcurrency, options.MaxConcurrency);

    public async Task<IReadOnlyDictionary<string, WikiPage?>> GetPagesAsync(IReadOnlyCollection<string> titles, CancellationToken ct)
    {
        var result = new Dictionary<string, WikiPage?>(StringComparer.Ordinal);
        var toFetch = new List<string>();
        foreach (var title in titles.Distinct(StringComparer.Ordinal))
        {
            if (cache.TryGet(PageKey(title), out WikiPage? cached))
                result[title] = cached;
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
                cache.Set(PageKey(title), page,
                    TimeSpan.FromMinutes(page is null ? options.MissingPageCacheMinutes : options.PageCacheMinutes),
                    page is null ? 1 : 1 + page.Wikitext.Length / 1024);
            }
        }
        return result;
    }

    public async Task<CategoryListing?> GetCategoryMembersAsync(string categoryTitle, int limit, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        // Wikimedia limits each anonymous category page to 500 members. Follow the supplied
        // continuation, while bounding a whole family lookup to 2,000 members and five pages.
        var wanted = Math.Clamp(limit, 1, RootFamilyService.MaxMembers);
        var key = $"cat:{wanted}:{categoryTitle}";
        if (cache.TryGet(key, out CategoryListing? cached))
            return cached;

        var parameters = new Dictionary<string, string>
        {
            ["action"] = "query",
            ["list"] = "categorymembers",
            ["cmtitle"] = categoryTitle,
            ["cmnamespace"] = "0",
            ["cmprop"] = "title",
            ["prop"] = "categoryinfo",
            ["titles"] = categoryTitle,
            ["format"] = "json",
            ["formatversion"] = "2",
        };

        var members = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var continuations = new HashSet<string>(StringComparer.Ordinal);
        int? total = null;
        var categoryPageMissing = false;
        var hasMore = false;
        for (var round = 0; round < MaxContinuations; round++)
        {
            ct.ThrowIfCancellationRequested();
            parameters["cmlimit"] = Math.Min(wanted - members.Count, MaxCategoryMembersPerRequest).ToString();
            using var doc = await GetJsonAsync(parameters, ct);
            var query = doc.RootElement.GetProperty("query");
            if (query.TryGetProperty("categorymembers", out var list))
            {
                foreach (var item in list.EnumerateArray())
                {
                    var title = item.GetProperty("title").GetString()!;
                    if (seen.Add(title)) members.Add(title);
                    if (members.Count == wanted) break;
                }
            }
            if (query.TryGetProperty("pages", out var pages) && pages.GetArrayLength() > 0)
            {
                var page = pages[0];
                categoryPageMissing = page.TryGetProperty("missing", out _);
                if (page.TryGetProperty("categoryinfo", out var info) && info.TryGetProperty("pages", out var count))
                    total = count.GetInt32();
            }

            hasMore = doc.RootElement.TryGetProperty("continue", out var next)
                && next.TryGetProperty("cmcontinue", out _);
            if (!hasMore || members.Count == wanted) break;
            var token = next.GetProperty("cmcontinue").GetString()!;
            if (!continuations.Add(token))
                throw new UpstreamUnavailableException("Wiktionary 的字族清單重複回傳相同分頁，請稍後重試。");
            foreach (var property in next.EnumerateObject())
                parameters[property.Name] = property.Value.ToString();
        }

        var listing = members.Count == 0 && categoryPageMissing ? null
            : new CategoryListing(categoryTitle, total ?? (hasMore ? null : members.Count), members);
        ct.ThrowIfCancellationRequested();
        // Upstream exceptions never reach the cache write. Do not cache an incomplete listing
        // stopped by the page-count guard either; a later lookup may recover more members.
        if (!hasMore || members.Count == wanted)
            cache.Set(key, listing, TimeSpan.FromMinutes(options.PageCacheMinutes), 1 + members.Count / 64);
        return listing;
    }

    public async Task<IReadOnlyList<CategorySize>> ListCategoriesAsync(string prefix, int limit, CancellationToken ct)
    {
        var key = $"cats:{limit}:{prefix}";
        if (cache.TryGet(key, out IReadOnlyList<CategorySize>? cached) && cached is not null)
            return cached;

        using var doc = await GetJsonAsync(new Dictionary<string, string>
        {
            ["action"] = "query",
            ["list"] = "allcategories",
            ["acprefix"] = prefix,
            ["acprop"] = "size",
            ["aclimit"] = Math.Clamp(limit, 1, 500).ToString(),
            ["format"] = "json",
            ["formatversion"] = "2",
        }, ct);

        IReadOnlyList<CategorySize> categories = doc.RootElement.GetProperty("query").TryGetProperty("allcategories", out var list)
            ? list.EnumerateArray()
                .Select(c => new CategorySize("Category:" + c.GetProperty("category").GetString(), c.GetProperty("pages").GetInt32()))
                .ToList()
            : [];
        cache.Set(key, categories, TimeSpan.FromMinutes(options.PageCacheMinutes), 1);
        return categories;
    }

    public async Task<IReadOnlyList<string>> SuggestAsync(string prefix, int limit, CancellationToken ct)
    {
        var key = $"suggest:{limit}:{prefix}";
        if (cache.TryGet(key, out IReadOnlyList<string>? cached) && cached is not null)
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
        cache.Set(key, titles, TimeSpan.FromMinutes(options.PageCacheMinutes), 1);
        return titles;
    }

    /// <summary>Returns only titles with a definitive answer: a page, or null when missing/invalid.</summary>
    private async Task<Dictionary<string, WikiPage?>> FetchPagesAsync(IReadOnlyList<string> titles, CancellationToken ct)
    {
        var parameters = new Dictionary<string, string>
        {
            ["action"] = "query",
            ["prop"] = "revisions|redirects",
            ["rdprop"] = "title",
            ["rdlimit"] = "max",
            ["rvprop"] = "ids|timestamp|content",
            ["rvslots"] = "main",
            ["titles"] = string.Join('|', titles),
            ["redirects"] = "1",
            ["format"] = "json",
            ["formatversion"] = "2",
        };

        var renames = new Dictionary<string, string>(StringComparer.Ordinal);
        var pages = new Dictionary<string, WikiPage?>(StringComparer.Ordinal);
        var aliases = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        var continuationKeys = new List<string>();
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
                    {
                        ReadPage(page, pages);
                        if (!page.TryGetProperty("redirects", out var incoming)) continue;
                        var title = page.GetProperty("title").GetString()!;
                        if (!aliases.TryGetValue(title, out var titlesForPage))
                            aliases[title] = titlesForPage = new(StringComparer.Ordinal);
                        foreach (var item in incoming.EnumerateArray())
                        {
                            var alias = item.GetProperty("title").GetString()!;
                            if (!alias.Contains(':') || alias.StartsWith("Reconstruction:", StringComparison.Ordinal))
                                titlesForPage.Add(alias);
                        }
                    }
                }
            }

            // Large batches can be split by the API; follow its continuation parameters.
            if (!root.TryGetProperty("continue", out var next))
                break;
            foreach (var key in continuationKeys) parameters.Remove(key);
            continuationKeys.Clear();
            foreach (var property in next.EnumerateObject())
            {
                parameters[property.Name] = property.Value.ToString();
                continuationKeys.Add(property.Name);
            }
        }

        foreach (var (title, redirects) in aliases)
            if (pages.GetValueOrDefault(title) is { } page)
                pages[title] = page with { RedirectTitles = redirects.ToArray() };

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
        if (options.BrowserMode)
            parameters["origin"] = "*";
        var url = options.ApiUrl + "?" + string.Join('&',
            parameters.Select(p => $"{Uri.EscapeDataString(p.Key)}={Uri.EscapeDataString(p.Value)}"));

        for (var attempt = 0; ; attempt++)
        {
            var status = default(HttpStatusCode);
            TimeSpan? retryAfter = null;

            await _gate.WaitAsync(ct);
            try
            {
                using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
                deadline.CancelAfter(http.Timeout);
                var token = deadline.Token;
                using var request = new HttpRequestMessage(HttpMethod.Get, url);
                request.Headers.TryAddWithoutValidation(options.BrowserMode ? "Api-User-Agent" : "User-Agent", options.UserAgent);
                using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
                status = response.StatusCode;
                retryAfter = response.Headers.RetryAfter?.Delta
                    ?? (response.Headers.RetryAfter?.Date is { } date ? date - DateTimeOffset.UtcNow : null);
                if (retryAfter < TimeSpan.Zero)
                    retryAfter = TimeSpan.Zero;
                if (response.IsSuccessStatusCode && response.Content.Headers.ContentType?.MediaType == "application/json")
                {
                    await using var stream = await response.Content.ReadAsStreamAsync(token);
                    var doc = await JsonDocument.ParseAsync(stream, cancellationToken: token);
                    if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("error", out var error))
                    {
                        var code = error.TryGetProperty("code", out var c) ? c.GetString() : "unknown";
                        doc.Dispose();
                        throw new UpstreamUnavailableException($"Wiktionary API 回報錯誤（{code}）。", retryAfter,
                            rateLimited: code == "ratelimited");
                    }
                    return doc;
                }
            }
            catch (HttpRequestException ex)
            {
                throw new UpstreamUnavailableException("無法連線至 Wiktionary。", null, ex);
            }
            catch (OperationCanceledException ex) when (!ct.IsCancellationRequested)
            {
                throw new UpstreamUnavailableException("Wiktionary 回應逾時。", null, ex);
            }
            catch (JsonException ex)
            {
                throw new UpstreamUnavailableException("Wiktionary 回傳無法解析的內容。", null, ex);
            }
            finally
            {
                _gate.Release();
            }

            var retryable = status is HttpStatusCode.TooManyRequests or HttpStatusCode.BadGateway
                or HttpStatusCode.ServiceUnavailable or HttpStatusCode.GatewayTimeout;
            var delay = retryAfter ?? TimeSpan.FromSeconds(1 << attempt);
            if (!retryable || attempt >= options.MaxRetries || delay > TimeSpan.FromSeconds(options.MaxRetryDelaySeconds))
            {
                log?.Invoke($"Wiktionary request failed with HTTP {(int)status} (Retry-After: {retryAfter})");
                throw new UpstreamUnavailableException($"Wiktionary 暫時無法使用（HTTP {(int)status}）。", retryAfter,
                    rateLimited: status == HttpStatusCode.TooManyRequests);
            }
            await Task.Delay(delay, ct);
        }
    }

    private static string PageKey(string title) => "page:" + title;
}
