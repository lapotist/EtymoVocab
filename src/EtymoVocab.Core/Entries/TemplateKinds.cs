namespace EtymoVocab.Core.Entries;

/// <summary>Wiktionary template and <c>{{etymon}}</c> keyword vocabularies.</summary>
public static class TemplateKinds
{
    /// <summary>Derivation templates: <c>{{inh|target|source|term|alt|gloss}}</c> and friends.</summary>
    private static readonly Dictionary<string, string> DerivationTemplates = new(StringComparer.Ordinal)
    {
        ["inh"] = "inh", ["inh+"] = "inh", ["inh-lite"] = "inh",
        ["der"] = "der", ["der+"] = "der", ["der-lite"] = "der",
        ["bor"] = "bor", ["bor+"] = "bor", ["bor-lite"] = "bor",
        ["lbor"] = "lbor", ["slbor"] = "slbor", ["obor"] = "obor", ["ubor"] = "ubor", ["uder"] = "uder",
        ["cal"] = "cal", ["calque"] = "cal", ["cal+"] = "cal", ["pcal"] = "pcal", ["sl"] = "sl",
    };

    /// <summary>Etymon keywords (<c>|:inh|</c>) to normalized relations.</summary>
    private static readonly Dictionary<string, string> EtymonChainKeywords = new(StringComparer.Ordinal)
    {
        ["inh"] = "inh", ["inherited"] = "inh", ["der"] = "der", ["derived"] = "der", ["from"] = "from",
        ["bor"] = "bor", ["borrowed"] = "bor", ["lbor"] = "lbor", ["slbor"] = "slbor", ["obor"] = "obor",
        ["ubor"] = "ubor", ["uder"] = "uder", ["cal"] = "cal", ["calque"] = "cal", ["clq"] = "cal",
        ["pcal"] = "pcal", ["pclq"] = "pcal", ["sl"] = "sl", ["influence"] = "influence",
        ["clip"] = "clip", ["abbr"] = "abbr", ["acro"] = "abbr", ["init"] = "abbr", ["ellip"] = "ellip",
        ["bf"] = "bf", ["apheretic"] = "apheretic", ["denom"] = "der", ["deverbal"] = "der",
        ["univ"] = "der", ["translit"] = "translit", ["meta"] = "der",
    };

    private static readonly HashSet<string> EtymonMorphologyKeywords = new(StringComparer.Ordinal)
    {
        "af", "afeq", "blend", "rdp", "redup", "com", "compound",
    };

    private static readonly HashSet<string> NonTransitiveRelations = new(StringComparer.Ordinal)
    {
        "cal", "pcal", "sl", "influence",
    };

    private static readonly HashSet<string> MentionTemplates = new(StringComparer.Ordinal)
    {
        "m", "m+", "mention", "l", "link", "ll", "l-lite", "m-lite",
    };

    private static readonly HashSet<string> AffixTemplates = new(StringComparer.Ordinal)
    {
        "af", "affix", "compound", "com", "surf", "blend", "prefix", "pre", "suffix", "suf", "confix", "con",
    };

    public static readonly HashSet<string> TranslationTemplates = new(StringComparer.Ordinal)
    {
        "t", "t+", "t-", "tt", "tt+", "t+check", "t-check", "t-simple",
    };

    public static string? DerivationRelation(string templateName) =>
        DerivationTemplates.GetValueOrDefault(templateName);

    public static string? EtymonChainRelation(string keyword) => EtymonChainKeywords.GetValueOrDefault(keyword);

    public static bool IsEtymonMorphology(string keyword) => EtymonMorphologyKeywords.Contains(keyword);

    public static bool IsTransitive(string relation) => !NonTransitiveRelations.Contains(relation);

    public static bool IsMention(string templateName) => MentionTemplates.Contains(templateName);

    public static bool IsAffix(string templateName) => AffixTemplates.Contains(templateName);

    public static bool IsEtymon(string templateName) => templateName is "etymon" or "ety";

    public static bool IsDoublet(string templateName) => templateName is "doublet" or "dbt";

    public static bool IsUncertainMarker(string templateName) =>
        templateName is "unk" or "unknown" or "unc" or "uncertain";
}
