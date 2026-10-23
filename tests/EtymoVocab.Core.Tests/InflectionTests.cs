using EtymoVocab.Core.Entries;
using EtymoVocab.Core.Languages;
using EtymoVocab.Core.Lookup;

namespace EtymoVocab.Core.Tests;

public class InflectionTests
{
    private static readonly LanguageRegistry Languages = new();

    [Theory]
    [InlineData("{{en-past of|walk}}", "walk")]
    [InlineData("{{en-simple past of|go}}", "go")]
    [InlineData("{{en-past participle of|write}}", "write")]
    [InlineData("{{en-ing form of|run}}", "run")]
    [InlineData("{{en-third-person singular of|carry}}", "carry")]
    [InlineData("{{past participle of|en|take}}", "take")]
    [InlineData("{{inflection of|en|stop||past}}", "stop")]
    [InlineData("{{infl of|en|study||3|s|pres}}", "study")]
    [InlineData("{{verb form of|en|be||1|s|pres}}", "be")]
    [InlineData("{{present participle of|lang=en|swim}}", "swim")]
    [InlineData("{{plural of|en|child}}", "child")]
    [InlineData("{{comparative of|en|good}}", "good")]
    [InlineData("{{lb|en|rare}} {{en-past of|[[walk#English|walked]]}}.", "walk")]
    [InlineData("{{inflection of|en|walk<q:rare, dated>||past}}", "walk")]
    public void Reads_explicit_lemmas(string definition, string expected)
    {
        var part = Parse($"===Verb===\n# {definition}").Single().PartsOfSpeech.Single();
        Assert.Equal([expected], part.Lemmas);
        Assert.True(part.OnlyInflections);
    }

    [Theory]
    [InlineData("{{alternative form of|en|walk}}")]
    [InlineData("{{past participle of|fr|marcher}}")]
    [InlineData("{{en-past of|Category:verbs}}")]
    [InlineData("{{en-past of|}}")]
    [InlineData("An ordinary definition.")]
    public void Does_not_treat_unrelated_or_invalid_definitions_as_inflections(string definition)
    {
        var part = Parse($"===Verb===\n# {definition}").Single().PartsOfSpeech.Single();
        Assert.Empty(part.Lemmas);
        Assert.False(part.OnlyInflections);
    }

    [Fact]
    public void Examples_and_quotations_do_not_supply_lemmas()
    {
        var part = Parse("===Verb===\n# A separate meaning.\n#: {{en-past of|walk}}\n#* {{en-past of|go}}")
            .Single().PartsOfSpeech.Single();
        Assert.Empty(part.Lemmas);
        Assert.False(part.OnlyInflections);
    }

    [Fact]
    public void Checks_all_definitions_even_after_the_display_limit()
    {
        var text = "===Verb===\n" + string.Join('\n', Enumerable.Repeat("# {{en-past of|walk}}", EntryParser.MaxSensesPerPartOfSpeech))
            + "\n# An independent meaning.";
        Assert.False(Parse(text).Single().PartsOfSpeech.Single().OnlyInflections);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Both_lookups_resolve_forms_and_use_the_lemma_source(bool discovery)
    {
        var client = Client(("walked", "===Verb===\n# {{en-past of|walk}}"), ("walk", BaseEntry));
        var result = await Lookup(client, " Walked ", discovery);
        Assert.NotNull(result);
        Assert.Equal("walk", result.Word);
        Assert.Equal("walked", result.ResolvedFrom);
        Assert.Equal("walk", result.Source.Title);
        Assert.Contains("title=walk&oldid=123", result.Source.Url);
        Assert.True(result.Complete);
        Assert.Empty(result.Warnings);
        Assert.Empty(result.BaseForms);
        var entry = Assert.Single(result.Etymologies);
        Assert.Equal("walken", Assert.Single(entry.Steps).Term);
        var relations = Assert.Single(entry.PartsOfSpeech).Relations;
        Assert.Contains(relations, r => r.Kind == "synonym" && r.Terms.Contains("stroll"));
        Assert.Contains(relations, r => r.Kind == "antonym" && r.Terms.Contains("stand"));
        Assert.Equal(discovery ? 2 : 3, client.Requests.Count);
        if (discovery) Assert.DoesNotContain(client.Requests.SelectMany(r => r), title => title == "walken");
    }

    [Theory]
    [InlineData("went", "{{en-simple past of|go}}", "go")]
    [InlineData("written", "{{past participle of|en|write}}", "write")]
    [InlineData("studying", "{{present participle of|en|study}}", "study")]
    [InlineData("stops", "{{inflection of|en|stop||3|s|pres}}", "stop")]
    public async Task Irregular_and_regular_forms_follow_dictionary_references(string word, string definition, string lemma)
    {
        var result = await Lookup(Client((word, $"===Verb===\n# {definition}"), (lemma, BaseEntry)), word);
        Assert.Equal(lemma, result!.Word);
        Assert.Equal(word, result.ResolvedFrom);
    }

    [Theory]
    [InlineData("===Noun===\n# A separate meaning.\n===Verb===\n# {{en-past of|see}}", "see")]
    [InlineData("===Verb===\n# {{en-past of|see}}\n# A separate meaning.", "see")]
    [InlineData("===Verb===\n# A use of {{en-past of|see}}.", "see")]
    public async Task Preserves_independent_meanings_and_offers_base_links(string entry, string lemma)
    {
        var client = Client(("saw", entry), (lemma, BaseEntry));
        var result = await Lookup(client, "saw");
        Assert.Equal("saw", result!.Word);
        Assert.Null(result.ResolvedFrom);
        Assert.Equal([lemma], result.BaseForms);
        Assert.Single(client.Requests);
    }

    [Theory]
    [InlineData("# {{inflection of|en|lie, lay||past}}")]
    [InlineData("# {{en-past of|lie}}\n# {{en-past of|lay}}")]
    public async Task Ambiguous_forms_offer_all_lemmas_without_guessing(string definitions)
    {
        var client = Client(("ambiguous", $"===Verb===\n{definitions}"));
        var result = await Lookup(client, "ambiguous");
        Assert.Equal("ambiguous", result!.Word);
        Assert.Equal(["lay", "lie"], result.BaseForms.OrderBy(t => t));
        Assert.Null(result.ResolvedFrom);
        Assert.Single(client.Requests);
    }

    [Fact]
    public async Task Missing_lemma_keeps_the_original_entry_and_a_link()
    {
        var result = await Lookup(Client(("walked", "===Verb===\n# {{en-past of|walk}}")), "walked");
        Assert.Equal("walked", result!.Word);
        Assert.Equal(["walk"], result.BaseForms);
        Assert.Null(result.ResolvedFrom);
        Assert.Single(result.Warnings);
    }

    [Fact]
    public async Task Failure_loading_the_lemma_keeps_a_partial_result()
    {
        var client = Client(("walked", "===Verb===\n# {{en-past of|walk}}"));
        client.FailOnRequest = 2;
        var result = await Lookup(client, "walked");
        Assert.Equal("walked", result!.Word);
        Assert.False(result.Complete);
        Assert.Single(result.Warnings);
    }

    [Fact]
    public async Task Cyclic_references_keep_the_original_entry()
    {
        var client = Client(("one", "===Verb===\n# {{en-past of|two}}"), ("two", "===Verb===\n# {{en-past of|one}}"));
        var result = await Lookup(client, "one");
        Assert.Equal("one", result!.Word);
        Assert.Null(result.ResolvedFrom);
        Assert.Single(result.Warnings);
        Assert.Equal(2, client.Requests.Count);
    }

    [Fact]
    public async Task Follows_chained_references_and_reports_the_original_form()
    {
        var client = Client(("one", "===Verb===\n# {{en-past of|two}}"),
            ("two", "===Verb===\n# {{en-past of|walk}}"), ("walk", BaseEntry));
        var result = await Lookup(client, "one");
        Assert.Equal("walk", result!.Word);
        Assert.Equal("one", result.ResolvedFrom);
        Assert.Equal("walk", result.Source.Title);
        Assert.Empty(result.Warnings);
        Assert.Equal(3, client.Requests.Count);
    }

    [Fact]
    public async Task Resolution_obeys_the_shared_request_budget()
    {
        var client = Client(("one", "===Verb===\n# {{en-past of|two}}"), ("two", "===Verb===\n# {{en-past of|three}}"));
        var service = new WordLookupService(client, Languages, new LookupOptions { MaxUpstreamRequests = 1 });
        var result = await service.LookupRelatedAsync("one", CancellationToken.None);
        Assert.Equal("one", result!.Word);
        Assert.Single(result.Warnings);
        Assert.Single(client.Requests);
    }

    [Fact]
    public async Task Tree_node_lookup_preserves_the_requested_entry()
    {
        var client = Client(("walked", "===Verb===\n# {{en-past of|walk}}"), ("walk", BaseEntry));
        var service = new WordLookupService(client, Languages, new LookupOptions());
        var result = await service.LookupEntryAsync("en", "walked", null, CancellationToken.None);
        Assert.Equal("walked", result!.Word);
        Assert.Null(result.ResolvedFrom);
        Assert.Single(client.Requests);
    }

    private const string BaseEntry = """
        ===Etymology===
        From {{inh|en|enm|walken}}.
        ===Verb===
        # To move on foot.
        #: {{syn|en|stroll}}
        #: {{ant|en|stand}}
        """;

    private static IReadOnlyList<EntrySection> Parse(string text) => EntryParser.Parse(text, "en", Languages);

    private static Task<WordResult?> Lookup(TestClient client, string word, bool discovery = true)
    {
        var service = new WordLookupService(client, Languages, new LookupOptions());
        return discovery ? service.LookupRelatedAsync(word, CancellationToken.None) : service.LookupAsync(word, CancellationToken.None);
    }

    private static TestClient Client(params (string Title, string Text)[] pages) => new(pages.ToDictionary(
        p => p.Title, p => new WikiPage(p.Title, 123, DateTimeOffset.Parse("2026-01-01T00:00:00Z"), "==English==\n" + p.Text)));

    private sealed class TestClient(Dictionary<string, WikiPage> pages) : IWiktionaryClient
    {
        public List<IReadOnlyList<string>> Requests { get; } = [];
        public int? FailOnRequest { get; set; }

        public Task<IReadOnlyDictionary<string, WikiPage?>> GetPagesAsync(IReadOnlyCollection<string> titles, CancellationToken ct)
        {
            Requests.Add(titles.ToList());
            if (Requests.Count == FailOnRequest) throw new UpstreamUnavailableException("simulated outage");
            return Task.FromResult<IReadOnlyDictionary<string, WikiPage?>>(titles.ToDictionary(t => t, t => pages.GetValueOrDefault(t)));
        }

        public Task<CategoryListing?> GetCategoryMembersAsync(string categoryTitle, int limit, CancellationToken ct) =>
            Task.FromResult<CategoryListing?>(null);

        public Task<IReadOnlyList<string>> SuggestAsync(string prefix, int limit, CancellationToken ct) =>
            Task.FromResult<IReadOnlyList<string>>([]);
    }
}
