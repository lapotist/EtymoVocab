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

    public Task<CategoryListing?> GetCategoryMembersAsync(string categoryTitle, int limit, CancellationToken ct) =>
        Task.FromResult(categoryTitle == SpekCategory
            ? new CategoryListing(categoryTitle, 323, ["aspect", "despise", "inspect", "spectacle"])
            : null);

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
