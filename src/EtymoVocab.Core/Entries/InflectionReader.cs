using EtymoVocab.Core.Wikitext;

namespace EtymoVocab.Core.Entries;

/// <summary>Reads explicit form-of definitions; never guesses a lemma by stripping suffixes.</summary>
internal static class InflectionReader
{
    private static readonly HashSet<string> FormTemplates = new(StringComparer.Ordinal)
    {
        "inflection of", "infl of", "verb form of", "noun form of", "adj form of", "adjective form of",
        "past of", "simple past of", "past tense of", "past participle of", "present participle of",
        "participle of", "gerund of", "third-person singular of",
        "third-person singular simple present indicative form of", "plural of", "comparative of", "superlative of",
    };

    private static readonly HashSet<string> EnglishFormTemplates = new(StringComparer.Ordinal)
    {
        "en-past of", "en-simple past of", "en-past participle of", "en-present participle of",
        "en-third-person singular of", "en-ing form of", "en-plural of", "en-comparative of", "en-superlative of",
    };

    public static (IReadOnlyList<string> Lemmas, bool OnlyInflections) Read(string definitions, string lang)
    {
        var lemmas = new List<string>();
        var onlyInflections = true;
        var count = 0;
        foreach (var line in definitions.Split('\n'))
        {
            if (!line.StartsWith('#'))
                continue;
            var definition = line.TrimStart('#').Trim();
            if (definition.Length == 0 || definition[0] is ':' or '*')
                continue;
            count++;
            var templates = TemplateScanner.Scan(definition);
            var found = false;
            var remainder = definition;
            foreach (var template in templates.Reverse())
            {
                var targets = Targets(template, lang);
                if (targets.Count > 0)
                {
                    found = true;
                    foreach (var target in targets)
                        if (!lemmas.Contains(target)) lemmas.Add(target);
                }
                else if (template.Name is not ("lb" or "lbl" or "label" or "q" or "qual" or "qualifier" or "senseid"))
                {
                    onlyInflections = false;
                }
                remainder = remainder.Remove(template.Start, template.End - template.Start);
            }
            onlyInflections &= found && remainder.Trim(' ', '\t', '.', ',', ';', ':', '!', '\'').Length == 0;
        }
        return (lemmas, count > 0 && onlyInflections);
    }

    private static IReadOnlyList<string> Targets(WikiTemplate template, string lang)
    {
        string? raw;
        if (lang == "en" && EnglishFormTemplates.Contains(template.Name))
            raw = template.Arg(1);
        else if (FormTemplates.Contains(template.Name))
        {
            var legacyLang = template.Param("lang");
            if ((legacyLang ?? template.Arg(1)) != lang)
                return [];
            raw = template.Arg(legacyLang is null ? 2 : 1);
        }
        else
            return [];

        if (raw is null)
            return [];
        // Commas outside links/modifiers separate alternative lemmas in form-of templates.
        return SplitLemmas(raw).Select(value =>
        {
            var target = InlineTerm.Parse(value, allowLangPrefix: false).Term.Trim();
            if (target.StartsWith("[[") && target.EndsWith("]]"))
                target = TemplateScanner.SplitTopLevel(target[2..^2], '|')[0];
            target = WikitextCleaner.PlainTerm(target).Split('#')[0].Trim();
            return target;
        }).Where(target => target.Length is > 0 and <= 100
            && target.IndexOfAny([':', '<', '>', '[', ']', '{', '}', '|', '/']) < 0
            && !target.Any(char.IsControl)).Distinct(StringComparer.Ordinal).ToList();
    }

    private static IEnumerable<string> SplitLemmas(string raw)
    {
        var start = 0;
        var depth = 0;
        for (var i = 0; i < raw.Length; i++)
        {
            if (raw[i] is '<' or '[') depth++;
            if (raw[i] is '>' or ']') depth--;
            if (raw[i] == ',' && depth == 0)
            {
                yield return raw[start..i];
                start = i + 1;
            }
        }
        yield return raw[start..];
    }
}
