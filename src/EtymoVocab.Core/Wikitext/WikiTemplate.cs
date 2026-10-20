namespace EtymoVocab.Core.Wikitext;

/// <summary>A parsed template call such as <c>{{inh|en|enm|fader}}</c>.</summary>
/// <param name="Start">Offset of the opening <c>{{</c> in the scanned text.</param>
/// <param name="End">Offset just past the closing <c>}}</c>.</param>
public sealed record WikiTemplate(
    string Name,
    IReadOnlyList<string> Positional,
    IReadOnlyDictionary<string, string> Named,
    int Start,
    int End)
{
    /// <summary>1-based positional argument; null when absent or blank.</summary>
    public string? Arg(int index) =>
        index >= 1 && index <= Positional.Count && !string.IsNullOrWhiteSpace(Positional[index - 1])
            ? Positional[index - 1].Trim()
            : null;

    /// <summary>Non-blank positional arguments from <paramref name="fromIndex"/> (1-based) onwards.</summary>
    public IEnumerable<string> ArgsFrom(int fromIndex) =>
        Positional.Skip(fromIndex - 1).Where(a => !string.IsNullOrWhiteSpace(a)).Select(a => a.Trim());

    /// <summary>First non-blank named parameter among <paramref name="names"/>.</summary>
    public string? Param(params string[] names)
    {
        foreach (var name in names)
        {
            if (Named.TryGetValue(name, out var value) && !string.IsNullOrWhiteSpace(value))
                return value.Trim();
        }
        return null;
    }
}
