using System.Text.Json;
using EtymoVocab.Core.Languages;
using EtymoVocab.Core.Lookup;

namespace EtymoVocab.Core.Tests;

public class OriginAnchorTests
{
    private static WikiPage Page(string title, string section, string text, long revision = 123) =>
        new(title, revision, DateTimeOffset.UnixEpoch, "==" + section + "==\n" + text);

    private static string Entry(string etymology, string? id = null, string pos = "Noun") =>
        "===Etymology===\n" + (id is null ? "" : "{{etymon|en|id=" + id + "}}\n") + etymology + "\n===" + pos + "===\n# A sense.";

    private static string Homographs(string first = "into", string second = "not") =>
        "===Etymology 1===\n{{etymon|en|id=" + first + "}}\n====Prefix====\n# First.\n"
        + "===Etymology 2===\n{{etymon|en|id=" + second + "}}\n====Prefix====\n# Second.";

    [Fact]
    public async Task Ancestor_identity_uses_entry_language_canonical_title_and_resolved_id()
    {
        var client = new MemoryClient(new Dictionary<string, WikiPage>
        {
            ["one"] = Page("one", "English", Entry("{{lbor|en|la-lat|speciō}}")),
            ["two"] = Page("two", "English", Entry("{{der|en|la|specio}}")),
            ["specio"] = Page("specio", "Latin", Entry("", "observe", "Verb"), 456),
        });
        var first = (await Service(client).LookupAsync("one", CancellationToken.None))!.Etymologies.Single();
        var second = (await Service(client).LookupAsync("two", CancellationToken.None))!.Etymologies.Single();
        var a = Assert.Single(first.OriginAnchors, a => a.Kind == "ancestor");
        var b = Assert.Single(second.OriginAnchors, a => a.Kind == "ancestor");
        Assert.Equal(a.Key, b.Key);
        Assert.Equal(["la", "specio", "observe"], JsonSerializer.Deserialize<string[]>(a.Key)!);
        Assert.Equal("la", a.Lang);
        Assert.Equal("specio", a.Title);
        Assert.Equal("observe", a.EtymonId);
        Assert.Equal("https://en.wiktionary.org/wiki/specio#Latin", a.Url);
        Assert.Contains("oldid=456", a.SourceUrl);
    }

    [Fact]
    public async Task Same_spelling_with_distinct_etymon_ids_never_shares_an_identity()
    {
        var client = new MemoryClient(new Dictionary<string, WikiPage>
        {
            ["one"] = Page("one", "English", Entry("{{af|en|in-<id:into>|base}}")),
            ["two"] = Page("two", "English", Entry("{{af|en|in-<id:not>|base}}")),
            ["in-"] = Page("in-", "English", Homographs()),
        });
        var one = (await Service(client).LookupAsync("one", CancellationToken.None))!.Etymologies.Single();
        var two = (await Service(client).LookupAsync("two", CancellationToken.None))!.Etymologies.Single();
        var a = Assert.Single(one.OriginAnchors, a => a.Kind == "component");
        var b = Assert.Single(two.OriginAnchors, a => a.Kind == "component");
        Assert.NotEqual(a.Key, b.Key);
        Assert.Equal("into", a.EtymonId);
        Assert.Equal("not", b.EtymonId);
    }

    [Fact]
    public async Task Ambiguous_component_without_an_id_is_not_an_anchor()
    {
        var client = new MemoryClient(new Dictionary<string, WikiPage>
        {
            ["word"] = Page("word", "English", Entry("{{af|en|in-|base}}")),
            ["in-"] = Page("in-", "English", Homographs()),
        });
        var entry = (await Service(client).LookupAsync("word", CancellationToken.None))!.Etymologies.Single();
        Assert.DoesNotContain(entry.OriginAnchors, a => a.Kind == "component");
    }

    [Fact]
    public async Task Components_with_explicit_glosses_still_resolve_identity_in_the_existing_batch()
    {
        var client = new MemoryClient(new Dictionary<string, WikiPage>
        {
            ["word"] = Page("word", "English", Entry("{{af|en|micro-<t:small>|-phone<t:sound>}}")),
            ["-phone"] = Page("-phone", "English", Entry("", "sound", "Suffix")),
            ["micro-"] = Page("micro-", "English", Entry("", pos: "Prefix")),
        });
        var entry = (await Service(client).LookupAsync("word", CancellationToken.None))!.Etymologies.Single();
        Assert.Contains(entry.OriginAnchors, a => a.Kind == "component" && a.Title == "-phone" && a.EtymonId == "sound");
        Assert.Equal(2, client.Requests.Count);
        Assert.Equal(["micro-", "-phone"], client.Requests[1]);
    }

    [Theory]
    [InlineData("{{cal|en|la|source}}", "")]
    [InlineData("{{sl|en|la|source}}", "")]
    [InlineData("{{etymon|en|:der<unc>|la:source}}", "")]
    public async Task Nontransitive_or_uncertain_ancestry_cannot_supply_shared_anchors(string relation, string ancestorUncertainty)
    {
        var client = new MemoryClient(new Dictionary<string, WikiPage>
        {
            ["word"] = Page("word", "English", Entry(relation + " From {{der|en|la|older}}.")),
            ["source"] = Page("source", "Latin", Entry(ancestorUncertainty)),
            ["older"] = Page("older", "Latin", Entry("")),
        });
        var entry = (await Service(client).LookupAsync("word", CancellationToken.None))!.Etymologies.Single();
        Assert.True(entry.Uncertain || entry.Steps[0].Uncertain || !entry.Steps[0].Transitive);
        Assert.All(entry.OriginAnchors, a => Assert.Equal("self", a.Kind));
    }

    [Fact]
    public async Task Uncertain_main_history_retains_only_the_words_own_resolved_identity()
    {
        var client = new MemoryClient(new Dictionary<string, WikiPage>
        {
            ["word"] = Page("word", "English", Entry("{{unc|en}} {{der|en|la|source}}")),
            ["source"] = Page("source", "Latin", Entry("")),
        });
        var entry = (await Service(client).LookupAsync("word", CancellationToken.None))!.Etymologies.Single();
        Assert.Equal("self", Assert.Single(entry.OriginAnchors).Kind);
    }

    [Fact]
    public async Task Missing_explicit_id_does_not_fall_back_even_on_a_single_etymology_page()
    {
        var client = new MemoryClient(new Dictionary<string, WikiPage>
        {
            ["word"] = Page("word", "English", Entry("{{der|en|la|source<id:wrong>}}")),
            ["source"] = Page("source", "Latin", Entry("", "right")),
        });
        var entry = (await Service(client).LookupAsync("word", CancellationToken.None))!.Etymologies.Single();
        Assert.DoesNotContain(entry.OriginAnchors, a => a.Kind == "ancestor");
    }

    [Fact]
    public async Task Language_only_homographs_cannot_acquire_self_identity_by_etymology_number()
    {
        var client = new MemoryClient(new Dictionary<string, WikiPage>
        {
            ["word"] = Page("word", "English", "===Etymology 1===\n====Noun====\n# First.\n===Etymology 2===\n====Verb====\n# Second."),
        });
        var entries = (await Service(client).LookupAsync("word", CancellationToken.None))!.Etymologies;
        Assert.Equal(2, entries.Count);
        Assert.All(entries, e => Assert.DoesNotContain(e.OriginAnchors, a => a.Kind == "self"));
    }

    [Fact]
    public async Task Selected_homograph_retains_its_id_instead_of_becoming_single()
    {
        var client = new MemoryClient(new Dictionary<string, WikiPage> { ["in-"] = Page("in-", "English", Homographs()) });
        var entry = (await Service(client).LookupEntryAsync("en", "in-", "into", CancellationToken.None))!.Etymologies.Single();
        var anchor = Assert.Single(entry.OriginAnchors);
        Assert.Equal("into", anchor.EtymonId);
        Assert.Equal(["en", "in-", "into"], JsonSerializer.Deserialize<string[]>(anchor.Key)!);
    }

    [Fact]
    public async Task Related_only_lookup_keeps_single_request_and_does_not_invent_unresolved_sources()
    {
        var client = new MemoryClient(new Dictionary<string, WikiPage>
        {
            ["word"] = Page("word", "English", Entry("{{der|en|la|source}} {{af|en|micro-|-phone}}")),
            ["source"] = Page("source", "Latin", Entry("")),
            ["micro-"] = Page("micro-", "English", Entry("")),
            ["-phone"] = Page("-phone", "English", Entry("")),
        });
        var entry = (await Service(client).LookupRelatedAsync("word", CancellationToken.None))!.Etymologies.Single();
        Assert.Single(client.Requests);
        Assert.Equal("self", Assert.Single(entry.OriginAnchors).Kind);
    }

    [Fact]
    public async Task Redirected_ancestor_and_main_titles_use_resolved_identity()
    {
        var client = new MemoryClient(new Dictionary<string, WikiPage>
        {
            ["alias"] = Page("Word", "English", Entry("{{der|en|la|oldtitle}}")),
            ["oldtitle"] = Page("newtitle", "Latin", Entry("")) with { RedirectTitles = ["other", "oldtitle"] },
        });
        var entry = (await Service(client).LookupAsync("alias", CancellationToken.None))!.Etymologies.Single();
        var self = Assert.Single(entry.OriginAnchors, a => a.Kind == "self" && a.Title == "Word");
        Assert.Equal(["alias"], self.LookupAliases);
        var ancestor = Assert.Single(entry.OriginAnchors, a => a.Kind == "ancestor");
        Assert.Equal("newtitle", ancestor.Title);
        Assert.Equal(["oldtitle", "other"], ancestor.LookupAliases);
        Assert.Collection(JsonSerializer.Deserialize<string?[]>(ancestor.Key)!,
            value => Assert.Equal("la", value), value => Assert.Equal("newtitle", value), value => Assert.Null(value));
    }

    [Fact]
    public async Task Root_anchors_require_resolved_entries_and_preserve_unicode_and_reconstruction_identity()
    {
        var client = new MemoryClient(new Dictionary<string, WikiPage>
        {
            ["word"] = Page("word", "English", Entry("{{root|en|ine-pro|*speḱ-|*missing-}}")),
            ["Reconstruction:Proto-Indo-European/speḱ-"] = Page("Reconstruction:Proto-Indo-European/speḱ-", "Proto-Indo-European", "===Root===\n# See."),
        });
        var entry = (await Service(client).LookupAsync("word", CancellationToken.None))!.Etymologies.Single();
        var anchor = Assert.Single(entry.OriginAnchors, a => a.Kind == "root");
        Assert.Equal("*speḱ-", anchor.Term);
        Assert.Collection(JsonSerializer.Deserialize<string?[]>(anchor.Key)!,
            value => Assert.Equal("ine-pro", value), value => Assert.Equal("Reconstruction:Proto-Indo-European/speḱ-", value), value => Assert.Null(value));
        Assert.Contains("speḱ-", anchor.Key);
    }

    [Fact]
    public async Task Sole_entry_null_identity_never_collides_with_an_editor_assigned_marker_id()
    {
        var plain = new MemoryClient(new Dictionary<string, WikiPage> { ["word"] = Page("word", "English", Entry("")) });
        var explicitId = new MemoryClient(new Dictionary<string, WikiPage> { ["word"] = Page("word", "English", Entry("", "__single__")) });
        var first = (await Service(plain).LookupAsync("word", CancellationToken.None))!.Etymologies.Single().OriginAnchors.Single();
        var second = (await Service(explicitId).LookupAsync("word", CancellationToken.None))!.Etymologies.Single().OriginAnchors.Single();
        Assert.NotEqual(first.Key, second.Key);
        Assert.Null(JsonSerializer.Deserialize<string?[]>(first.Key)![2]);
        Assert.Equal("__single__", JsonSerializer.Deserialize<string?[]>(second.Key)![2]);
    }

    [Theory]
    [InlineData("Probably {{af|en|base|-phone}}.")]
    [InlineData("Potentially assimilated to be equivalent to {{af|en|base|-phone}}.")]
    [InlineData("Likely {{af|en|base|-phone}}.")]
    [InlineData("Presumably {{af|en|base|-phone}}.")]
    [InlineData("Possibly equivalent to {{af|en|base|-phone}}.")]
    [InlineData("{{af|en|base<unc>|-phone}}.")]
    [InlineData("Probably {{root|en|ine-pro|*speḱ-}}.")]
    [InlineData("{{root|en|ine-pro|*speḱ-<unc>}}.")]
    [InlineData("Maybe {{etymon|en|:af|base|-phone}}.")]
    [InlineData("{{etymon|en|:af|base<unc>|-phone}}.")]
    [InlineData("{{etymon|en|:root|ine-pro:*speḱ-<unc>}}.")]
    [InlineData("{{etymon|en|:root|ine-pro:*speḱ-<unc:1>}}.")]
    [InlineData("{{etymon|en|:af<unc:1>|base|-phone}}.")]
    [InlineData("Possibly {{m|en|base}} + {{m|en|-phone}}.")]
    public async Task Hedged_and_explicitly_uncertain_formations_do_not_become_verification_evidence(string formation)
    {
        var client = new MemoryClient(new Dictionary<string, WikiPage>
        {
            ["word"] = Page("word", "English", Entry(formation)),
            ["base"] = Page("base", "English", Entry("")),
            ["-phone"] = Page("-phone", "English", Entry("")),
            ["Reconstruction:Proto-Indo-European/speḱ-"] = Page("Reconstruction:Proto-Indo-European/speḱ-", "Proto-Indo-European", "===Root===\n# See."),
        });
        var entry = (await Service(client).LookupAsync("word", CancellationToken.None))!.Etymologies.Single();
        Assert.True(entry.Uncertain);
        Assert.Equal("self", Assert.Single(entry.OriginAnchors).Kind);
        Assert.Empty(entry.Roots);
    }

    [Fact]
    public async Task Documented_equivalent_formation_remains_a_component_match_without_claiming_ancestry()
    {
        var client = new MemoryClient(new Dictionary<string, WikiPage>
        {
            ["word"] = Page("word", "English", Entry("Equivalent to {{af|en|base|-phone}}.")),
            ["base"] = Page("base", "English", Entry("")),
            ["-phone"] = Page("-phone", "English", Entry("")),
        });
        var entry = (await Service(client).LookupAsync("word", CancellationToken.None))!.Etymologies.Single();
        Assert.False(entry.Uncertain);
        Assert.Equal(2, entry.OriginAnchors.Count(a => a.Kind == "component"));
        Assert.DoesNotContain(entry.OriginAnchors, a => a.Kind == "ancestor");
    }

    [Fact]
    public async Task Real_happy_potential_assimilation_does_not_supply_verified_component_anchors()
    {
        var client = new FixtureClient();
        var entry = (await new WordLookupService(client, new LanguageRegistry(), new LookupOptions())
            .LookupAsync("happy", CancellationToken.None))!.Etymologies.Single();
        Assert.Contains("potentially assimilated", entry.Text);
        Assert.True(entry.Uncertain);
        Assert.Equal("self", Assert.Single(entry.OriginAnchors).Kind);
        // Explicit listed derivatives remain available; only inferred common-origin evidence is suppressed.
        Assert.Contains(entry.EtymologicalRelations, relation => relation.Term == "happiness");
    }

    [Fact]
    public async Task Definite_panis_component_and_ancestor_share_bread_identity_without_inheriting_its_uncertain_history()
    {
        // Faithful minimal reproductions of companion revision 93685817 and panis revision 93338331.
        // The proposed PIE history is uncertain; the Latin bread sense and com- + panis formation are not.
        var client = new MemoryClient(new Dictionary<string, WikiPage>
        {
            ["companion"] = Page("companion", "English", Entry("From {{prefix|la|com|pānis}}.")),
            ["pantry"] = Page("pantry", "English", Entry("From {{der|en|la|pānis<id:bread>}}.")),
            ["panis"] = Page("panis", "Latin", Entry("{{etymon|la|id=bread|:der|ine-pro:*peh₂-<id:protect><unc:1>}}\nOf {{unc|la}} origin. From {{der|la|ine-pro|*peh₂-<id:protect>}}.")),
            ["com-"] = Page("com-", "Latin", Entry("")),
            ["Reconstruction:Proto-Indo-European/peh₂-"] = Page("Reconstruction:Proto-Indo-European/peh₂-", "Proto-Indo-European", Entry("", "protect", "Root")),
        });
        var companion = (await Service(client).LookupAsync("companion", CancellationToken.None))!.Etymologies.Single();
        var pantry = (await Service(client).LookupAsync("pantry", CancellationToken.None))!.Etymologies.Single();
        var panis = (await Service(client).LookupEntryAsync("la", "pānis", "bread", CancellationToken.None))!.Etymologies.Single();
        var component = Assert.Single(companion.OriginAnchors, a => a.Kind == "component" && a.Title == "panis");
        var ancestor = Assert.Single(pantry.OriginAnchors, a => a.Kind == "ancestor");
        var own = Assert.Single(panis.OriginAnchors);
        Assert.Equal("self", own.Kind);
        Assert.Equal("bread", own.EtymonId);
        Assert.True(panis.Uncertain);
        Assert.True(pantry.Steps[0].AncestryUncertain);
        Assert.False(pantry.Steps[0].Uncertain);
        Assert.Equal(component.Key, ancestor.Key);
        Assert.Equal(component.Key, own.Key);
        Assert.DoesNotContain(companion.OriginAnchors.Concat(pantry.OriginAnchors), a => a.Lang == "ine-pro");
    }

    [Fact]
    public async Task Uncertain_ancestor_identity_is_allowed_but_its_roots_components_and_deeper_steps_are_not()
    {
        var client = new MemoryClient(new Dictionary<string, WikiPage>
        {
            ["word"] = Page("word", "English", Entry("{{der|en|la|source}} From {{der|en|la|older}}.")),
            ["source"] = Page("source", "Latin", Entry("{{unc|la}} {{af|la|component|-piece}} {{root|la|ine-pro|*speḱ-}}")),
            ["older"] = Page("older", "Latin", Entry("")),
            ["component"] = Page("component", "Latin", Entry("")),
            ["-piece"] = Page("-piece", "Latin", Entry("")),
            ["Reconstruction:Proto-Indo-European/speḱ-"] = Page("Reconstruction:Proto-Indo-European/speḱ-", "Proto-Indo-European", "===Root===\n# See."),
        });
        var entry = (await Service(client).LookupAsync("word", CancellationToken.None))!.Etymologies.Single();
        Assert.Empty(entry.Roots);
        Assert.Empty(entry.Steps[0].Morphology);
        var anchors = entry.OriginAnchors;
        Assert.Equal(["self", "ancestor"], anchors.Select(a => a.Kind));
        Assert.Equal("source", anchors[1].Title);
    }

    [Fact]
    public async Task Mention_uncertainty_prevents_confirmation_and_family_membership()
    {
        var client = new MemoryClient(new()
        {
            ["word"] = Page("word", "English", Entry("From {{m|la|source<unc:1>}}.")),
            ["source"] = Page("source", "Latin", Entry("{{root|la|ine-pro|*speḱ-}}")),
        });
        var entry = (await Service(client).LookupAsync("word", CancellationToken.None))!.Etymologies.Single();
        Assert.True(Assert.Single(entry.Steps).Uncertain);
        Assert.Equal("self", Assert.Single(entry.OriginAnchors).Kind);
        Assert.Empty(entry.Roots);
    }

    [Fact]
    public async Task Mixed_language_parts_retain_their_own_language_in_lookup_results()
    {
        var client = new MemoryClient(new()
        {
            ["word"] = Page("word", "English", Entry("{{af|en|pānis|lang1=la|-like}}")),
        });
        var entry = (await Service(client).LookupAsync("word", CancellationToken.None))!.Etymologies.Single();
        var part = Assert.Single(entry.Morphology).Parts[0];
        Assert.Equal(("la", "Latin"), (part.Lang, part.LangName));
        Assert.EndsWith("#Latin", part.Url);
    }

    [Theory]
    [InlineData(3, 55, true)]
    [InlineData(2, 50, false)]
    public async Task Enrichment_reads_each_available_batch_and_preserves_completed_work(int budget, int expected, bool complete)
    {
        var names = Enumerable.Range(1, 55).Select(i => "source" + i).ToArray();
        var pages = names.ToDictionary(name => name, name => Page(name, "Latin", Entry("")));
        pages["word"] = Page("word", "English", Entry(string.Join(", from ", names.Select(n => "{{der|en|la|" + n + "}}"))));
        var client = new MemoryClient(pages);
        var service = new WordLookupService(client, new LanguageRegistry(), new LookupOptions { MaxUpstreamRequests = budget });
        var result = (await service.LookupAsync("word", CancellationToken.None))!;
        Assert.Equal(complete, result.Complete);
        Assert.Equal(expected, result.Etymologies.Single().Steps.Count(s => s.Gloss != null));
        Assert.Equal(expected, result.Etymologies.Single().OriginAnchors.Count(a => a.Kind == "ancestor"));
        Assert.All(client.Requests, batch => Assert.InRange(batch.Length, 1, 50));
    }

    [Theory]
    [InlineData("unc")]
    [InlineData("unc:1")]
    public async Task Nested_etymon_uncertainty_is_retained_and_blocks_the_tentative_deeper_ancestor(string flag)
    {
        var client = new MemoryClient(new Dictionary<string, WikiPage>
        {
            ["word"] = Page("word", "English", Entry("{{etymon|en|:inh|enm:first<ety:der<la:deeper<" + flag + ">>>}}")),
            ["first"] = Page("first", "Middle English", Entry("")),
            ["deeper"] = Page("deeper", "Latin", Entry("")),
        });
        var entry = (await Service(client).LookupAsync("word", CancellationToken.None))!.Etymologies.Single();
        Assert.False(entry.Steps[0].Uncertain);
        Assert.True(entry.Steps[1].Uncertain);
        Assert.Equal("deeper", entry.Steps[1].Term);
        Assert.Contains(entry.OriginAnchors, a => a.Kind == "ancestor" && a.Title == "first");
        Assert.DoesNotContain(entry.OriginAnchors, a => a.Title == "deeper");
    }

    private static WordLookupService Service(MemoryClient client) => new(client, new LanguageRegistry(), new LookupOptions());

    private sealed class MemoryClient(Dictionary<string, WikiPage> pages) : IWiktionaryClient
    {
        public List<string[]> Requests { get; } = [];
        public Task<IReadOnlyDictionary<string, WikiPage?>> GetPagesAsync(IReadOnlyCollection<string> titles, CancellationToken ct)
        {
            Requests.Add(titles.ToArray());
            return Task.FromResult<IReadOnlyDictionary<string, WikiPage?>>(titles.ToDictionary(t => t, t => pages.GetValueOrDefault(t)));
        }
        public Task<CategoryListing?> GetCategoryMembersAsync(string title, int limit, CancellationToken ct) => Task.FromResult<CategoryListing?>(null);
        public Task<IReadOnlyList<CategorySize>> ListCategoriesAsync(string prefix, int limit, CancellationToken ct) => Task.FromResult<IReadOnlyList<CategorySize>>([]);
        public Task<IReadOnlyList<string>> SuggestAsync(string prefix, int limit, CancellationToken ct) => Task.FromResult<IReadOnlyList<string>>([]);
    }
}
