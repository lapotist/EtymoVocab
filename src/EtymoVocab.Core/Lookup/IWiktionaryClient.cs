namespace EtymoVocab.Core.Lookup;

public sealed record WikiPage(string Title, long RevisionId, DateTimeOffset Timestamp, string Wikitext);

public sealed record CategoryListing(string Title, int? TotalPages, IReadOnlyList<string> Members);

/// <param name="Title">Full title, including "Category:".</param>
public sealed record CategorySize(string Title, int Size);

/// <summary>Live access to English Wiktionary. Implementations batch, throttle and cache upstream calls.</summary>
public interface IWiktionaryClient
{
    /// <summary>
    /// Fetches the current revision of each page in one upstream round trip (at most 50 titles).
    /// Keys are the requested titles; redirects are followed; missing pages map to null.
    /// </summary>
    Task<IReadOnlyDictionary<string, WikiPage?>> GetPagesAsync(IReadOnlyCollection<string> titles, CancellationToken ct);

    /// <summary>
    /// Main-namespace members of a category, up to <paramref name="limit"/> (following continuation requests),
    /// or null when the category does not exist.
    /// </summary>
    Task<CategoryListing?> GetCategoryMembersAsync(string categoryTitle, int limit, CancellationToken ct);

    /// <summary>Categories whose title starts with <paramref name="prefix"/> (without "Category:"), with member counts.</summary>
    Task<IReadOnlyList<CategorySize>> ListCategoriesAsync(string prefix, int limit, CancellationToken ct);

    Task<IReadOnlyList<string>> SuggestAsync(string prefix, int limit, CancellationToken ct);
}

/// <summary>Wiktionary could not be reached, timed out, or refused the request (e.g. HTTP 429).</summary>
public sealed class UpstreamUnavailableException(string message, TimeSpan? retryAfter = null, Exception? inner = null)
    : Exception(message, inner)
{
    public TimeSpan? RetryAfter { get; } = retryAfter;
}
