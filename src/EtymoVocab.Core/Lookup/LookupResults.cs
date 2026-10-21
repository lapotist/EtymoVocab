namespace EtymoVocab.Core.Lookup;

/// <param name="Complete">False when some ancestor data could not be fetched; such results are not cached.</param>
/// <param name="Word">The page title (Latin entries drop macrons: <c>specio</c> for <c>speciō</c>).</param>
public sealed record WordResult(
    string Word,
    string Lang,
    string LangName,
    SourceInfo Source,
    IReadOnlyList<EtymologyResult> Etymologies,
    IReadOnlyList<string> Warnings,
    bool Complete);

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
    IReadOnlyList<PartOfSpeechResult> PartsOfSpeech);

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
    IReadOnlyList<MorphologyResult> Morphology);

public sealed record MorphologyResult(string Lang, string LangName, string Kind, IReadOnlyList<PartResult> Parts);

/// <param name="Hint">The editor-assigned sense id (e.g. "carry"); shown when no gloss is available.</param>
public sealed record PartResult(string Term, string? Gloss, string? Hint, string? Url);

public sealed record RootResult(string Lang, string LangName, string Root, string? Gloss, string? Url);

public sealed record TermResult(string Lang, string Term, string? Url);

public sealed record PartOfSpeechResult(string Pos, IReadOnlyList<string> Senses, IReadOnlyList<TranslationResult> Translations)
{
    public IReadOnlyList<RelationResult> Relations { get; init; } = [];
}

public sealed record RelationResult(string Kind, string Sense, IReadOnlyList<string> Terms);

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
    IReadOnlyList<string> Members);
