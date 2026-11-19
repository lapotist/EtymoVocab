using EtymoVocab.Core.Entries;
using EtymoVocab.Core.Languages;
using EtymoVocab.Core.Wikitext;

namespace EtymoVocab.Core.Tests;

public class MorphologyReaderTests
{
    private static Morphology? Read(string text) => MorphologyReader.FromTemplate(TemplateScanner.Scan(text).Single());

    [Theory]
    [InlineData("{{surf|+af|en|bio-|-logy}}")]
    [InlineData("{{surf|en|bio-|-logy}}")]
    [InlineData("{{surface analysis|+affix|en|bio-|-logy}}")]
    [InlineData("{{surface etymology|en|bio-|-logy}}")]
    public void Surface_analysis_supports_direct_and_wrapped_affixes(string text)
    {
        var result = Read(text)!;

        Assert.Equal("en", result.Lang);
        Assert.Equal("surf", result.Kind);
        Assert.Equal(["bio-", "-logy"], result.Parts.Select(part => part.Term));
        Assert.All(result.Parts, part => Assert.Equal("en", part.Lang));
    }

    [Fact]
    public void Wrapped_templates_preserve_formation_rules_and_part_metadata()
    {
        var result = Read("{{surf|+prefix|en|un|happy<t:content>|gloss1=not|id1=negative}}")!;

        Assert.Equal("surf", result.Kind);
        Assert.Equal(["un-", "happy"], result.Parts.Select(part => part.Term));
        Assert.Equal("not", result.Parts[0].Gloss);
        Assert.Equal("negative", result.Parts[0].EtymonId);
        Assert.Equal("content", result.Parts[1].Gloss);
    }

    [Theory]
    [InlineData("{{surf|+unknown|en|bio-|-logy}}")]
    [InlineData("{{surf|+af|en}}")]
    [InlineData("{{surf|+af}}")]
    public void Unsupported_or_empty_wrappers_do_not_invent_a_language_or_component(string text)
    {
        Assert.Null(Read(text));
    }

    [Fact]
    public void Biology_surface_analysis_reaches_entry_and_plain_text_without_plus_af_language()
    {
        const string text = "===Etymology===\n{{surf|+af|en|bio-|-logy}}.\n===Noun===\n# The study of life.";
        var languages = new LanguageRegistry();
        var entry = EntryParser.Parse(text, "en", languages).Single();
        var result = entry.Morphology.Single();

        Assert.Equal("en", result.Lang);
        Assert.Equal(["bio-", "-logy"], result.Parts.Select(part => part.Term));
        Assert.Equal("By surface analysis, bio- + -logy.", PlainTextRenderer.Render(entry.RawEtymology, languages));
    }
}
