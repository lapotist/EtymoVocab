using System.Text;
using EtymoVocab.Core.Languages;
using EtymoVocab.Core.Wikitext;

namespace EtymoVocab.Core.Entries;

/// <summary>
/// Renders the common etymology and definition templates to readable text. Templates it does not
/// know are dropped; the Wiktionary link on every result leads to the authoritative rendering.
/// </summary>
public static class PlainTextRenderer
{
    public static string Render(string wikitext, LanguageRegistry languages)
    {
        var text = WikitextCleaner.StripNoise(wikitext);
        var templates = TemplateScanner.Scan(text);
        var sb = new StringBuilder(text.Length);
        var prev = 0;
        foreach (var t in templates)
        {
            sb.Append(text, prev, t.Start - prev);
            sb.Append(RenderTemplate(t, languages));
            prev = t.End;
        }
        sb.Append(text, prev, text.Length - prev);
        return WikitextCleaner.Finish(WikitextCleaner.RenderLinks(sb.ToString()));
    }

    private static string RenderTemplate(WikiTemplate t, LanguageRegistry languages)
    {
        if (TemplateKinds.DerivationRelation(t.Name) is not null)
        {
            var prefix = t.Name switch
            {
                "inh+" => "Inherited from ",
                "bor+" => "Borrowed from ",
                "der+" => "Derived from ",
                "lbor" when t.Param("notext") is null => "Learned borrowing from ",
                "slbor" when t.Param("notext") is null => "Semi-learned borrowing from ",
                "obor" when t.Param("notext") is null => "Orthographic borrowing from ",
                "cal" or "calque" or "cal+" when t.Param("notext") is null => "Calque of ",
                "pcal" when t.Param("notext") is null => "Partial calque of ",
                "sl" when t.Param("notext") is null => "Semantic loan from ",
                _ => "",
            };
            return prefix + LangTerm(t.Arg(2), t.Arg(4) ?? t.Arg(3), t.Arg(5) ?? Gloss(t), languages);
        }

        if (TemplateKinds.IsMention(t.Name))
        {
            return t.Name == "m+"
                ? LangTerm(t.Arg(1), t.Arg(3) ?? t.Arg(2), t.Arg(4) ?? Gloss(t), languages)
                : Term(t.Arg(3) ?? t.Arg(2), t.Arg(4) ?? Gloss(t), languages);
        }

        if (TemplateKinds.IsAffix(t.Name))
        {
            var morphology = MorphologyReader.FromTemplate(t);
            if (morphology is null)
                return "";
            var joined = string.Join(" + ", morphology.Parts.Select(p => Term(p.Term, p.Gloss, languages)));
            return morphology.Kind == "surf" ? "By surface analysis, " + joined : joined;
        }

        if (TemplateKinds.IsDoublet(t.Name))
        {
            var terms = t.ArgsFrom(2).Select(a => WikitextCleaner.PlainTerm(a)).ToList();
            return terms.Count == 0 ? "" : (t.Param("notext") is null ? "Doublet of " : "") + JoinAnd(terms);
        }

        return t.Name switch
        {
            "cog" or "cognate" or "ncog" or "noncog" or "noncognate" =>
                LangTerm(t.Arg(1), t.Arg(3) ?? t.Arg(2), t.Arg(4) ?? Gloss(t), languages),
            "gloss" or "gl" => $"({Render(t.Arg(1) ?? "", languages)})",
            "q" or "qual" or "qualifier" or "i" or "qf" or "qq" => $"({string.Join(", ", t.ArgsFrom(1))})",
            "lb" or "lbl" or "label" => Label(t),
            "w" or "wikipedia" => t.Arg(2) ?? t.Arg(1) ?? "",
            "unk" or "unknown" => t.Param("title") ?? "Unknown",
            "unc" or "uncertain" => t.Param("title") ?? "Uncertain",
            "..." => "[…]",
            "smallcaps" or "sc" or "vern" or "taxlink" or "taxfmt" => t.Arg(1) ?? "",
            "non-gloss" or "ng" or "n-g" or "non-gloss definition" => Render(t.Arg(1) ?? "", languages),
            _ when t.Name.EndsWith(" of", StringComparison.Ordinal) && t.Arg(2) is { } target =>
                $"{t.Name} {WikitextCleaner.PlainTerm(target)}",
            _ => "", // includes {{etymon}}, {{root}}, quotations and maintenance templates
        };
    }

    /// <summary>Label words that qualify the next label instead of being comma-separated ("chiefly informal").</summary>
    private static readonly HashSet<string> LabelQualifiers = new(StringComparer.Ordinal)
    {
        "chiefly", "mostly", "usually", "often", "sometimes", "especially", "primarily", "now", "also", "originally",
    };

    private static string Label(WikiTemplate t)
    {
        var sb = new StringBuilder();
        foreach (var label in t.ArgsFrom(2))
        {
            if (label is "_" or "and" or "or")
            {
                sb.Append(label == "_" ? " " : $" {label} ");
                continue;
            }
            if (sb.Length > 0 && sb[^1] != ' ')
                sb.Append(", ");
            sb.Append(label);
            if (LabelQualifiers.Contains(label))
                sb.Append(' ');
        }
        var text = sb.ToString().Trim();
        return text.Length == 0 ? "" : $"({text})";
    }

    private static string? Gloss(WikiTemplate t) => t.Param("t", "gloss");

    private static string LangTerm(string? langCode, string? term, string? gloss, LanguageRegistry languages)
    {
        var name = langCode is null ? "" : languages.NameOf(langCode);
        var rendered = Term(term, gloss, languages);
        return rendered.Length == 0 ? name : $"{name} {rendered}".Trim();
    }

    private static string Term(string? term, string? gloss, LanguageRegistry languages)
    {
        var plain = term is null ? "" : WikitextCleaner.PlainTerm(term);
        if (plain == "-")
            plain = "";
        if (string.IsNullOrWhiteSpace(gloss))
            return plain;
        var renderedGloss = Render(gloss, languages);
        return plain.Length == 0 ? $"(“{renderedGloss}”)" : $"{plain} (“{renderedGloss}”)";
    }

    private static string JoinAnd(IReadOnlyList<string> items) => items.Count switch
    {
        0 => "",
        1 => items[0],
        _ => string.Join(", ", items.Take(items.Count - 1)) + " and " + items[^1],
    };
}
