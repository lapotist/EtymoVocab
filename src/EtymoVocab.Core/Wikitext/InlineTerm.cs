using System.Text.RegularExpressions;

namespace EtymoVocab.Core.Wikitext;

/// <summary>
/// A term with Wiktionary inline modifiers, e.g. <c>enm:transporten&lt;ety:bor&lt;fro:transporter&gt;&gt;</c>
/// or <c>trāns-&lt;id:beyond&gt;&lt;t:across&gt;</c>. Modifiers may nest (<c>&lt;ety:…&gt;</c>).
/// </summary>
public sealed partial record InlineTerm(
    string? Lang,
    string Term,
    IReadOnlyDictionary<string, string> Modifiers,
    IReadOnlySet<string> Flags)
{
    public string? Mod(string key) =>
        Modifiers.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value) ? value.Trim() : null;

    /// <param name="allowLangPrefix">True in <c>{{etymon}}</c> arguments, where terms are written <c>lang:term</c>.</param>
    public static InlineTerm Parse(string raw, bool allowLangPrefix)
    {
        raw = raw.Trim();
        var lt = raw.IndexOf('<');
        var head = lt >= 0 ? raw[..lt] : raw;
        var modifiers = new Dictionary<string, string>(StringComparer.Ordinal);
        var flags = new HashSet<string>(StringComparer.Ordinal);

        if (lt >= 0)
        {
            foreach (var group in BracketGroups(raw, lt))
            {
                var colon = group.IndexOf(':');
                if (colon > 0 && KeyRegex().IsMatch(group[..colon]))
                    modifiers[group[..colon]] = group[(colon + 1)..];
                else
                    flags.Add(group.Trim());
            }
        }

        string? lang = null;
        if (allowLangPrefix)
        {
            var match = LangPrefixRegex().Match(head);
            if (match.Success)
            {
                lang = match.Groups[1].Value;
                head = match.Groups[2].Value;
            }
        }

        return new InlineTerm(lang, head.Trim(), modifiers, flags);
    }

    /// <summary>
    /// Parses the value of an <c>&lt;ety:…&gt;</c> modifier: a derivation keyword followed by
    /// bracketed etymons, e.g. <c>bor&lt;fro:transporter&gt;</c>.
    /// </summary>
    public static (string Keyword, IReadOnlySet<string> Flags, IReadOnlyList<InlineTerm> Terms) ParseEty(string value)
    {
        var lt = value.IndexOf('<');
        var keyword = (lt >= 0 ? value[..lt] : value).Trim().TrimStart(':');
        var flags = new HashSet<string>(StringComparer.Ordinal);
        var terms = new List<InlineTerm>();
        if (lt >= 0)
        {
            foreach (var group in BracketGroups(value, lt))
            {
                if (group.Contains(':'))
                    terms.Add(Parse(group, allowLangPrefix: true));
                else
                    flags.Add(group.Trim());
            }
        }
        return (keyword, flags, terms);
    }

    /// <summary>Yields the contents of consecutive top-level <c>&lt;…&gt;</c> groups starting at <paramref name="start"/>.</summary>
    private static IEnumerable<string> BracketGroups(string text, int start)
    {
        var i = start;
        while (i < text.Length)
        {
            if (text[i] != '<')
            {
                i++;
                continue;
            }
            var depth = 0;
            var j = i;
            for (; j < text.Length; j++)
            {
                if (text[j] == '<') depth++;
                else if (text[j] == '>' && --depth == 0) break;
            }
            if (j >= text.Length)
                yield break; // unbalanced
            yield return text.Substring(i + 1, j - i - 1);
            i = j + 1;
        }
    }

    [GeneratedRegex(@"^[A-Za-z]+$")]
    private static partial Regex KeyRegex();

    // Wiktionary codes: "en", "enm", "la-lat", "gem-pro", "ine-pro", "itc-pro" ...
    [GeneratedRegex(@"^([a-z]{2,3}(?:-[a-z]{2,5})*):(.+)$")]
    private static partial Regex LangPrefixRegex();
}
