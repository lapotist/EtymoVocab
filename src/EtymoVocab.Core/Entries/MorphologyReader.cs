using EtymoVocab.Core.Wikitext;

namespace EtymoVocab.Core.Entries;

/// <summary>Reads word-formation templates (<c>{{af}}</c>, <c>{{prefix}}</c>, <c>{{confix}}</c>, …) into parts.</summary>
public static class MorphologyReader
{
    public static Morphology? FromTemplate(WikiTemplate t)
    {
        var lang = t.Arg(1);
        if (lang is null || !TemplateKinds.IsAffix(t.Name))
            return null;

        var args = t.ArgsFrom(2).ToList();
        if (args.Count == 0)
            return null;

        var (kind, terms) = t.Name switch
        {
            // {{prefix|en|un|re|do}}: every part but the last is a prefix; {{suffix}} mirrors it.
            "prefix" or "pre" => ("prefix", args.Select((a, i) => i < args.Count - 1 ? Hyphenate(a, prefix: true) : a).ToList()),
            "suffix" or "suf" => ("suffix", args.Select((a, i) => i == 0 ? a : Hyphenate(a, prefix: false)).ToList()),
            "confix" or "con" => ("confix", Confix(args)),
            "compound" or "com" => ("compound", args),
            "surf" => ("surf", args),
            "blend" => ("blend", args),
            _ => ("af", args),
        };

        var parts = new List<MorphPart>(terms.Count);
        for (var i = 0; i < terms.Count; i++)
        {
            var n = (i + 1).ToString();
            var term = InlineTerm.Parse(terms[i], allowLangPrefix: false);
            if (term.Term.Length == 0)
                continue;
            parts.Add(new MorphPart(
                t.Param("lang" + n) ?? lang,
                term.Term,
                term.Mod("t") ?? term.Mod("gloss") ?? t.Param("t" + n, "gloss" + n),
                term.Mod("id") ?? t.Param("id" + n)));
        }
        return new Morphology(lang, kind, parts);
    }

    /// <summary><c>{{confix|en|in|spect}}</c> is "in- + -spect"; with three parts the middle is a base.</summary>
    private static List<string> Confix(List<string> args) => args.Count switch
    {
        1 => [Hyphenate(args[0], prefix: true)],
        2 => [Hyphenate(args[0], prefix: true), Hyphenate(args[1], prefix: false)],
        _ => [Hyphenate(args[0], prefix: true), .. args.Skip(1).Take(args.Count - 2), Hyphenate(args[^1], prefix: false)],
    };

    /// <summary>Adds the affix hyphen, keeping a reconstruction's asterisk in front (<c>*tḗr</c> → <c>*-tḗr</c>).</summary>
    private static string Hyphenate(string raw, bool prefix)
    {
        var lt = raw.IndexOf('<');
        var head = (lt >= 0 ? raw[..lt] : raw).Trim();
        var tail = lt >= 0 ? raw[lt..] : "";
        var star = head.StartsWith('*') ? "*" : "";
        var body = head[star.Length..];
        if (prefix && !body.EndsWith('-'))
            body += "-";
        else if (!prefix && !body.StartsWith('-'))
            body = "-" + body;
        return star + body + tail;
    }
}
