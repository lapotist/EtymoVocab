using System.Text.RegularExpressions;

namespace EtymoVocab.Core.Wikitext;

public sealed record Heading(int Level, string Title, int Start, int ContentStart);

public static partial class WikiSections
{
    public static IReadOnlyList<Heading> Headings(string text) =>
        HeadingRegex().Matches(text)
            .Select(m => new Heading(m.Groups[1].Length, m.Groups[2].Value.Trim(), m.Index, m.Index + m.Length))
            .ToList();

    /// <summary>Body of the level-2 section titled <paramref name="languageName"/> (e.g. "English"), or null.</summary>
    public static string? LanguageSection(string pageText, string languageName)
    {
        var headings = Headings(pageText);
        for (var k = 0; k < headings.Count; k++)
        {
            var h = headings[k];
            if (h.Level != 2 || !string.Equals(h.Title, languageName, StringComparison.Ordinal))
                continue;
            var end = pageText.Length;
            for (var n = k + 1; n < headings.Count; n++)
            {
                if (headings[n].Level <= 2)
                {
                    end = headings[n].Start;
                    break;
                }
            }
            return pageText[h.ContentStart..end];
        }
        return null;
    }

    /// <summary>Text between a heading and the next heading of any level.</summary>
    public static string OwnText(string text, IReadOnlyList<Heading> headings, int index)
    {
        var h = headings[index];
        var end = index + 1 < headings.Count ? headings[index + 1].Start : text.Length;
        return text[h.ContentStart..end];
    }

    /// <summary>Text from a heading to the next heading of the same or a higher level (includes subsections).</summary>
    public static string BlockText(string text, IReadOnlyList<Heading> headings, int index)
    {
        var h = headings[index];
        var end = text.Length;
        for (var n = index + 1; n < headings.Count; n++)
        {
            if (headings[n].Level <= h.Level)
            {
                end = headings[n].Start;
                break;
            }
        }
        return text[h.ContentStart..end];
    }

    [GeneratedRegex(@"^(={1,6})\s*([^=].*?)\s*\1\s*$", RegexOptions.Multiline)]
    private static partial Regex HeadingRegex();
}
