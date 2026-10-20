using System.Collections.Concurrent;
using System.Text.RegularExpressions;

namespace EtymoVocab.Core.Languages;

/// <summary>
/// Wiktionary language codes → canonical names (the level-2 heading under which entries live).
/// Starts from a curated core so lookups work immediately; <see cref="Merge"/> adds Wiktionary's
/// full live tables (Module:languages / Module:etymology languages) when they have been fetched.
/// </summary>
public sealed partial class LanguageRegistry
{
    public const string LanguagesModule = "Module:languages/code to canonical name";
    public const string EtymologyLanguagesModule = "Module:etymology languages/code to canonical name";

    private static readonly Dictionary<string, string> CoreLanguages = new()
    {
        ["en"] = "English", ["enm"] = "Middle English", ["ang"] = "Old English", ["sco"] = "Scots",
        ["fr"] = "French", ["frm"] = "Middle French", ["fro"] = "Old French", ["xno"] = "Anglo-Norman",
        ["pro"] = "Old Occitan", ["oc"] = "Occitan", ["ca"] = "Catalan", ["es"] = "Spanish",
        ["pt"] = "Portuguese", ["it"] = "Italian", ["ro"] = "Romanian",
        ["la"] = "Latin", ["grc"] = "Ancient Greek", ["el"] = "Greek", ["gkm"] = "Byzantine Greek",
        ["ine-pro"] = "Proto-Indo-European", ["gem-pro"] = "Proto-Germanic", ["gmw-pro"] = "Proto-West Germanic",
        ["itc-pro"] = "Proto-Italic", ["cel-pro"] = "Proto-Celtic", ["grk-pro"] = "Proto-Hellenic",
        ["sla-pro"] = "Proto-Slavic", ["iir-pro"] = "Proto-Indo-Iranian", ["sem-pro"] = "Proto-Semitic",
        ["non"] = "Old Norse", ["frk"] = "Frankish", ["lng"] = "Lombardic", ["goh"] = "Old High German",
        ["gmh"] = "Middle High German", ["de"] = "German", ["nl"] = "Dutch", ["dum"] = "Middle Dutch",
        ["odt"] = "Old Dutch", ["osx"] = "Old Saxon", ["ofs"] = "Old Frisian", ["got"] = "Gothic",
        ["da"] = "Danish", ["sv"] = "Swedish", ["no"] = "Norwegian", ["is"] = "Icelandic", ["fy"] = "West Frisian",
        ["ar"] = "Arabic", ["fa"] = "Persian", ["sa"] = "Sanskrit", ["hi"] = "Hindi", ["he"] = "Hebrew",
        ["tr"] = "Turkish", ["ota"] = "Ottoman Turkish", ["ja"] = "Japanese", ["zh"] = "Chinese",
        ["cmn"] = "Mandarin", ["yue"] = "Cantonese", ["ru"] = "Russian", ["pl"] = "Polish", ["cs"] = "Czech",
        ["sga"] = "Old Irish", ["ga"] = "Irish", ["gd"] = "Scottish Gaelic", ["cy"] = "Welsh", ["br"] = "Breton",
    };

    /// <summary>Etymology-only varieties: they have no own heading; entries live under the parent language.</summary>
    private static readonly Dictionary<string, (string Name, string Parent)> CoreEtymologyOnly = new()
    {
        ["la-lat"] = ("Late Latin", "la"), ["la-med"] = ("Medieval Latin", "la"), ["la-new"] = ("New Latin", "la"),
        ["la-vul"] = ("Vulgar Latin", "la"), ["la-cla"] = ("Classical Latin", "la"),
        ["la-ecc"] = ("Ecclesiastical Latin", "la"), ["la-ren"] = ("Renaissance Latin", "la"),
        ["grc-koi"] = ("Koine Greek", "grc"), ["grc-att"] = ("Attic Greek", "grc"), ["grc-ion"] = ("Ionic Greek", "grc"),
        ["grc-dor"] = ("Doric Greek", "grc"), ["grc-aeo"] = ("Aeolic Greek", "grc"),
    };

    /// <summary>Language families: displayable, but there are no entries to fetch.</summary>
    private static readonly Dictionary<string, string> Families = new()
    {
        ["gem"] = "Germanic", ["ine"] = "Indo-European", ["itc"] = "Italic", ["roa"] = "Romance",
        ["gmw"] = "West Germanic", ["gmq"] = "North Germanic", ["cel"] = "Celtic", ["sla"] = "Slavic",
        ["grk"] = "Hellenic", ["sem"] = "Semitic", ["iir"] = "Indo-Iranian", ["inc"] = "Indo-Aryan", ["ira"] = "Iranian",
    };

    private readonly ConcurrentDictionary<string, string> _languages = new(CoreLanguages);
    private readonly ConcurrentDictionary<string, string> _etymologyOnlyNames =
        new(CoreEtymologyOnly.ToDictionary(kv => kv.Key, kv => kv.Value.Name));

    public bool HasLiveData { get; private set; }

    public string NameOf(string code) =>
        _languages.TryGetValue(code, out var name) ? name
        : _etymologyOnlyNames.TryGetValue(code, out var etyName) ? etyName
        : Families.TryGetValue(code, out var family) ? family
        : code;

    /// <summary>The language whose heading holds entries for <paramref name="code"/>, or null if unknown.</summary>
    public string? EntryLanguageOf(string code)
    {
        if (CoreEtymologyOnly.TryGetValue(code, out var ety))
            return ety.Parent;
        return _languages.ContainsKey(code) ? code : null;
    }

    /// <summary>The level-2 heading to look for on a page, or null when entries cannot be located.</summary>
    public string? SectionNameOf(string code) =>
        EntryLanguageOf(code) is { } entryLang && _languages.TryGetValue(entryLang, out var name) ? name : null;

    public void Merge(string? languagesModuleLua, string? etymologyLanguagesModuleLua)
    {
        if (languagesModuleLua is not null)
        {
            foreach (var (code, name) in ParseLuaNameTable(languagesModuleLua))
                _languages.TryAdd(code, name);
        }
        if (etymologyLanguagesModuleLua is not null)
        {
            foreach (var (code, name) in ParseLuaNameTable(etymologyLanguagesModuleLua))
                _etymologyOnlyNames.TryAdd(code, name);
        }
        HasLiveData = languagesModuleLua is not null;
    }

    public static IEnumerable<(string Code, string Name)> ParseLuaNameTable(string lua) =>
        LuaEntryRegex().Matches(lua).Select(m => (m.Groups[1].Value, Regex.Unescape(m.Groups[2].Value)));

    [GeneratedRegex(@"\[""([^""]+)""\]\s*=\s*""((?:[^""\\]|\\.)*)""")]
    private static partial Regex LuaEntryRegex();
}
