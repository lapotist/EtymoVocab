using System.Text.Json;
using EtymoVocab.Core.Languages;
using EtymoVocab.Core.Lookup;

namespace EtymoVocab.Core.Tests;

public class RelatedBatchTests
{
    private static readonly DateTimeOffset Timestamp = DateTimeOffset.Parse("2026-10-24T00:00:00Z");
    private const string BaseEntry = "===Verb===\n# To move on foot. {{syn|en|stroll}} {{ant|en|stand}}";

    private static WordLookupService Service(IWiktionaryClient client, LookupOptions? options = null) =>
        new(client, new LanguageRegistry(), options ?? new LookupOptions());

    private sealed class Client : IWiktionaryClient
    {
        public Dictionary<string, WikiPage> Pages { get; } = new(StringComparer.Ordinal);
        public List<IReadOnlyList<string>> Requests { get; } = [];
        public int? FailOnRequest { get; set; }
        public Action? OnFetch { get; set; }

        public Client Add(string word, string text, long revision = 123)
        {
            Pages[word] = new(word, revision, Timestamp, "==English==\n" + text);
            return this;
        }

        public Task<IReadOnlyDictionary<string, WikiPage?>> GetPagesAsync(IReadOnlyCollection<string> titles, CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();
            Requests.Add(titles.ToArray());
            if (Requests.Count == FailOnRequest)
                throw new UpstreamUnavailableException("simulated rate limit", TimeSpan.FromSeconds(30));
            OnFetch?.Invoke();
            return Task.FromResult<IReadOnlyDictionary<string, WikiPage?>>(
                titles.Distinct(StringComparer.Ordinal).ToDictionary(title => title, title => Pages.GetValueOrDefault(title), StringComparer.Ordinal));
        }

        public Task<CategoryListing?> GetCategoryMembersAsync(string title, int limit, CancellationToken ct) => throw new NotSupportedException();
        public Task<IReadOnlyList<string>> SuggestAsync(string prefix, int limit, CancellationToken ct) => throw new NotSupportedException();
    }

    [Theory]
    [InlineData(5)]
    [InlineData(20)]
    public async Task Starting_pages_use_one_upstream_request_instead_of_one_per_word(int count)
    {
        var words = Enumerable.Range(0, count).Select(index => $"word{index}").ToArray();
        var individual = new Client();
        var batched = new Client();
        for (var index = 0; index < count; index++)
        {
            individual.Add(words[index], BaseEntry, index + 1);
            batched.Add(words[index], BaseEntry, index + 1);
        }
        var baseline = Service(individual);
        foreach (var word in words) await baseline.LookupRelatedAsync(word, CancellationToken.None);

        var results = await Service(batched).LookupRelatedBatchAsync(words, CancellationToken.None);

        Assert.Equal(count, individual.Requests.Count);
        Assert.Single(batched.Requests);
        Assert.Equal(words, batched.Requests[0]);
        Assert.Equal(words, results.Select(item => item.Word));
        for (var index = 0; index < count; index++)
        {
            Assert.Null(results[index].Error);
            Assert.Equal(index + 1, results[index].Data!.Source.RevisionId);
            Assert.True(results[index].Data!.Complete);
            Assert.Contains(results[index].Data!.Etymologies.Single().PartsOfSpeech.Single().Relations,
                relation => relation.Kind == "synonym" && relation.Terms.Contains("stroll"));
        }
    }

    [Fact]
    public async Task Exact_case_fallback_missing_and_invalid_items_are_isolated_in_input_order()
    {
        var client = new FixtureClient();
        var tooLong = new string('x', 101);

        var results = await Service(client).LookupRelatedBatchAsync(["Hotel", "qwertyzzz", "bad#title", tooLong, "nice"], CancellationToken.None);

        Assert.Equal(["Hotel", "qwertyzzz", "bad#title", tooLong, "nice"], results.Select(item => item.Word));
        Assert.Equal("hotel", results[0].Data!.Word);
        Assert.Equal(93738627, results[0].Data!.Source.RevisionId);
        Assert.Equal(404, results[1].Error!.Status);
        Assert.Equal(400, results[2].Error!.Status);
        Assert.Equal(400, results[3].Error!.Status);
        Assert.Equal("nice", results[4].Data!.Word);
        Assert.Single(client.PageRequests);
        Assert.Equal(["Hotel", "hotel", "qwertyzzz", "nice"], client.PageRequests[0]);
    }

    [Fact]
    public async Task Recorded_results_match_individual_discovery_without_fetching_ancestry()
    {
        var words = new[] { "nice", "bank", "inspect", "hotel", "father" };
        var client = new FixtureClient();
        var results = await Service(client).LookupRelatedBatchAsync(words, CancellationToken.None);
        var individual = Service(new FixtureClient());

        foreach (var item in results)
        {
            var expected = await individual.LookupRelatedAsync(item.Word, CancellationToken.None);
            Assert.Equal(JsonSerializer.Serialize(expected), JsonSerializer.Serialize(item.Data));
        }
        Assert.Single(client.PageRequests);
        Assert.Equal(words, client.PageRequests[0]);
    }

    [Fact]
    public async Task A_lemma_already_in_the_batch_resolves_without_another_request_even_at_the_budget()
    {
        var client = new Client().Add("walked", "===Verb===\n# {{en-past of|walk}}")
            .Add("walk", BaseEntry).Add("walking", "===Verb===\n# {{en-ing form of|walk}}");

        var results = await Service(client, new LookupOptions { MaxUpstreamRequests = 1 })
            .LookupRelatedBatchAsync(["walked", "walk", "walking"], CancellationToken.None);

        Assert.Single(client.Requests);
        Assert.All(results, item => Assert.Equal("walk", item.Data!.Word));
        Assert.Equal("walked", results[0].Data!.ResolvedFrom);
        Assert.Equal("walking", results[2].Data!.ResolvedFrom);
        Assert.All(results, item => Assert.Empty(item.Data!.Warnings));
    }

    [Fact]
    public async Task An_extra_lemma_is_fetched_once_and_shared_by_other_inflections()
    {
        var client = new Client().Add("walked", "===Verb===\n# {{en-past of|walk}}")
            .Add("walking", "===Verb===\n# {{en-ing form of|walk}}")
            .Add("walk", BaseEntry);

        var results = await Service(client).LookupRelatedBatchAsync(["walked", "walking"], CancellationToken.None);

        Assert.Equal(2, client.Requests.Count);
        Assert.Equal(["walked", "walking"], client.Requests[0]);
        Assert.Equal(["walk"], client.Requests[1]);
        Assert.All(results, item => Assert.Equal("walk", item.Data!.Source.Title));
        Assert.All(results, item => Assert.Contains("title=walk&oldid=123", item.Data!.Source.Url));
    }

    [Fact]
    public async Task Independent_meanings_and_ambiguous_forms_are_not_forced_to_a_lemma()
    {
        var client = new Client().Add("saw", "===Noun===\n# A cutting tool.\n===Verb===\n# {{en-past of|see}}")
            .Add("ambiguous", "===Verb===\n# {{en-past of|lie}}\n# {{en-past of|lay}}");

        var results = await Service(client).LookupRelatedBatchAsync(["saw", "ambiguous"], CancellationToken.None);

        Assert.Equal("saw", results[0].Data!.Word);
        Assert.Equal(["see"], results[0].Data!.BaseForms);
        Assert.Equal("ambiguous", results[1].Data!.Word);
        Assert.Equal(["lay", "lie"], results[1].Data!.BaseForms.OrderBy(word => word));
        Assert.Single(client.Requests);
    }

    [Fact]
    public async Task Initial_upstream_failures_preserve_retry_after_and_make_no_per_word_requests()
    {
        var client = new FixtureClient { FailOnRequest = 1 };

        var error = await Assert.ThrowsAsync<UpstreamUnavailableException>(() =>
            Service(client).LookupRelatedBatchAsync(["nice", "bank", "inspect"], CancellationToken.None));

        Assert.Equal(TimeSpan.FromSeconds(5), error.RetryAfter);
        Assert.Single(client.PageRequests);
    }

    [Fact]
    public async Task Lemma_failure_keeps_partial_results_without_retrying_each_remaining_lemma()
    {
        var client = new Client().Add("walked", "===Verb===\n# {{en-past of|walk}}")
            .Add("went", "===Verb===\n# {{en-past of|go}}")
            .Add("plain", BaseEntry);
        client.FailOnRequest = 2;

        var results = await Service(client).LookupRelatedBatchAsync(["walked", "went", "plain"], CancellationToken.None);

        Assert.Equal(2, client.Requests.Count);
        Assert.False(results[0].Data!.Complete);
        Assert.False(results[1].Data!.Complete);
        Assert.True(results[2].Data!.Complete);
        Assert.All(results, item => Assert.Null(item.Error));
    }

    [Fact]
    public async Task Cancellation_and_oversized_batches_do_not_start_work()
    {
        var client = new Client();
        var service = Service(client);
        await Assert.ThrowsAsync<ArgumentOutOfRangeException>(() => service.LookupRelatedBatchAsync(
            Enumerable.Range(0, 21).Select(index => $"word{index}").ToArray(), CancellationToken.None));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => service.LookupRelatedBatchAsync(["word"], new CancellationToken(true)));
        Assert.Empty(await service.LookupRelatedBatchAsync([], CancellationToken.None));
        Assert.Empty(client.Requests);
    }

    [Fact]
    public async Task Cancellation_after_prefetch_stops_before_parsing_results()
    {
        using var cancellation = new CancellationTokenSource();
        var client = new Client().Add("word", BaseEntry);
        client.OnFetch = cancellation.Cancel;

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            Service(client).LookupRelatedBatchAsync(["word"], cancellation.Token));

        Assert.Single(client.Requests);
    }

    [Fact]
    public async Task A_zero_request_budget_never_prefetches()
    {
        var client = new Client().Add("word", BaseEntry);

        var results = await Service(client, new LookupOptions { MaxUpstreamRequests = 0 })
            .LookupRelatedBatchAsync(["word"], CancellationToken.None);

        Assert.Empty(client.Requests);
        Assert.Null(results.Single().Data);
    }
}
