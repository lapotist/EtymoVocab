using EtymoVocab.Core.Entries;
using EtymoVocab.Core.Languages;
using EtymoVocab.Core.Wikitext;

namespace EtymoVocab.Core.Lookup;

/// <summary>
/// Words sharing a root, read live from the category Wiktionary's <c>{{root}}</c> template maintains,
/// e.g. "Category:English terms derived from the Proto-Indo-European root *speḱ-".
/// </summary>
public sealed class RootFamilyService(IWiktionaryClient client, LanguageRegistry languages)
{
    public const int MaxMembers = 500;

    public async Task<RootFamilyResult?> GetAsync(string rootLang, string root, string targetLang, CancellationToken ct)
    {
        var rootTerm = WikitextCleaner.PlainTerm(root);
        var category = $"Category:{languages.NameOf(targetLang)} terms derived from the {languages.NameOf(rootLang)} root {rootTerm}";
        var listing = await client.GetCategoryMembersAsync(category, MaxMembers, ct);
        if (listing is null)
            return null;

        var title = EntryNames.PageTitle(languages, rootLang, rootTerm);
        var section = languages.SectionNameOf(rootLang);
        return new RootFamilyResult(
            rootLang,
            languages.NameOf(rootLang),
            rootTerm,
            await RootGlossAsync(title, section, languages.EntryLanguageOf(rootLang), ct),
            EntryNames.PageUrl(title, section),
            category,
            EntryNames.PageUrl(category, null)!,
            listing.TotalPages,
            listing.Members);
    }

    /// <summary>The root's first sense, if its page can be read; the family list is useful without it.</summary>
    private async Task<string?> RootGlossAsync(string? title, string? section, string? entryLang, CancellationToken ct)
    {
        if (title is null || section is null || entryLang is null)
            return null;
        try
        {
            var pages = await client.GetPagesAsync([title], ct);
            if (pages.GetValueOrDefault(title) is not { } page || WikiSections.LanguageSection(page.Wikitext, section) is not { } text)
                return null;
            return EntryParser.Parse(text, entryLang, languages).Select(e => e.FirstSense).FirstOrDefault(s => s is not null);
        }
        catch (UpstreamUnavailableException)
        {
            return null;
        }
    }
}
