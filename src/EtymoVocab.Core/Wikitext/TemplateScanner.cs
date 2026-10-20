using System.Text;

namespace EtymoVocab.Core.Wikitext;

/// <summary>
/// Finds top-level template calls in wikitext. Nested templates and links inside arguments
/// are kept verbatim in the argument text; callers parse them again when needed.
/// </summary>
public static class TemplateScanner
{
    public static IReadOnlyList<WikiTemplate> Scan(string text)
    {
        var result = new List<WikiTemplate>();
        var i = 0;
        while (i < text.Length - 1)
        {
            if (text[i] == '{' && text[i + 1] == '{')
            {
                var close = FindClose(text, i);
                if (close < 0)
                    break; // unbalanced braces: nothing reliable after this point
                result.Add(Parse(text.Substring(i + 2, close - i - 2), i, close + 2));
                i = close + 2;
            }
            else
            {
                i++;
            }
        }
        return result;
    }

    /// <summary>Returns the index of the <c>}}</c> closing the template opened at <paramref name="open"/>, or -1.</summary>
    private static int FindClose(string text, int open)
    {
        var depth = 0;
        for (var j = open; j < text.Length - 1; j++)
        {
            if (text[j] == '{' && text[j + 1] == '{')
            {
                depth++;
                j++;
            }
            else if (text[j] == '}' && text[j + 1] == '}')
            {
                depth--;
                if (depth == 0)
                    return j;
                j++;
            }
        }
        return -1;
    }

    private static WikiTemplate Parse(string inner, int start, int end)
    {
        var parts = SplitTopLevel(inner, '|');
        var name = NormalizeName(parts[0]);
        var positional = new List<string>();
        var named = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var part in parts.Skip(1))
        {
            var eq = IndexOfTopLevel(part, '=');
            if (eq > 0 && IsParamName(part.AsSpan(0, eq)))
                named[part[..eq].Trim()] = part[(eq + 1)..].Trim();
            else
                positional.Add(part);
        }

        // Explicitly numbered arguments ("2=foo") override implicit positions, as in MediaWiki.
        foreach (var key in named.Keys.Where(k => k.All(char.IsAsciiDigit)).ToList())
        {
            var index = int.Parse(key);
            if (index is < 1 or > 100)
                continue;
            while (positional.Count < index)
                positional.Add("");
            positional[index - 1] = named[key];
            named.Remove(key);
        }

        return new WikiTemplate(name, positional, named, start, end);
    }

    /// <summary>Splits on <paramref name="separator"/> outside nested templates and links.</summary>
    public static List<string> SplitTopLevel(string text, char separator)
    {
        var parts = new List<string>();
        var current = new StringBuilder();
        var braces = 0;
        var brackets = 0;
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            var next = i + 1 < text.Length ? text[i + 1] : '\0';
            if (c == '{' && next == '{') { braces++; current.Append("{{"); i++; continue; }
            if (c == '}' && next == '}' && braces > 0) { braces--; current.Append("}}"); i++; continue; }
            if (c == '[' && next == '[') { brackets++; current.Append("[["); i++; continue; }
            if (c == ']' && next == ']' && brackets > 0) { brackets--; current.Append("]]"); i++; continue; }
            if (c == separator && braces == 0 && brackets == 0)
            {
                parts.Add(current.ToString());
                current.Clear();
                continue;
            }
            current.Append(c);
        }
        parts.Add(current.ToString());
        return parts;
    }

    private static int IndexOfTopLevel(string text, char target)
    {
        var braces = 0;
        var brackets = 0;
        var angles = 0;
        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];
            var next = i + 1 < text.Length ? text[i + 1] : '\0';
            if (c == '{' && next == '{') { braces++; i++; continue; }
            if (c == '}' && next == '}' && braces > 0) { braces--; i++; continue; }
            if (c == '[' && next == '[') { brackets++; i++; continue; }
            if (c == ']' && next == ']' && brackets > 0) { brackets--; i++; continue; }
            if (c == '<') { angles++; continue; }
            if (c == '>' && angles > 0) { angles--; continue; }
            if (c == target && braces == 0 && brackets == 0 && angles == 0)
                return i;
        }
        return -1;
    }

    private static bool IsParamName(ReadOnlySpan<char> name)
    {
        var trimmed = name.Trim();
        if (trimmed.IsEmpty)
            return false;
        foreach (var c in trimmed)
        {
            if (!char.IsLetterOrDigit(c) && c is not ' ' and not '_' and not '-')
                return false;
        }
        return true;
    }

    /// <summary>MediaWiki template names ignore first-letter case and treat '_' as ' '.</summary>
    private static string NormalizeName(string raw)
    {
        var name = raw.Trim().Replace('_', ' ');
        if (name.StartsWith("Template:", StringComparison.OrdinalIgnoreCase))
            name = name["Template:".Length..];
        name = string.Join(' ', name.Split(' ', StringSplitOptions.RemoveEmptyEntries));
        return name.Length == 0 ? name : char.ToLowerInvariant(name[0]) + name[1..];
    }
}
