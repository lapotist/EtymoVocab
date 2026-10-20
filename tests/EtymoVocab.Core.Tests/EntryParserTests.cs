using EtymoVocab.Core.Entries;
using EtymoVocab.Core.Languages;
using EtymoVocab.Core.Wikitext;

namespace EtymoVocab.Core.Tests;

public class EntryParserTests
{
    private static readonly LanguageRegistry Languages = new();

    private static IReadOnlyList<EntrySection> Parse(string title, string language = "English", string code = "en") =>
        EntryParser.Parse(WikiSections.LanguageSection(FixtureClient.Page(title).Wikitext, language)!, code, Languages);

    private static string Chain(EntrySection section) =>
        string.Join(" < ", section.Steps.Select(s => $"{s.Lang}:{s.Term}"));

    private static IEnumerable<string> Terms(Morphology m) => m.Parts.Select(p => p.Term);

    [Fact]
    public void Inspect_reads_chain_connector_notes_morphology_root_senses_and_translations()
    {
        var e = Parse("inspect").Single();

        Assert.Equal("la:inspectum < la:inspicio", Chain(e));
        Assert.Equal("uder", e.Steps[0].Relation);
        Assert.Equal("past participle of", e.Steps[1].Note);
        Assert.Equal("to look into", e.Steps[1].Gloss);

        var plus = e.Morphology.Single(m => m.Kind == "plus");
        Assert.Equal(["in", "specio"], Terms(plus));
        Assert.Equal(["in", "to look at"], plus.Parts.Select(p => p.Gloss));
        Assert.Equal(["in-", "-spect"], Terms(e.Morphology.Single(m => m.Kind == "confix")));

        Assert.Equal(new RootRef("ine-pro", "*speḱ-", null), e.Roots.Single());

        var verb = e.PartsOfSpeech.Single(p => p.Pos == "Verb");
        Assert.StartsWith("To examine critically or carefully", verb.Senses[0]);
        var scrutinize = verb.Translations.Single(t => t.Sense == "examine critically, scrutinize");
        Assert.Equal(["調查", "檢查"], scrutinize.Terms);
    }

    [Fact]
    public void Transport_prefers_glossed_morphology_and_keeps_prose_chain()
    {
        var e = Parse("transport").Single();

        Assert.Equal("enm:transporten < fro:transporter < la:trānsportō", Chain(e));
        Assert.Equal(["inh", "der", "der"], e.Steps.Select(s => s.Relation));

        var latin = e.Morphology.Single(m => m.Lang == "la");
        Assert.Equal(["trāns-", "portō"], Terms(latin));
        Assert.Equal("across, over, to the farther side of", latin.Parts[0].Gloss);

        // {{etymon}}'s :af<surf> and {{surf}} describe the same split; the glossed one wins.
        var surface = e.Morphology.Single(m => m.Lang == "en");
        Assert.Equal("surf", surface.Kind);
        Assert.Equal(2, surface.GlossCount);
    }

    [Fact]
    public void Nice_skips_aside_mentions_but_keeps_their_word_formation()
    {
        var sections = Parse("nice");

        Assert.Equal("enm:nyce < fro:nice < la:nescius", Chain(sections[0]));
        var plus = sections[0].Morphology.Single(m => m.Kind == "plus");
        Assert.Equal(["ne", "sciō"], Terms(plus));
        Assert.Equal(["not", "to know"], plus.Parts.Select(p => p.Gloss));
        Assert.Empty(sections[1].Steps);
    }

    [Fact]
    public void Bank_keeps_homographs_apart_with_ids_and_uncertainty()
    {
        var sections = Parse("bank");

        Assert.Equal(["institution", "river edge", "row", "bench"], sections.Take(4).Select(s => s.EtymonId));
        Assert.Equal(
            "enm:banke < frm:banque < it:banca < lng:bank < gmw-pro:*banki < gem-pro:*bankiz < ine-pro:*bʰeg-",
            Chain(sections[0]));
        Assert.Equal("bank", sections[0].Steps[1].EtymonId); // copied from {{etymon}} frm:banque<id:bank>
        Assert.Equal(["bench", "banc", "banco"], sections[0].Doublets.Select(d => d.Term));
        // "Probably from {{der|en|fr|banc}}. Of {{der|en|gem}} origin": a hedged step, then a language-only one.
        Assert.True(sections[3].Uncertain);
        Assert.Equal("fr:banc < gem:", Chain(sections[3]));
        Assert.True(sections[3].Steps[0].Uncertain);
    }

    [Fact]
    public void Hotel_reads_borrowing_chain_and_doublets()
    {
        var e = Parse("hotel").Single();

        Assert.Equal("fr:hôtel < frm:hostel < fro:ostel < la-lat:hospitālis < la:hospitālis", Chain(e));
        Assert.Equal("bor", e.Steps[0].Relation);
        Assert.Equal(["hostel", "hospital"], e.Doublets.Select(d => d.Term));
    }

    [Fact]
    public void Spectacle_follows_from_and_of_connectors_but_not_see()
    {
        var e = Parse("spectacle").Single();

        Assert.Equal("enm:spectacle < frm:spectacle < la:spectāculum < la:spectō < la:speciō", Chain(e));
        Assert.Equal("frequentative of", e.Steps[^1].Note);
    }

    [Fact]
    public void Father_uses_the_etymon_when_the_prose_is_generated()
    {
        var e = Parse("father").Single();

        Assert.Empty(e.ProseSteps);
        var step = e.Steps.Single();
        Assert.Equal(("enm", "fader", "inh", "father"), (step.Lang, step.Term, step.Relation, step.EtymonId));
        Assert.Contains(e.Doublets, d => d.Term == "pater");
    }

    [Fact]
    public void Latin_entry_reads_etymon_affixes()
    {
        var e = Parse("inspicio", "Latin", "la").Single();

        var af = e.Morphology.Single();
        Assert.Equal("la", af.Lang);
        Assert.Equal(["in-", "speciō"], Terms(af));
        Assert.Equal("in", af.Parts[0].EtymonId);
    }

    [Fact]
    public void Middle_english_fader_identifies_its_etymology_by_id()
    {
        var sections = Parse("fader", "Middle English", "enm");

        Assert.Equal("father", sections[0].EtymonId);
        Assert.Equal("ang:fæder < gmw-pro:*fader < gem-pro:*fadēr < ine-pro:*ph₂tḗr", Chain(sections[0]));
        Assert.Equal("father", sections[0].Steps[0].EtymonId);
    }

    [Fact]
    public void Renderer_produces_readable_etymology_text()
    {
        var inspect = Parse("inspect").Single();
        var hotel = Parse("hotel").Single();

        Assert.Equal(
            "From Latin inspectum, past participle of inspicere (“to look into”), from in (“in”) + specere (“to look at”), equivalent to in- + -spect.",
            PlainTextRenderer.Render(inspect.RawEtymology, Languages));
        Assert.Equal(
            "Borrowed from French hôtel, from Middle French hostel, from Old French ostel, from Late Latin hospitālis (“hospice, shelter, guesthouse”), from Latin hospitālis (“hospitable”). Doublet of hostel and hospital.",
            PlainTextRenderer.Render(hotel.RawEtymology, Languages));
    }

    [Theory]
    [InlineData("{{suffix|ine-pro|*peh₂-|*tḗr}}", "*peh₂-", "*-tḗr")]
    [InlineData("{{suffix|ine-pro|*peh₂-|*-tḗr}}", "*peh₂-", "*-tḗr")]
    [InlineData("{{prefix|en|un|do}}", "un-", "do")]
    [InlineData("{{confix|en|in|spect}}", "in-", "-spect")]
    public void Affix_templates_hyphenate_parts(string template, string first, string second)
    {
        var morphology = MorphologyReader.FromTemplate(TemplateScanner.Scan(template).Single())!;

        Assert.Equal([first, second], Terms(morphology));
    }

    [Fact]
    public void Renderer_formats_labels()
    {
        Assert.Equal("(transitive) To carry", PlainTextRenderer.Render("{{lb|en|transitive}} To [[carry]]", Languages));
        Assert.Equal("(chiefly informal) Pleasant.", PlainTextRenderer.Render("{{lb|en|chiefly|informal}} [[pleasant|Pleasant]].", Languages));
    }
}
