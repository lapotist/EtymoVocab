namespace EtymoVocab.Core.Lookup;

/// <summary>One ordered lexical-discovery outcome; one missing word does not discard its siblings.</summary>
public sealed record RelatedLookupItem(string Word, WordResult? Data, RelatedLookupError? Error);

public sealed record RelatedLookupError(int Status, string Title, string? Detail, int? RetryAfter)
{
    public static RelatedLookupError FromUpstream(UpstreamUnavailableException error) =>
        new(error.RateLimited ? 429 : 503, "Wiktionary 暫時無法使用", error.Message,
            error.RetryAfter is { } wait ? (int)Math.Clamp(Math.Ceiling(wait.TotalSeconds), 0, int.MaxValue) : null);
}

/// <param name="Complete">False when some ancestor data could not be fetched; such results are not cached.</param>
/// <param name="Word">The page title (Latin entries drop macrons: <c>specio</c> for <c>speciō</c>).</param>
public sealed record WordResult(
    string Word,
    string Lang,
    string LangName,
    SourceInfo Source,
    IReadOnlyList<EtymologyResult> Etymologies,
    IReadOnlyList<string> Warnings,
    bool Complete)
{
    /// <summary>The original page title when an unambiguous inflected entry resolved to a lemma.</summary>
    public string? ResolvedFrom { get; init; }

    public RelatedLookupError? UpstreamError { get; init; }

    /// <summary>Explicit base forms offered when the entry has its own meanings or multiple possible lemmas.</summary>
    public IReadOnlyList<string> BaseForms { get; init; } = [];
}

public sealed record SourceInfo(string Title, long RevisionId, DateTimeOffset RevisionTimestamp, string Url, string License);

public sealed record EtymologyResult(
    int Number,
    string? Id,
    string Text,
    bool Uncertain,
    IReadOnlyList<StepResult> Steps,
    IReadOnlyList<MorphologyResult> Morphology,
    IReadOnlyList<RootResult> Roots,
    IReadOnlyList<TermResult> Doublets,
    IReadOnlyList<PartOfSpeechResult> PartsOfSpeech)
{
    public IReadOnlyList<EtymologicalRelationResult> EtymologicalRelations { get; init; } = [];
    /// <summary>Resolved, sense-qualified identities suitable for comparing documented origins.</summary>
    public IReadOnlyList<OriginAnchorResult> OriginAnchors { get; init; } = [];
}

public sealed record EtymologicalRelationResult(
    string Kind, string Lang, string Term, string? Url, string SourceUrl, string SourceSection);

/// <param name="Kind">self, ancestor, root, or component; shared components do not imply shared ancestry.</param>
/// <param name="Key">JSON [entry language, resolved page title, etymon id or null for a sole etymology].</param>
/// <param name="SourceUrl">Pinned revision establishing the anchor's identity; the word result supplies the relationship source.</param>
public sealed record OriginAnchorResult(
    string Key, string Kind, string Lang, string Term, string Title, string? EtymonId, string? Url, string SourceUrl)
{
    public IReadOnlyList<string> LookupAliases { get; init; } = [];
}

/// <summary>An ancestor, newest first. <see cref="Relation"/> says how the previous (newer) form came from it.</summary>
/// <param name="GlossSource">"etymology" when stated in the etymology text, "definition" when read from the ancestor's own entry.</param>
/// <param name="Ambiguous">The ancestor page has several etymologies and none was identified explicitly.</param>
public sealed record StepResult(
    string Lang,
    string LangName,
    string Term,
    string Display,
    string? Gloss,
    string? GlossSource,
    string Relation,
    string? Note,
    bool Uncertain,
    bool Ambiguous,
    string? Url,
    IReadOnlyList<MorphologyResult> Morphology)
{
    /// <summary>The etymon sense id (e.g. "fare" for PIE *per-), which selects sense-specific root categories.</summary>
    public string? Id { get; init; }
    public string? EtymonId => Id;
    public bool Transitive { get; init; } = true;

    /// <summary>The resolved ancestor describes its own earlier history as uncertain.</summary>
    public bool AncestryUncertain { get; init; }
}

public sealed record MorphologyResult(string Lang, string LangName, string Kind, IReadOnlyList<PartResult> Parts);

/// <param name="Hint">The editor-assigned sense id (e.g. "carry"); shown when no gloss is available.</param>
public sealed record PartResult(string Term, string? Gloss, string? Hint, string? Url, string Lang, string LangName);

public sealed record RootResult(string Lang, string LangName, string Root, string? Gloss, string? Url)
{
    /// <summary>The root's sense id from <c>{{root|…|*per-&lt;id:fare&gt;}}</c>, when the entry gives one.</summary>
    public string? Id { get; init; }
}

public sealed record TermResult(string Lang, string Term, string? Url);

public sealed record PartOfSpeechResult(string Pos, IReadOnlyList<string> Senses, IReadOnlyList<TranslationResult> Translations)
{
    public IReadOnlyList<RelationResult> Relations { get; init; } = [];
}

public sealed record RelationResult(string Kind, string Sense, IReadOnlyList<string> Terms)
{
    public IReadOnlyList<string> ThesaurusTargets { get; init; } = [];
}

public sealed record TranslationResult(string Sense, IReadOnlyList<string> Mandarin);

public sealed record RootFamilyResult(
    string Lang,
    string LangName,
    string Root,
    string? Gloss,
    string? RootUrl,
    string Category,
    string CategoryUrl,
    int? Total,
    IReadOnlyList<string> Members)
{
    /// <summary>
    /// True when Wiktionary splits this form into several senses (in- "not" / "into") and the entry does not say
    /// which one applies: the plain category mixes different morphemes, so <see cref="Members"/> is empty.
    /// </summary>
    public bool Ambiguous { get; init; }

    /// <summary>The sense-specific categories to choose from when <see cref="Ambiguous"/>, largest first.</summary>
    public IReadOnlyList<FamilySense> Senses { get; init; } = [];
    public RelatedLookupError? UpstreamError { get; init; }
}

public sealed record FamilySense(string Id, int Size, string Category);
