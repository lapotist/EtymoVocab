using EtymoVocab.Core.Wikitext;

namespace EtymoVocab.Core.Entries;

/// <summary>One step back in a word's history, as stated on a single Wiktionary page.</summary>
/// <param name="Relation">Normalized relation: inh, bor, lbor, der, uder, from, cal, …</param>
/// <param name="Note">Connecting phrase from the prose, e.g. "past participle of".</param>
/// <param name="Transitive">False for calques and semantic loans: the source's own ancestors are not this word's.</param>
public sealed record EtymStep(
    string Lang,
    string Term,
    string? Display,
    string? Gloss,
    string Relation,
    string? Note,
    bool Uncertain,
    string? EtymonId,
    bool Transitive = true);

public sealed record MorphPart(string Lang, string Term, string? Gloss, string? EtymonId);

/// <param name="Kind">af, prefix, suffix, confix, compound, surf, blend, or plus (prose "A + B").</param>
public sealed record Morphology(string Lang, string Kind, IReadOnlyList<MorphPart> Parts)
{
    public string Signature =>
        Lang + "|" + string.Join("+", Parts.Select(p => WikitextCleaner.PlainTerm(p.Term).ToLowerInvariant()));

    public int GlossCount => Parts.Count(p => p.Gloss is not null);
}

public sealed record RootRef(string Lang, string Root, string? EtymonId);

public sealed record TermRef(string Lang, string Term);

public sealed record TranslationGroup(string Sense, IReadOnlyList<string> Terms);

public sealed record PartOfSpeech(string Pos, IReadOnlyList<string> Senses, IReadOnlyList<TranslationGroup> Translations);

/// <summary>An "Etymology N" block of one language section, with the parts of speech under it.</summary>
public sealed class EntrySection
{
    /// <summary>1-based; 0 when the entry has no etymology heading at all.</summary>
    public required int Number { get; init; }

    public string RawEtymology { get; init; } = "";
    public string? EtymonId { get; set; }
    public bool Uncertain { get; set; }
    public List<EtymStep> ProseSteps { get; } = [];
    public List<EtymStep> EtymonSteps { get; } = [];
    public List<Morphology> Morphology { get; } = [];
    public List<RootRef> Roots { get; } = [];
    public List<TermRef> Doublets { get; } = [];
    public List<PartOfSpeech> PartsOfSpeech { get; } = [];

    /// <summary>Prose templates usually spell out the longer chain; <c>{{etymon}}</c> gives the first hop only.</summary>
    public IReadOnlyList<EtymStep> Steps => ProseSteps.Count > 0 ? ProseSteps : EtymonSteps;

    public string? FirstSense => PartsOfSpeech.SelectMany(p => p.Senses).FirstOrDefault();

    public void AddMorphology(Morphology group)
    {
        if (group.Parts.Count == 0)
            return;
        var index = Morphology.FindIndex(m => m.Signature == group.Signature);
        if (index < 0)
            Morphology.Add(group);
        else if (group.GlossCount > Morphology[index].GlossCount)
            Morphology[index] = group;
    }
}
