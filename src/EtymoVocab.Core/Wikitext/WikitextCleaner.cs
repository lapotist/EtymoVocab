using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace EtymoVocab.Core.Wikitext;

public static partial class WikitextCleaner
{
    /// <summary>Removes comments and footnotes, whose templates must not be read as etymology.</summary>
    public static string StripNoise(string text)
    {
        text = CommentRegex().Replace(text, "");
        text = SelfClosingRefRegex().Replace(text, "");
        return RefRegex().Replace(text, "");
    }

    /// <summary>Renders <c>[[target|label]]</c> as its label and drops file/category links.</summary>
    public static string RenderLinks(string text)
    {
        if (!text.Contains("[["))
            return ExternalLinkRegex().Replace(text, "$2");

        var sb = new StringBuilder(text.Length);
        var i = 0;
        while (i < text.Length)
        {
            if (i < text.Length - 1 && text[i] == '[' && text[i + 1] == '[')
            {
                var close = FindLinkClose(text, i);
                if (close < 0)
                {
                    sb.Append(text, i, text.Length - i);
                    break;
                }
                sb.Append(RenderLinkInner(text.Substring(i + 2, close - i - 2)));
                i = close + 2;
            }
            else
            {
                sb.Append(text[i++]);
            }
        }
        return ExternalLinkRegex().Replace(sb.ToString(), "$2");
    }

    /// <summary>Final pass: strip bold/italic quotes and HTML tags, decode entities, collapse whitespace.</summary>
    public static string Finish(string text)
    {
        text = text.Replace("'''", "").Replace("''", "");
        text = HtmlTagRegex().Replace(text, "");
        text = WebUtility.HtmlDecode(text);
        text = WhitespaceRegex().Replace(text, " ");
        text = SpaceBeforePunctuationRegex().Replace(text, "$1");
        return text.Trim();
    }

    /// <summary>A bare term from a template argument: no inline modifiers, links rendered.</summary>
    public static string PlainTerm(string raw)
    {
        var lt = raw.IndexOf('<');
        var head = lt >= 0 ? raw[..lt] : raw;
        return Finish(RenderLinks(head));
    }

    private static int FindLinkClose(string text, int open)
    {
        var depth = 0;
        for (var j = open; j < text.Length - 1; j++)
        {
            if (text[j] == '[' && text[j + 1] == '[') { depth++; j++; }
            else if (text[j] == ']' && text[j + 1] == ']')
            {
                if (--depth == 0)
                    return j;
                j++;
            }
        }
        return -1;
    }

    private static string RenderLinkInner(string inner)
    {
        var target = inner.TrimStart(':');
        var colon = target.IndexOf(':');
        if (colon > 0)
        {
            var ns = target[..colon].Trim();
            if (ns.Equals("File", StringComparison.OrdinalIgnoreCase)
                || ns.Equals("Image", StringComparison.OrdinalIgnoreCase)
                || ns.Equals("Category", StringComparison.OrdinalIgnoreCase)
                || ns.Equals("Media", StringComparison.OrdinalIgnoreCase))
                return "";
        }

        var pipe = TemplateScanner.SplitTopLevel(inner, '|');
        if (pipe.Count > 1)
            return RenderLinks(pipe[^1]);

        var hash = inner.IndexOf('#');
        var label = hash >= 0 ? inner[..hash] : inner;
        if (label.Length == 0)
            label = inner[(hash + 1)..];
        return label.TrimStart(':');
    }

    [GeneratedRegex(@"<!--.*?-->", RegexOptions.Singleline)]
    private static partial Regex CommentRegex();

    [GeneratedRegex(@"<ref\b[^>]*/\s*>", RegexOptions.IgnoreCase)]
    private static partial Regex SelfClosingRefRegex();

    [GeneratedRegex(@"<ref\b[^>]*>.*?</ref\s*>", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex RefRegex();

    [GeneratedRegex(@"\[(https?://[^\s\]]+)\s+([^\]]+)\]")]
    private static partial Regex ExternalLinkRegex();

    [GeneratedRegex(@"</?[a-zA-Z][^>]*>")]
    private static partial Regex HtmlTagRegex();

    [GeneratedRegex(@"\s+")]
    private static partial Regex WhitespaceRegex();

    [GeneratedRegex(@"\s+([,.;:)])")]
    private static partial Regex SpaceBeforePunctuationRegex();
}
