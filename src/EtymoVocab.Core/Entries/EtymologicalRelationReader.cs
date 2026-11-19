using System.Text.RegularExpressions;
using EtymoVocab.Core.Wikitext;

namespace EtymoVocab.Core.Entries;

/// <summary>
/// Reads only dedicated Derived terms / Related terms sections. Wiktionary defines these as
/// etymological relationships; semantic sections, definitions, and arbitrary prose are never mined.
/// </summary>
internal static partial class EtymologicalRelationReader
{
    public static IReadOnlyList<EtymologicalRelation> Read(string text, string section, string lang)
    {
        var kind = section == "Derived terms" ? "derived" : "related";
        var result = new List<EtymologicalRelation>();
        var seen = new HashSet<(string Lang, string Term)>();

        void Add(string raw, string termLang)
        {
            raw = IndentationRegex().Replace(raw.Trim(), "");
            var parsed = InlineTerm.Parse(raw, allowLangPrefix: true);
            termLang = parsed.Lang ?? termLang;
            var link = LinkRegex().Match(parsed.Term);
            var target = link.Success && link.Value == parsed.Term ? link.Groups[1].Value : parsed.Term;
            var term = WikitextCleaner.PlainTerm(target).Split('#')[0].Trim();
            if (term.Length is 0 or > 100 || !term.Any(char.IsLetterOrDigit)
                || term.Contains(':') || term.Contains("{{") || term.Contains('<') || term.Contains('>')
                || term.Any(char.IsControl) || !seen.Add((termLang, term)))
                return;
            result.Add(new(kind, termLang, term, section));
        }

        var templates = TemplateScanner.Scan(text);
        foreach (var template in templates)
        {
            if (TemplateKinds.IsMention(template.Name) && template.Arg(1) is { } termLang)
                Add(template.Arg(2) ?? "", termLang);
            else if (ColumnTemplateRegex().IsMatch(template.Name))
            {
                // Older lists use |lang=en instead of a leading language argument.
                var columnLang = template.Param("lang") ?? template.Arg(1);
                if (columnLang is null) continue;
                foreach (var argument in template.ArgsFrom(template.Param("lang") is null ? 2 : 1))
                foreach (var item in ColumnItems(argument))
                {
                    var nested = TemplateScanner.Scan(item);
                    if (nested.Count == 1 && item.Trim() == item[nested[0].Start..nested[0].End]
                        && TemplateKinds.IsMention(nested[0].Name) && nested[0].Arg(1) is { } nestedLang)
                        Add(nested[0].Arg(2) ?? "", nestedLang);
                    else Add(item, columnLang);
                }
            }
        }

        // Ignore links nested in qualifiers, glosses, and unsupported templates.
        foreach (var template in templates.Reverse())
            text = text.Remove(template.Start, template.End - template.Start);
        foreach (var line in text.Split('\n').Where(line => line.TrimStart().StartsWith('*')))
        foreach (Match link in LinkRegex().Matches(line))
            Add(link.Groups[1].Value, lang);
        return result;
    }

    // col's commas delimit variants only without a following space; commas inside [[links]] or
    // <inline modifiers> are literal. Tildes also separate variants. Keep phrase punctuation intact.
    private static IEnumerable<string> ColumnItems(string raw)
    {
        var start = 0;
        var angle = 0;
        var brackets = 0;
        var braces = 0;
        for (var i = 0; i < raw.Length; i++)
        {
            switch (raw[i])
            {
                case '<': angle++; break;
                case '>': angle = Math.Max(0, angle - 1); break;
                case '[': brackets++; break;
                case ']': brackets = Math.Max(0, brackets - 1); break;
                case '{': braces++; break;
                case '}': braces = Math.Max(0, braces - 1); break;
            }
            if (angle != 0 || brackets != 0 || braces != 0) continue;
            if (raw[i] == '~' || (raw[i] == ',' && i + 1 < raw.Length && !char.IsWhiteSpace(raw[i + 1])))
            {
                yield return raw[start..i].Trim();
                start = i + 1;
            }
        }
        yield return raw[start..].Trim();
    }

    [GeneratedRegex(@"^(?:col|der|rel)[1-5]?$", RegexOptions.CultureInvariant)]
    private static partial Regex ColumnTemplateRegex();

    [GeneratedRegex(@"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]")]
    private static partial Regex LinkRegex();

    [GeneratedRegex(@"^\*+\s+")]
    private static partial Regex IndentationRegex();
}
