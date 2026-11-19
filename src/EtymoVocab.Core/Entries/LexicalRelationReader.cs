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
            var terms = new List<string>();
            var targets = new List<string>();
            foreach (var raw in rawTerms)
            {
                // A piped link's display text is not necessarily its destination.
                var link = LinkRegex().Match(raw);
                var target = (link.Success && link.Index == 0 ? link.Groups[1].Value : raw)
                    .Split('<')[0].Trim().TrimStart(':');
                if (target.StartsWith("Thesaurus:", StringComparison.OrdinalIgnoreCase))
                {
                    var title = target["Thesaurus:".Length..].Trim();
                    if (title.Split('#')[0].Trim().Length > 0)
                        targets.Add(title);
                }
                else if (CleanTerm(raw) is { Length: > 0 } term)
                    terms.Add(term);
            }
            if (terms.Count == 0 && targets.Count == 0) return;
            var existing = groups.FindIndex(g => g.Kind == kind && g.Sense == sense);
            var previous = existing < 0 ? new LexicalRelation(kind, sense, []) : groups[existing];
            var merged = previous with
            {
                Terms = previous.Terms.Union(terms, StringComparer.Ordinal).ToList(),
                ThesaurusTargets = previous.ThesaurusTargets.Union(targets, StringComparer.Ordinal).ToList(),
            };
            if (existing < 0) groups.Add(merged);
            else groups[existing] = merged;
        }

        string sense = "";
        foreach (var line in TemplateScanner.SplitTopLevel(WikiSections.OwnText(text, headings, index), '\n'))
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
            foreach (var rawLine in TemplateScanner.SplitTopLevel(WikiSections.OwnText(text, headings, j), '\n'))
            {
                var line = RemoveParentheticalNotes(rawLine);
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

    private static string RemoveParentheticalNotes(string line)
    {
        if (!line.Contains('(')) return line;
        var result = new System.Text.StringBuilder(line.Length);
        var templates = TemplateScanner.Scan(line);
        var templateIndex = 0;
        var depth = 0;
        for (var i = 0; i < line.Length;)
        {
            if (templateIndex < templates.Count && i == templates[templateIndex].Start)
            {
                var end = templates[templateIndex++].End;
                if (depth == 0) result.Append(line, i, end - i);
                i = end;
                continue;
            }
            if (line.AsSpan(i).StartsWith("[[") && line.IndexOf("]]", i + 2, StringComparison.Ordinal) is var close && close >= 0)
            {
                var end = close + 2;
                if (depth == 0) result.Append(line, i, end - i);
                i = end;
                while (templateIndex < templates.Count && templates[templateIndex].Start < end) templateIndex++;
                continue;
            }
            var c = line[i++];
            if (c == '(') depth++;
            else if (c == ')' && depth > 0) depth--;
            else if (depth == 0) result.Append(c);
        }
        return result.ToString();
    }

    private static string CleanTerm(string raw)
    {
        var term = WikitextCleaner.PlainTerm(raw).Split('#')[0].Trim();
        // List separators and Thesaurus/Appendix navigation are not word entries.
        return !term.Any(char.IsLetterOrDigit) || term.Contains(':') || term.Contains("{{") || term.Length > 100 ? "" : term;
    }

    [GeneratedRegex(@"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]")]
    private static partial Regex LinkRegex();
}
