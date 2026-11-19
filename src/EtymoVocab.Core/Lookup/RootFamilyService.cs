using EtymoVocab.Core.Entries;
using EtymoVocab.Core.Languages;
using EtymoVocab.Core.Wikitext;

namespace EtymoVocab.Core.Lookup;

/// <summary>
/// Words sharing an origin, read live from the categories Wiktionary's templates maintain:
/// <c>{{root}}</c> fills "Category:English terms derived from the Proto-Indo-European root *speḱ-",
/// and <c>{{af}}</c>/<c>{{prefix}}</c> fill "Category:English terms prefixed with trans-".
/// Homograph roots and affixes are split by sense id, e.g. "… root *per- (fare)".
/// </summary>
public sealed class RootFamilyService(IWiktionaryClient client, LanguageRegistry languages)
{
    public const int MaxMembers = 2000;

    /// <summary>
    /// A sense category this large is a real split, not a one-off editor id. Real data (2026-11): in- has
    /// "not" 177, "inverse" 112, "gem-into" 25, "la-into" 10; trans- and re- only have one-word ids.
    /// </summary>
    public const int MinSenseCategorySize = 10;

    public async Task<RootFamilyResult?> GetAsync(string rootLang, string root, string targetLang, string? id, CancellationToken ct)
    {
        var rootTerm = WikitextCleaner.PlainTerm(root);
        var category = $"Category:{languages.NameOf(targetLang)} terms derived from the {languages.NameOf(rootLang)} root {rootTerm}";
        return await BuildAsync(rootLang, rootTerm, category, id, ct);
    }

    /// <summary>Words formed with the same prefix (a stated word-formation relation, not a meaning relation).</summary>
    public async Task<RootFamilyResult?> GetPrefixAsync(string lang, string prefix, string? id, CancellationToken ct)
    {
        var prefixTerm = WikitextCleaner.PlainTerm(prefix);
        var category = $"Category:{languages.NameOf(lang)} terms prefixed with {prefixTerm}";
        return await BuildAsync(lang, prefixTerm, category, id, ct);
    }

    private async Task<RootFamilyResult?> BuildAsync(string lang, string term, string baseCategory, string? id, CancellationToken ct)
    {
        var (category, listing) = await FirstListingAsync(id is null ? [baseCategory] : [$"{baseCategory} ({id})", baseCategory], ct);
        if (listing is null)
            return null;

        // Without a usable sense, the plain category of a split form mixes different morphemes
        // (in- "not" with in- "into"): name the senses instead of presenting those words as relatives.
        var senses = category == baseCategory ? await SensesAsync(baseCategory, ct) : [];
        var ambiguous = senses.Count >= 2;

        var title = EntryNames.PageTitle(languages, lang, term);
        var section = languages.SectionNameOf(lang);
        string? gloss = null;
        RelatedLookupError? upstreamError = null;
        if (!ambiguous)
        {
            try
            {
                gloss = await FirstSenseAsync(title, section, languages.EntryLanguageOf(lang), id, ct);
            }
            catch (UpstreamUnavailableException error)
            {
                upstreamError = RelatedLookupError.FromUpstream(error);
            }
        }
        return new RootFamilyResult(
            lang,
            languages.NameOf(lang),
            term,
            gloss,
            EntryNames.PageUrl(title, section),
            category,
            EntryNames.PageUrl(category, null)!,
            listing.TotalPages,
            ambiguous ? [] : listing.Members)
        {
            Ambiguous = ambiguous,
            Senses = ambiguous ? senses : [],
            UpstreamError = upstreamError,
        };
    }

    /// <summary>Sense-specific categories ("… prefixed with in- (not)") large enough to be a real split, largest first.</summary>
    private async Task<IReadOnlyList<FamilySense>> SensesAsync(string baseCategory, CancellationToken ct)
    {
        var opening = baseCategory + " (";
        var categories = await client.ListCategoriesAsync(opening["Category:".Length..], 50, ct);
        return categories
            .Where(c => c.Title.StartsWith(opening, StringComparison.Ordinal) && c.Title.EndsWith(')') && c.Size >= MinSenseCategorySize)
            .Select(c => new FamilySense(c.Title[opening.Length..^1], c.Size, c.Title))
            .OrderByDescending(s => s.Size)
            .ToList();
    }

    /// <summary>
    /// The sense-specific category when it relates at least two words, else the plain one. A one-member sense
    /// category (real case: "prefixed with trans- (across, beyond)" holds only transport) is no family.
    /// </summary>
    private async Task<(string Category, CategoryListing? Listing)> FirstListingAsync(IReadOnlyList<string> categories, CancellationToken ct)
    {
        (string, CategoryListing?) fallback = (categories[^1], null);
        foreach (var category in categories)
        {
            var listing = await client.GetCategoryMembersAsync(category, MaxMembers, ct);
            if (listing is { Members.Count: > 1 } || (listing is { Members.Count: > 0 } && category == categories[^1]))
                return (category, listing);
            if (listing is not null && fallback.Item2 is null)
                fallback = (category, listing);
        }
        return fallback;
    }

    /// <summary>
    /// The entry's first sense, if its page can be read; the family list is useful without it. Pages with
    /// several homographs (PIE *per-, English in-) only yield a gloss when the id or a single entry identifies one.
    /// </summary>
    private async Task<string?> FirstSenseAsync(string? title, string? section, string? entryLang, string? id, CancellationToken ct)
    {
        if (title is null || section is null || entryLang is null)
            return null;
        var pages = await client.GetPagesAsync([title], ct);
        if (pages.GetValueOrDefault(title) is not { } page || WikiSections.LanguageSection(page.Wikitext, section) is not { } text)
            return null;
        var entries = EntryParser.Parse(text, entryLang, languages);
        var matches = id is null ? entries : entries.Where(e => e.EtymonId == id).ToList();
        return matches.Count == 1 ? matches[0].FirstSense : null;
    }
}
