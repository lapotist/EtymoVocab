using System.Text.Json;
using EtymoVocab.Core.Lookup;

namespace EtymoVocab.Core.Tests;

/// <summary>Serves recorded Wiktionary pages (see Fixtures/README.md) and counts upstream round trips.</summary>
internal sealed class FixtureClient : IWiktionaryClient
{
    public const string SpekCategory = "Category:English terms derived from the Proto-Indo-European root *speḱ-";

    private static readonly Lazy<Dictionary<string, WikiPage>> Pages = new(Load);

    /// <summary>Throws on the page request with this 1-based index, simulating an upstream outage.</summary>
    public int? FailOnRequest { get; init; }

    public List<IReadOnlyList<string>> PageRequests { get; } = [];

    public static WikiPage Page(string title) => Pages.Value[title];

    public Task<IReadOnlyDictionary<string, WikiPage?>> GetPagesAsync(IReadOnlyCollection<string> titles, CancellationToken ct)
    {
        PageRequests.Add(titles.ToList());
        if (PageRequests.Count == FailOnRequest)
            throw new UpstreamUnavailableException("simulated outage", TimeSpan.FromSeconds(5));
        IReadOnlyDictionary<string, WikiPage?> result = titles.Distinct()
            .ToDictionary(t => t, t => Pages.Value.GetValueOrDefault(t));
        return Task.FromResult(result);
    }

    /// <summary>
    /// Category listings shaped like the real ones (2026-11): homograph roots are split by sense id, and the
    /// bare "*per-" category is a nearly empty catch-all.
    /// </summary>
    private static readonly Dictionary<string, CategoryListing> Categories = new[]
    {
        new CategoryListing(SpekCategory, 323, ["aspect", "despise", "inspect", "spectacle"]),
        new CategoryListing("Category:English terms derived from the Proto-Indo-European root *per- (fare)", 1007, ["export", "port", "transport"]),
        new CategoryListing("Category:English terms derived from the Proto-Indo-European root *per-", 3, ["peri-"]),
        new CategoryListing("Category:English terms prefixed with trans-", 794, ["transfer", "translate", "transmit"]),
        new CategoryListing("Category:English terms prefixed with trans- (across, beyond)", 1, ["transport"]),
    }.ToDictionary(c => c.Title);

    public List<string> CategoryRequests { get; } = [];

    public Task<CategoryListing?> GetCategoryMembersAsync(string categoryTitle, int limit, CancellationToken ct)
    {
        CategoryRequests.Add(categoryTitle);
        return Task.FromResult(Categories.GetValueOrDefault(categoryTitle));
    }

    public Task<IReadOnlyList<string>> SuggestAsync(string prefix, int limit, CancellationToken ct) =>
        Task.FromResult<IReadOnlyList<string>>([]);

    private static Dictionary<string, WikiPage> Load()
    {
        var dir = Path.Combine(AppContext.BaseDirectory, "Fixtures");
        using var manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(dir, "manifest.json")));
        return manifest.RootElement.EnumerateArray().ToDictionary(
            e => e.GetProperty("title").GetString()!,
            e => new WikiPage(
                e.GetProperty("title").GetString()!,
                e.GetProperty("revisionId").GetInt64(),
                DateTimeOffset.Parse(e.GetProperty("timestamp").GetString()!),
                File.ReadAllText(Path.Combine(dir, e.GetProperty("file").GetString()!))));
    }
}
