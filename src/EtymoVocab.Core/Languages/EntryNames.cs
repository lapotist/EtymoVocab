using System.Globalization;
using System.Text;
using EtymoVocab.Core.Wikitext;

namespace EtymoVocab.Core.Languages;

/// <summary>Maps a (language, term) pair to the Wiktionary page that holds its entry.</summary>
public static class EntryNames
{
    private const char CombiningMacron = '̄';
    private const char CombiningBreve = '̆';
    private const char CombiningDiaeresis = '̈';

    // Precomposed letters → base letter. A managed table instead of string.Normalize, which is a
    // no-op when the browser build runs without ICU (InvariantGlobalization).
    private static readonly Dictionary<char, char> MacronBreveLetters = Pairs(
        "āaĀAēeĒEīiĪIōoŌOūuŪUȳyȲYǣæǢÆ" + "ăaĂAĕeĔEĭiĬIŏoŎOŭuŬU" + "ᾱαᾹΑῑιῙΙῡυῩΥᾰαᾸΑῐιῘΙῠυῨΥ");

    private static readonly Dictionary<char, char> DiaeresisLetters = Pairs("äaÄAëeËEïiÏIöoÖOüuÜUÿyŸY");

    /// <summary>
    /// Canonical composition (NFC) for marks left after stripping (Greek α + ̓ → ἀ). The default uses
    /// ICU; the browser host replaces it with JavaScript's <c>String.prototype.normalize</c>.
    /// </summary>
    public static Func<string, string> ComposeCanonical { get; set; } = s => s.Normalize(NormalizationForm.FormC);

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
        var (stripDiaeresis, enabled) = entryLang switch
        {
            "la" => (true, true),
            "grc" or "ang" => (false, true),
            _ => (false, false),
        };
        if (!enabled)
            return term;

        var sb = new StringBuilder(term.Length);
        var hasMarks = false;
        foreach (var c in term)
        {
            if (c is CombiningMacron or CombiningBreve || (stripDiaeresis && c == CombiningDiaeresis))
                continue;
            if (MacronBreveLetters.TryGetValue(c, out var bare) || (stripDiaeresis && DiaeresisLetters.TryGetValue(c, out bare)))
            {
                sb.Append(bare);
                continue;
            }
            hasMarks |= CharUnicodeInfo.GetUnicodeCategory(c) == UnicodeCategory.NonSpacingMark;
            sb.Append(c);
        }
        return hasMarks ? ComposeCanonical(sb.ToString()) : sb.ToString();
    }

    private static Dictionary<char, char> Pairs(string pairs)
    {
        var map = new Dictionary<char, char>(pairs.Length / 2);
        for (var i = 0; i + 1 < pairs.Length; i += 2)
            map[pairs[i]] = pairs[i + 1];
        return map;
    }
}
