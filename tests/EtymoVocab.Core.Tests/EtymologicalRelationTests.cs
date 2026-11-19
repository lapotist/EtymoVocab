using EtymoVocab.Core.Entries;
using EtymoVocab.Core.Languages;
using EtymoVocab.Core.Lookup;
using EtymoVocab.Core.Wikitext;

namespace EtymoVocab.Core.Tests;

public class EtymologicalRelationTests
{
    private static readonly LanguageRegistry Languages = new();

    [Theory]
    [InlineData("happy", "derived", "happiness")]
    [InlineData("happy", "derived", "happily")]
    [InlineData("telephone", "derived", "telephony")]
    [InlineData("telephone", "derived", "phone")]
    [InlineData("predict", "related", "prediction")]
    [InlineData("predict", "related", "predictable")]
    [InlineData("inspect", "derived", "inspection")]
    [InlineData("beautiful", "related", "beauty")]
    public void Real_pages_preserve_explicit_word_family_terms(string word, string kind, string term)
    {
        var page = FixtureClient.Page(word);
        var parsed = EntryParser.Parse(WikiSections.LanguageSection(page.Wikitext, "English")!, "en", Languages);
        Assert.Contains(parsed.SelectMany(e => e.EtymologicalRelations), r => r.Kind == kind && r.Lang == "en" && r.Term == term);
    }

    [Fact]
    public void Dedicated_sections_support_multiline_lists_and_variant_syntax_without_harvesting_glosses()
    {
        var entry = EntryParser.Parse("""
            ===Noun===
            # Definition [[irrelevant]].
            ====Derived terms====
            {{col|en
            |alpha<t:one,another>,beta~gamma
            |not happy, Jan
            |[[1,6-Cleves acid]]
            |{{l|en|delta}}
            |fr:epsilon
            |zeta<q:[[unwanted qualifier]]>
            |[[real target|display label]]
            |* nested-derived
            }}
            * {{l|en|eta|alternate label}} {{q|[[unwanted gloss]]}}
            * [[theta|display]]
            * [[Thesaurus:noise]]
            * {{unknown|[[unsupported]]}}
            ====Related terms====
            {{rel2|lang=en|iota|kappa}}
            ====Synonyms====
            {{col|en|synonym}}
            ====Antonyms====
            * [[antonym]]
            ====See also====
            * [[unrelated]]
            """, "en", Languages).Single();
        Assert.Equal(["alpha", "beta", "gamma", "not happy, Jan", "1,6-Cleves acid", "delta", "epsilon", "zeta", "real target", "nested-derived", "eta", "theta", "iota", "kappa"],
            entry.EtymologicalRelations.Select(r => r.Term));
        Assert.Equal("fr", entry.EtymologicalRelations.Single(r => r.Term == "epsilon").Lang);
        Assert.All(entry.EtymologicalRelations.Take(12), r => Assert.Equal("derived", r.Kind));
        Assert.All(entry.EtymologicalRelations.Skip(12), r => Assert.Equal("related", r.Kind));
    }

    [Fact]
    public void Homograph_lists_are_scoped_to_their_etymology_and_global_ambiguous_lists_are_excluded()
    {
        var entries = EntryParser.Parse("""
            ===Related terms===
            * [[before-either]]
            ===Etymology 1===
            Origin one.
            ====Noun====
            # Sense one.
            =====Derived terms=====
            {{col|en|first}}
            ===Etymology 2===
            Origin two.
            ====Verb====
            # Sense two.
            =====Related terms=====
            * {{l|en|second}}
            ===Derived terms===
            * [[ambiguous-global-list]]
            """, "en", Languages);
        Assert.Equal("first", Assert.Single(entries[0].EtymologicalRelations).Term);
        Assert.Equal("second", Assert.Single(entries[1].EtymologicalRelations).Term);
    }

    [Fact]
    public async Task Related_terms_have_pinned_source_evidence_and_cost_no_additional_requests()
    {
        var client = new FixtureClient();
        var result = await new WordLookupService(client, Languages, new LookupOptions())
            .LookupRelatedAsync("predict", CancellationToken.None);
        var prediction = Assert.Single(result!.Etymologies.Single().EtymologicalRelations, r => r.Term == "prediction");
        Assert.Equal("related", prediction.Kind);
        Assert.Equal("Related terms", prediction.SourceSection);
        Assert.Equal(result.Source.Url, prediction.SourceUrl);
        Assert.Contains("oldid=93715976", prediction.SourceUrl);
        Assert.Equal("https://en.wiktionary.org/wiki/prediction#English", prediction.Url);
        Assert.Single(client.PageRequests);
    }

    [Fact]
    public async Task Roots_on_unambiguous_ancestors_and_explicit_root_entries_are_retained()
    {
        var result = await Lookup("{{inh|en|enm|ancestor}}", "{{root|enm|ine-pro|*speḱ-}}\nFrom {{der|enm|ine-pro|*deyḱ-}}.", "Root");
        Assert.Equal(["*speḱ-", "*deyḱ-"], result.Etymologies.Single().Roots.Select(r => r.Root));
    }

    [Theory]
    [InlineData("{{cal|en|enm|ancestor}}")]
    [InlineData("{{cal|en|enm|ancestor}}. From {{der|en|ine-pro|*deyḱ-}}.")]
    [InlineData("{{der|en|enm|ancestor}}. From {{der|en|ine-pro|*deyḱ-}}.")]
    public async Task Root_inheritance_stops_at_nontransitive_or_ambiguous_link(string initial)
    {
        var ancestor = "===Etymology 1===\n{{root|enm|ine-pro|*speḱ-}}\n====Noun====\n# One.\n===Etymology 2===\n====Noun====\n# Two.";
        var result = await Lookup(initial, ancestor, "Root", rawAncestor: true);
        Assert.Empty(result.Etymologies.Single().Roots);
    }

    [Fact]
    public async Task Reconstructed_nouns_are_not_assumed_to_be_roots()
    {
        var result = await Lookup("{{inh|en|enm|ancestor}}", "From {{der|enm|ine-pro|*deyḱ-}}.", "Noun");
        Assert.Empty(result.Etymologies.Single().Roots);
    }

    private static async Task<WordResult> Lookup(string initial, string ancestor, string protoPos, bool rawAncestor = false)
    {
        WikiPage Page(string title, string text) => new(title, 123, DateTimeOffset.UnixEpoch, text);
        var client = new MemoryClient(new Dictionary<string, WikiPage>
        {
            ["word"] = Page("word", "==English==\n===Etymology===\n" + initial + "\n===Noun===\n# Word."),
            ["ancestor"] = Page("ancestor", "==Middle English==\n" + (rawAncestor ? ancestor : "===Etymology===\n" + ancestor + "\n===Noun===\n# Ancestor.")),
            ["Reconstruction:Proto-Indo-European/deyḱ-"] = Page("Reconstruction:Proto-Indo-European/deyḱ-", "==Proto-Indo-European==\n===" + protoPos + "===\n# A root."),
        });
        return (await new WordLookupService(client, Languages, new LookupOptions()).LookupAsync("word", CancellationToken.None))!;
    }

    private sealed class MemoryClient(Dictionary<string, WikiPage> pages) : IWiktionaryClient
    {
        public Task<IReadOnlyDictionary<string, WikiPage?>> GetPagesAsync(IReadOnlyCollection<string> titles, CancellationToken ct) =>
            Task.FromResult<IReadOnlyDictionary<string, WikiPage?>>(titles.ToDictionary(t => t, t => pages.GetValueOrDefault(t)));
        public Task<CategoryListing?> GetCategoryMembersAsync(string title, int limit, CancellationToken ct) => Task.FromResult<CategoryListing?>(null);
        public Task<IReadOnlyList<CategorySize>> ListCategoriesAsync(string prefix, int limit, CancellationToken ct) => Task.FromResult<IReadOnlyList<CategorySize>>([]);
        public Task<IReadOnlyList<string>> SuggestAsync(string prefix, int limit, CancellationToken ct) => Task.FromResult<IReadOnlyList<string>>([]);
    }
}
