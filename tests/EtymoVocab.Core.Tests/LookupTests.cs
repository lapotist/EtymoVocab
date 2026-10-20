using EtymoVocab.Core.Languages;
using EtymoVocab.Core.Lookup;

namespace EtymoVocab.Core.Tests;

public class LookupTests
{
    private static WordLookupService Service(FixtureClient client, LookupOptions? options = null) =>
        new(client, new LanguageRegistry(), options ?? new LookupOptions());

    [Fact]
    public async Task Inspect_is_enriched_from_ancestor_and_root_pages()
    {
        var client = new FixtureClient();

        var result = await Service(client).LookupAsync("inspect", CancellationToken.None);

        Assert.NotNull(result);
        Assert.True(result.Complete);
        Assert.Empty(result.Warnings);
        Assert.Equal(92362661, result.Source.RevisionId);
        Assert.Contains("oldid=92362661", result.Source.Url);

        var e = result.Etymologies.Single();
        var inspicio = e.Steps.Single(s => s.Term == "inspicio");
        Assert.Equal(("Latin", "inspicere", "to look into", "etymology"), (inspicio.LangName, inspicio.Display, inspicio.Gloss, inspicio.GlossSource));
        Assert.Equal(["in-", "speciō"], inspicio.Morphology.Single().Parts.Select(p => p.Term));
        Assert.Equal("https://en.wiktionary.org/wiki/inspicio#Latin", inspicio.Url);

        // speciō has one Latin etymology, so its first sense is a safe gloss for the part.
        var specio = inspicio.Morphology.Single().Parts[1];
        Assert.Equal("(OL., rare) to observe, watch, look at", specio.Gloss);

        var root = e.Roots.Single();
        Assert.Equal(("Proto-Indo-European", "*speḱ-", "to see, to look, to observe"), (root.LangName, root.Root, root.Gloss));
        Assert.True(client.PageRequests.Count <= new LookupOptions().MaxUpstreamRequests);
    }

    [Fact]
    public async Task Father_chain_is_followed_across_pages_by_etymon_id()
    {
        var result = await Service(new FixtureClient()).LookupAsync("father", CancellationToken.None);

        var steps = result!.Etymologies.Single().Steps;
        Assert.Equal(
            ["enm:fader", "ang:fæder", "gmw-pro:*fader", "gem-pro:*fadēr", "ine-pro:*ph₂tḗr"],
            steps.Select(s => $"{s.Lang}:{s.Term}"));
        Assert.All(steps, s => Assert.False(s.Ambiguous));
        Assert.Equal("Middle English", steps[0].LangName);
    }

    [Fact]
    public async Task Capitalised_input_falls_back_to_the_lowercase_page()
    {
        var result = await Service(new FixtureClient()).LookupAsync("Hotel", CancellationToken.None);

        Assert.Equal("hotel", result!.Word);
    }

    [Fact]
    public async Task Unknown_word_returns_null()
    {
        Assert.Null(await Service(new FixtureClient()).LookupAsync("qwertyzzz", CancellationToken.None));
    }

    [Fact]
    public async Task Request_budget_stops_expansion_with_a_warning_but_keeps_the_result_cacheable()
    {
        var client = new FixtureClient();

        var result = await Service(client, new LookupOptions { MaxUpstreamRequests = 1 })
            .LookupAsync("father", CancellationToken.None);

        Assert.Single(client.PageRequests);
        Assert.Equal("enm:fader", string.Join(",", result!.Etymologies.Single().Steps.Select(s => $"{s.Lang}:{s.Term}")));
        Assert.Single(result.Warnings);
        Assert.True(result.Complete);
    }

    [Fact]
    public async Task Upstream_failure_after_the_main_page_yields_a_partial_result()
    {
        var client = new FixtureClient { FailOnRequest = 2 };

        var result = await Service(client).LookupAsync("inspect", CancellationToken.None);

        Assert.NotNull(result);
        Assert.False(result.Complete);
        Assert.Single(result.Warnings);
        Assert.Equal(2, result.Etymologies.Single().Steps.Count);
    }

    [Fact]
    public async Task Upstream_failure_on_the_main_page_propagates()
    {
        var client = new FixtureClient { FailOnRequest = 1 };

        await Assert.ThrowsAsync<UpstreamUnavailableException>(
            () => Service(client).LookupAsync("inspect", CancellationToken.None));
    }

    [Fact]
    public async Task Entry_lookup_reads_any_language_section_for_tree_expansion()
    {
        var result = await Service(new FixtureClient()).LookupEntryAsync("la", "speciō", null, CancellationToken.None);

        Assert.NotNull(result);
        Assert.Equal(("specio", "la", "Latin"), (result.Word, result.Lang, result.LangName));
        Assert.EndsWith("#Latin", result.Source.Url);
        var e = result.Etymologies.Single();
        Assert.Equal("observe", e.Id);
        Assert.Equal(["itc-pro:*spekjō", "ine-pro:*spéḱyeti"], e.Steps.Select(s => $"{s.Lang}:{s.Term}"));
    }

    [Fact]
    public async Task Entry_lookup_narrows_homographs_by_etymon_id()
    {
        var result = await Service(new FixtureClient()).LookupEntryAsync("enm", "fader", "father", CancellationToken.None);

        Assert.Equal("father", result!.Etymologies.Single().Id);
    }

    [Fact]
    public async Task Root_family_lists_category_members_with_root_gloss()
    {
        var service = new RootFamilyService(new FixtureClient(), new LanguageRegistry());

        var family = await service.GetAsync("ine-pro", "*speḱ-", "en", CancellationToken.None);

        Assert.NotNull(family);
        Assert.Equal(FixtureClient.SpekCategory, family.Category);
        Assert.Equal(323, family.Total);
        Assert.Contains("inspect", family.Members);
        Assert.Equal("to see, to look, to observe", family.Gloss);
    }
}
