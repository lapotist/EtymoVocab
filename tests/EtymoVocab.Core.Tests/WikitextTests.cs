using EtymoVocab.Core.Languages;
using EtymoVocab.Core.Wikitext;

namespace EtymoVocab.Core.Tests;

public class WikitextTests
{
    [Fact]
    public void Scanner_keeps_nested_links_and_templates_inside_one_argument()
    {
        var t = TemplateScanner.Scan("x {{der|en|la|[[a|b]]|{{m|la|c}}|t=to look}} y").Single();

        Assert.Equal("der", t.Name);
        Assert.Equal("en", t.Arg(1));
        Assert.Equal("[[a|b]]", t.Arg(3));
        Assert.Equal("{{m|la|c}}", t.Arg(4));
        Assert.Equal("to look", t.Param("t"));
    }

    [Fact]
    public void Scanner_treats_numbered_parameters_as_positional()
    {
        var t = TemplateScanner.Scan("{{m|la|2=speciō}}").Single();

        Assert.Equal("la", t.Arg(1));
        Assert.Equal("speciō", t.Arg(2));
    }

    [Fact]
    public void Scanner_does_not_split_named_parameters_inside_inline_modifiers()
    {
        var t = TemplateScanner.Scan("{{af|la|x<t:a=b>}}").Single();

        Assert.Equal("x<t:a=b>", t.Arg(2));
        Assert.Empty(t.Named);
    }

    [Fact]
    public void Inline_term_parses_language_prefix_and_nested_ety_chain()
    {
        var term = InlineTerm.Parse("enm:transporten<ety:bor<fro:transporter>>", allowLangPrefix: true);
        var (keyword, _, terms) = InlineTerm.ParseEty(term.Mod("ety")!);

        Assert.Equal("enm", term.Lang);
        Assert.Equal("transporten", term.Term);
        Assert.Equal("bor", keyword);
        Assert.Equal("fro", terms.Single().Lang);
        Assert.Equal("transporter", terms.Single().Term);
    }

    [Fact]
    public void Inline_term_reads_modifiers_and_flags()
    {
        var part = InlineTerm.Parse("trāns-<id:beyond><t:across, over>", allowLangPrefix: false);
        var keyword = InlineTerm.Parse("af<surf>", allowLangPrefix: false);

        Assert.Null(part.Lang);
        Assert.Equal("trāns-", part.Term);
        Assert.Equal("beyond", part.Mod("id"));
        Assert.Equal("across, over", part.Mod("t"));
        Assert.Equal("af", keyword.Term);
        Assert.Contains("surf", keyword.Flags);
    }

    [Fact]
    public void Links_render_as_labels_and_files_are_dropped()
    {
        var text = WikitextCleaner.RenderLinks("[[File:X.jpg|thumb|A [[bank]]]] To [[examine]] [[critically|closely]].");

        Assert.Equal(" To examine closely.", text);
    }

    [Theory]
    [InlineData("la", "trānsportō", "transporto")]
    [InlineData("la-lat", "hospitālis", "hospitalis")]
    [InlineData("ang", "inscēawian", "insceawian")]
    [InlineData("grc", "σκέπτομαι", "σκέπτομαι")]
    [InlineData("gem-pro", "*fadēr", "Reconstruction:Proto-Germanic/fadēr")]
    [InlineData("ine-pro", "*speḱ-", "Reconstruction:Proto-Indo-European/speḱ-")]
    [InlineData("en", "[[in]]-", "in-")]
    public void Entry_names_follow_wiktionary_page_conventions(string lang, string term, string expected)
    {
        Assert.Equal(expected, EntryNames.PageTitle(new LanguageRegistry(), lang, term));
    }

    [Theory]
    [InlineData("gem", "")]
    [InlineData("xx-unknown", "foo")]
    [InlineData("en", "-")]
    public void Entry_names_are_null_when_there_is_no_page_to_fetch(string lang, string term)
    {
        Assert.Null(EntryNames.PageTitle(new LanguageRegistry(), lang, term));
    }

    [Fact]
    public void Page_urls_keep_namespace_separators_readable()
    {
        Assert.Equal(
            "https://en.wiktionary.org/wiki/Reconstruction:Proto-Indo-European/spe%E1%B8%B1-#Proto-Indo-European",
            EntryNames.PageUrl("Reconstruction:Proto-Indo-European/speḱ-", "Proto-Indo-European"));
    }

    [Fact]
    public void Live_language_tables_extend_the_curated_core()
    {
        var registry = new LanguageRegistry();
        registry.Merge("return {\n\t[\"aav-pro\"] = \"Proto-Austroasiatic\",\n}", "return { [\"la-x\"] = \"Some Latin\" }");

        Assert.Equal("Proto-Austroasiatic", registry.NameOf("aav-pro"));
        Assert.Equal("Proto-Austroasiatic", registry.SectionNameOf("aav-pro"));
        Assert.Equal("Some Latin", registry.NameOf("la-x"));
        Assert.Null(registry.SectionNameOf("la-x")); // parent unknown: do not guess a page
        Assert.Equal("Latin", registry.SectionNameOf("la-med"));
    }
}
