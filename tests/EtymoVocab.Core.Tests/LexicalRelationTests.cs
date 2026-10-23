using EtymoVocab.Core.Entries;
using EtymoVocab.Core.Languages;
using EtymoVocab.Core.Lookup;
using EtymoVocab.Core.Wikitext;

namespace EtymoVocab.Core.Tests;

public class LexicalRelationTests
{
    private static readonly LanguageRegistry Languages = new();

    [Fact]
    public void Nice_has_sense_scoped_synonyms_and_antonyms_from_recorded_sections()
    {
        var entry = EntryParser.Parse(WikiSections.LanguageSection(FixtureClient.Page("nice").Wikitext, "English")!, "en", Languages)[0];
        var adjective = entry.PartsOfSpeech.Single(p => p.Pos == "Adjective");
        var person = adjective.Relations.Single(r => r.Kind == "synonym" && r.Sense == "easy to like: person");
        Assert.Equal(["charming", "delightful", "friendly", "kind", "lovely", "pleasant", "sweet"], person.Terms);
        Assert.Contains(adjective.Relations, r => r.Kind == "synonym" && r.Terms.Contains("appetizing"));
        Assert.Contains(adjective.Relations, r => r.Kind == "antonym" && r.Sense == "respectable; virtuous" && r.Terms.Contains("naughty"));
        Assert.DoesNotContain(adjective.Relations.SelectMany(r => r.Terms), t => t.Contains(':') || t.Contains('<'));
    }

    [Fact]
    public void Bank_keeps_inline_synonyms_with_their_own_homograph()
    {
        var entries = EntryParser.Parse(WikiSections.LanguageSection(FixtureClient.Page("bank").Wikitext, "English")!, "en", Languages);
        var finance = entries.Single(e => e.EtymonId == "institution").PartsOfSpeech.SelectMany(p => p.Relations).ToList();
        var river = entries.Single(e => e.EtymonId == "river edge").PartsOfSpeech.SelectMany(p => p.Relations).ToList();
        Assert.Contains(finance, r => r.Kind == "synonym" && r.Terms.Contains("Lombard house"));
        Assert.DoesNotContain(river, r => r.Terms.Contains("Lombard house"));
        Assert.Contains(river, r => r.Terms.Contains("bar"));
    }

    [Fact]
    public void Relations_exclude_example_links_namespaces_other_languages_and_qualifier_links()
    {
        const string text = """
            ===Adjective===
            # [[pleasant|Pleasant]].
            #: {{syn|en|kind<q:informal>|kind|nice#Adjective|Thesaurus:pleasant}}
            #: {{ant|en|cruel|sense=not kind}}
            #: {{ux|en|An example {{syn|en|fake}} with [[example]].}}
            #* {{quote-book|en|passage={{syn|en|also fake}}}}
            ====Synonyms====
            * {{sense|friendly}} {{l|en|warm}}, [[amiable|Amiable]], {{l|fr|gentil}}, {{q|[[dated]]}}
            * {{col2|en|affable|cordial}}
            ====Related terms====
            * [[unrelated]]
            ===Noun===
            # A thing.
            #: {{syn|en|object}}
            """;
        var entry = EntryParser.Parse(text, "en", Languages).Single();
        var adjective = entry.PartsOfSpeech.Single(p => p.Pos == "Adjective");
        Assert.Equal(["kind", "nice"], adjective.Relations.Single(r => r.Sense == "Pleasant.").Terms);
        Assert.Equal(["cruel"], adjective.Relations.Single(r => r.Kind == "antonym").Terms);
        Assert.Equal(["warm", "amiable"], adjective.Relations.Single(r => r.Sense == "friendly").Terms);
        Assert.Equal(["affable", "cordial"], adjective.Relations.Single(r => r.Sense == "").Terms);
        Assert.DoesNotContain(adjective.Relations.SelectMany(r => r.Terms), t => new[] { "fake", "also fake", "example", "dated", "gentil", "unrelated", "object" }.Contains(t));
        Assert.Equal("object", entry.PartsOfSpeech.Single(p => p.Pos == "Noun").Relations.Single().Terms.Single());
    }

    [Fact]
    public void Relations_exclude_punctuation_separators_from_inline_and_section_lists()
    {
        const string text = """
            ===Adjective===
            # A meaning.
            #: {{syn|en|friendly|;|kind|&#59;|&#x3B;|&amp;|...|—|??|,}}
            #: {{ant|en|cruel|;|unkind}}
            ====Synonyms====
            * {{col2|en|amiable|;|affable|&#59;}}
            * {{ws|en|cordial|;|warm}}
            * {{l|en|;}} [[;]] [[&#59;]] [[pleasant]]
            ====Antonyms====
            * {{col2|en|hostile|;|unfriendly}}
            * {{l|en|;}} [[;]]
            """;
        var relations = EntryParser.Parse(text, "en", Languages).Single().PartsOfSpeech.Single().Relations;
        Assert.Equal(["friendly", "kind", "amiable", "affable", "cordial", "warm", "pleasant"],
            relations.Where(r => r.Kind == "synonym").SelectMany(r => r.Terms));
        Assert.Equal(["cruel", "unkind", "hostile", "unfriendly"],
            relations.Where(r => r.Kind == "antonym").SelectMany(r => r.Terms));
    }

    [Fact]
    public void Relations_preserve_words_with_accents_apostrophes_hyphens_spaces_and_digits()
    {
        const string text = """
            ===Noun===
            # A synthetic definition.
            #: {{syn|en|café|co-operate|can't|ice cream|C++|24/7|B2B|rock 'n' roll}}
            """;
        var relation = EntryParser.Parse(text, "en", Languages).Single().PartsOfSpeech.Single().Relations.Single();
        Assert.Equal(["café", "co-operate", "can't", "ice cream", "C++", "24/7", "B2B", "rock 'n' roll"], relation.Terms);
    }

    [Fact]
    public async Task Discovery_fetches_only_the_main_page_and_preserves_source_and_relations()
    {
        var client = new FixtureClient();
        var service = new WordLookupService(client, Languages, new LookupOptions());
        var result = await service.LookupRelatedAsync("Nice", CancellationToken.None);
        Assert.NotNull(result);
        Assert.Equal("nice", result.Word);
        Assert.Single(client.PageRequests);
        Assert.Empty(result.Warnings);
        Assert.Contains("oldid=", result.Source.Url);
        Assert.Contains(result.Etymologies.SelectMany(e => e.PartsOfSpeech).SelectMany(p => p.Relations),
            r => r.Kind == "antonym" && r.Terms.Contains("nasty"));
    }
}
