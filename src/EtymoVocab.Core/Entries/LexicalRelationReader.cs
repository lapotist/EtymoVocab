using System.Text.RegularExpressions;
using EtymoVocab.Core.Languages;
using EtymoVocab.Core.Wikitext;

namespace EtymoVocab.Core.Entries;

/// <summary>Reads inline syn/ant templates and dedicated sections without mining definitions or examples for links.</summary>
internal static partial class LexicalRelationReader
{
    public static IReadOnlyList<LexicalRelation> Read(
        string text, IReadOnlyList<Heading> headings, int index, string lang, LanguageRegistry languages)
    {
        var groups = new List<LexicalRelation>();

        void Add(string kind, string sense, IEnumerable<string> rawTerms)
        {
            var terms = rawTerms.Select(CleanTerm).Where(t => t.Length > 0).Distinct(StringComparer.Ordinal).ToList();
            if (terms.Count == 0) return;
            var existing = groups.FindIndex(g => g.Kind == kind && g.Sense == sense);
            if (existing < 0) groups.Add(new LexicalRelation(kind, sense, terms));
            else groups[existing] = groups[existing] with
            {
                Terms = groups[existing].Terms.Concat(terms).Distinct(StringComparer.Ordinal).ToList(),
            };
        }

        string sense = "";
        foreach (var line in WikiSections.OwnText(text, headings, index).Split('\n'))
        {
            // Quote/example templates can themselves contain syn/ant examples; only definition lines count.
            if (!line.StartsWith('#')) continue;
            var body = line.TrimStart('#');
            if (body.StartsWith('*')) continue;
            if (!body.StartsWith(':')) sense = PlainTextRenderer.Render(body, languages);
            foreach (var template in TemplateScanner.Scan(line))
            {
                var kind = template.Name switch
                {
                    "syn" or "synonyms" => "synonym",
                    "ant" or "antonyms" => "antonym",
                    _ => null,
                };
                if (kind is not null && template.Arg(1) == lang)
                    Add(kind, template.Param("sense") ?? sense, template.ArgsFrom(2));
            }
        }

        for (var j = index + 1; j < headings.Count && headings[j].Level > headings[index].Level; j++)
        {
            var kind = headings[j].Title switch
            {
                "Synonyms" => "synonym", "Antonyms" => "antonym", _ => null,
            };
            if (kind is null) continue;
            foreach (var line in WikiSections.OwnText(text, headings, j).Split('\n'))
            {
                var terms = new List<string>();
                var templates = TemplateScanner.Scan(line);
                var label = templates.FirstOrDefault(t => t.Name is "sense" or "s" or "antsense");
                var sectionSense = label is null ? "" : PlainTextRenderer.Render(label.Arg(1) ?? "", languages);
                // Exclude links inside qualifiers, glosses, and other template arguments.
                var bare = line;
                foreach (var template in templates)
                {
                    if (template.Name is "l" or "link" or "m" or "mention" && template.Arg(1) == lang)
                        terms.Add(template.Arg(2) ?? "");
                    if (template.Name is "syn" or "synonyms" or "ant" or "antonyms" && template.Arg(1) == lang)
                        terms.AddRange(template.ArgsFrom(2));
                    if ((template.Name.StartsWith("col", StringComparison.Ordinal) || template.Name == "ws")
                        && template.Arg(1) == lang)
                        terms.AddRange(template.ArgsFrom(2));
                }
                foreach (var template in templates.Reverse())
                    bare = bare.Remove(template.Start, template.End - template.Start);
                terms.AddRange(LinkRegex().Matches(bare).Select(m => m.Groups[1].Value));
                Add(kind, sectionSense, terms);
            }
        }
        return groups;
    }

    private static string CleanTerm(string raw)
    {
        var term = WikitextCleaner.PlainTerm(raw).Split('#')[0].Trim();
        // Thesaurus/Appendix targets are navigation, not English words. Don't turn them into fake entries.
        return term is "" or "-" || term.Contains(':') || term.Contains("{{") || term.Length > 100 ? "" : term;
    }

    [GeneratedRegex(@"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]")]
    private static partial Regex LinkRegex();
}
