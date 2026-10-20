using System.Text;
using EtymoVocab.Core.Wikitext;

namespace EtymoVocab.Core.Languages;

/// <summary>Maps a (language, term) pair to the Wiktionary page that holds its entry.</summary>
public static class EntryNames
{
    private const char CombiningMacron = '̄';
    private const char CombiningBreve = '̆';
    private const char CombiningDiaeresis = '̈';

    public static string? PageTitle(LanguageRegistry languages, string langCode, string term)
    {
        var section = languages.SectionNameOf(langCode);
        if (section is null)
            return null;

        var plain = WikitextCleaner.PlainTerm(term);
        if (plain.Length == 0 || plain == "-")
            return null;

        var entryLang = languages.EntryLanguageOf(langCode)!;
        if (plain.StartsWith('*'))
            return $"Reconstruction:{section}/{plain[1..]}";

        return StripEntryDiacritics(entryLang, plain);
    }

    public static string? PageUrl(string? title, string? sectionName)
    {
        if (title is null)
            return null;
        var path = Uri.EscapeDataString(title.Replace(' ', '_')).Replace("%3A", ":").Replace("%2F", "/");
        var anchor = sectionName is null ? "" : "#" + Uri.EscapeDataString(sectionName.Replace(' ', '_'));
        return $"https://en.wiktionary.org/wiki/{path}{anchor}";
    }

    /// <summary>
    /// Wiktionary page titles omit pronunciation marks that appear in running text
    /// (Latin <c>trānsportō</c> lives at <c>transporto</c>). Reconstructions keep them.
    /// </summary>
    private static string StripEntryDiacritics(string entryLang, string term)
    {
        var strip = entryLang switch
        {
            "la" => new[] { CombiningMacron, CombiningBreve, CombiningDiaeresis },
            "grc" or "ang" => new[] { CombiningMacron, CombiningBreve },
            _ => [],
        };
        if (strip.Length == 0)
            return term;

        var decomposed = term.Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder(decomposed.Length);
        foreach (var c in decomposed)
        {
            if (Array.IndexOf(strip, c) < 0)
                sb.Append(c);
        }
        return sb.ToString().Normalize(NormalizationForm.FormC);
    }
}
