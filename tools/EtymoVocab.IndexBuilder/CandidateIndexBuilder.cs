using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using EtymoVocab.Core.Entries;
using EtymoVocab.Core.Languages;
using EtymoVocab.Core.Wikitext;

namespace EtymoVocab.IndexBuilder;

public sealed record SourceMetadata(string Name, string Url, string DumpDate, string ExtractedAt, string License, string LicenseUrl, string Attribution)
{
    public string InputSha256 { get; init; } = "";
}

public sealed class IndexStatistics
{
    public long RecordsRead { get; set; }
    public long NonEnglishRecords { get; set; }
    public long InvalidWordRecords { get; set; }
    public long InflectionOnlyRecords { get; set; }
    public long RecordsWithoutTemplates { get; set; }
    public long RecordsWithCandidateEdges { get; set; }
    public long SupportedTemplates { get; set; }
    public long UnsupportedTemplates { get; set; }
    public long UnknownLanguageOrigins { get; set; }
    public long InvalidOrigins { get; set; }
    public long SelfOriginsIgnored { get; set; }
}

public sealed record ShardMetadata(string File, string Sha256, long Bytes);
public sealed record IndexManifest(int SchemaVersion, string BuildId, SourceMetadata Source, int EntryCount, int OriginCount, long EdgeCount,
    string Coverage, IndexStatistics Statistics, SortedDictionary<string, ShardMetadata> Shards);
public sealed record IndexShard(int SchemaVersion, SortedDictionary<string, string[]> Origins);

/// <summary>
/// Streams English Kaikki JSONL into a reverse discovery index. An index edge is only a reason to
/// inspect a candidate's current entry; it is never proof of common ancestry or matching homographs.
/// </summary>
public sealed class CandidateIndexBuilder
{
    public const int SchemaVersion = 1;
    private readonly LanguageRegistry _languages = new();
    private readonly Dictionary<string, HashSet<string>> _origins = new(StringComparer.Ordinal);
    private readonly HashSet<string> _words = new(StringComparer.Ordinal);
    public IndexStatistics Statistics { get; } = new();
    public IReadOnlyDictionary<string, HashSet<string>> Origins => _origins;
    public static JsonSerializerOptions JsonOptions { get; } = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public async Task<IndexManifest> BuildAsync(string inputPath, string outputDirectory, SourceMetadata source,
        Action<long>? progress = null, CancellationToken ct = default)
    {
        if (Statistics.RecordsRead != 0) throw new InvalidOperationException("Use a fresh builder for each input.");
        // Hash the original file, including gzip framing, so the exact downloadable artifact is identifiable.
        await using (var sourceFile = File.OpenRead(inputPath))
            source = source with { InputSha256 = Convert.ToHexStringLower(await SHA256.HashDataAsync(sourceFile, ct)) };
        await using (var file = File.OpenRead(inputPath))
        await using (Stream content = inputPath.EndsWith(".gz", StringComparison.OrdinalIgnoreCase)
            ? new GZipStream(file, CompressionMode.Decompress, leaveOpen: true) : file)
        using (var reader = new StreamReader(content, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, bufferSize: 65536))
        {
            while (await reader.ReadLineAsync(ct) is { } line)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                using var document = JsonDocument.Parse(line);
                AddRecord(document.RootElement);
                if (Statistics.RecordsRead % 100000 == 0) progress?.Invoke(Statistics.RecordsRead);
            }
        }
        if (_origins.Count == 0) throw new InvalidDataException("No candidate edges found; no manifest was written.");
        return await WriteAsync(outputDirectory, source, ct);
    }

    public void AddRecord(JsonElement record)
    {
        Statistics.RecordsRead++;
        if (Text(record, "lang_code") != "en") { Statistics.NonEnglishRecords++; return; }
        var word = Text(record, "word")?.Normalize(NormalizationForm.FormC);
        if (!ValidTerm(word)) { Statistics.InvalidWordRecords++; return; }
        if (OnlyInflections(record)) { Statistics.InflectionOnlyRecords++; return; }
        if (!record.TryGetProperty("etymology_templates", out var templates) || templates.ValueKind != JsonValueKind.Array || templates.GetArrayLength() == 0)
        { Statistics.RecordsWithoutTemplates++; return; }
        var recordKeys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var data in templates.EnumerateArray())
        {
            var template = ReadTemplate(data);
            if (template is null) { Statistics.UnsupportedTemplates++; continue; }
            var relation = TemplateKinds.DerivationRelation(template.Name);
            if (relation is not null && TemplateKinds.IsTransitive(relation))
            {
                Statistics.SupportedTemplates++;
                AddOrigin(template.Arg(2), template.Arg(3), word!, recordKeys);
            }
            else if (template.Name == "root")
            {
                Statistics.SupportedTemplates++;
                foreach (var root in template.ArgsFrom(3)) AddOrigin(template.Arg(2), root, word!, recordKeys);
            }
            else if (TemplateKinds.IsAffix(template.Name))
            {
                Statistics.SupportedTemplates++;
                if (MorphologyReader.FromTemplate(template) is { } morphology)
                    foreach (var part in morphology.Parts) AddOrigin(part.Lang, part.Term, word!, recordKeys);
            }
            else if (TemplateKinds.IsEtymon(template.Name))
            {
                Statistics.SupportedTemplates++;
                // Parse each explicit etymon independently. Adjacent extracted templates must never
                // become an invented prose chain once the original connectors have been discarded.
                var parsed = EntryParser.Parse("===Etymology===\n" + Wikitext(template), "en", _languages).Single();
                foreach (var step in parsed.Steps.TakeWhile(step => step.Transitive && !step.Uncertain))
                    AddOrigin(step.Lang, step.Term, word!, recordKeys);
                foreach (var root in parsed.Roots) AddOrigin(root.Lang, root.Root, word!, recordKeys);
                foreach (var part in parsed.Morphology.SelectMany(morphology => morphology.Parts))
                    AddOrigin(part.Lang, part.Term, word!, recordKeys);
            }
            else Statistics.UnsupportedTemplates++;
        }
        if (recordKeys.Count == 0) return;
        Statistics.RecordsWithCandidateEdges++;
        _words.Add(word!);
        foreach (var key in recordKeys)
        {
            if (!_origins.TryGetValue(key, out var members)) _origins[key] = members = new(StringComparer.Ordinal);
            members.Add(word!);
        }
    }

    private void AddOrigin(string? lang, string? rawTerm, string word, HashSet<string> keys)
    {
        if (lang is null || _languages.EntryLanguageOf(lang) is not { } entryLang)
        { Statistics.UnknownLanguageOrigins++; return; }
        if (rawTerm is null) { Statistics.InvalidOrigins++; return; }
        var term = InlineTerm.Parse(rawTerm, allowLangPrefix: false).Term;
        if (!ValidTerm(term)) { Statistics.InvalidOrigins++; return; }
        var title = EntryNames.PageTitle(_languages, lang, term)?.Normalize(NormalizationForm.FormC);
        if (title is null || title.Contains("{{") || title.Contains('[') || title.Contains(']') || title.Contains('#') || title.Contains('|'))
        { Statistics.InvalidOrigins++; return; }
        if (entryLang == "en" && title == word) { Statistics.SelfOriginsIgnored++; return; }
        keys.Add(OriginKey(entryLang, title));
    }

    private async Task<IndexManifest> WriteAsync(string directory, SourceMetadata source, CancellationToken ct)
    {
        var shards = Enumerable.Range(0, 256).Select(_ => new SortedDictionary<string, string[]>(StringComparer.Ordinal)).ToArray();
        foreach (var (key, words) in _origins) shards[ShardByte(key)][key] = words.Order(StringComparer.Ordinal).ToArray();
        Directory.CreateDirectory(directory);
        var metadata = new SortedDictionary<string, ShardMetadata>(StringComparer.Ordinal);
        foreach (var (origins, shard) in shards.Select((value, index) => (value, index)))
        {
            ct.ThrowIfCancellationRequested();
            var bytes = JsonSerializer.SerializeToUtf8Bytes(new IndexShard(SchemaVersion, origins), JsonOptions);
            var hash = Convert.ToHexStringLower(SHA256.HashData(bytes));
            var file = $"{shard:x2}-{hash}.json";
            var path = Path.Combine(directory, file);
            if (!File.Exists(path) || !(await File.ReadAllBytesAsync(path, ct)).AsSpan().SequenceEqual(bytes))
                await PublishFileAsync(path, bytes, ct);
            metadata[shard.ToString("x2")] = new(file, hash, bytes.Length);
        }
        var buildIdentity = JsonSerializer.SerializeToUtf8Bytes(new { schemaVersion = SchemaVersion, source, statistics = Statistics, shards = metadata }, JsonOptions);
        var manifest = new IndexManifest(SchemaVersion, Convert.ToHexStringLower(SHA256.HashData(buildIdentity)), source,
            _words.Count, _origins.Count, _origins.Values.Sum(words => (long)words.Count),
            "English headwords with supported explicit etymology templates. Candidate lookup only; each relationship requires current-entry verification. No transitive closure, semantic links, free-prose links, or complete-coverage claim.",
            Statistics, metadata);
        // Publish the manifest last. Existing readers keep using the content-addressed files they loaded.
        await PublishFileAsync(Path.Combine(directory, "manifest.json"), JsonSerializer.SerializeToUtf8Bytes(manifest, JsonOptions), ct);
        return manifest;
    }

    private static async Task PublishFileAsync(string path, byte[] bytes, CancellationToken ct)
    {
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            await File.WriteAllBytesAsync(temporary, bytes, ct);
            ct.ThrowIfCancellationRequested();
            File.Move(temporary, path, overwrite: true);
        }
        finally
        {
            File.Delete(temporary);
        }
    }

    public static byte ShardByte(string key)
    {
        uint hash = 2166136261;
        foreach (var value in Encoding.UTF8.GetBytes(key)) hash = unchecked((hash ^ value) * 16777619);
        return (byte)hash;
    }

    // JSON.stringify([lang,title]) compatibility, including supplementary Unicode and U+2028.
    // System.Text.Json's encoder may escape additional Unicode scalars, changing the hash input.
    public static string OriginKey(string lang, string title) => "[" + JsString(lang) + "," + JsString(title) + "]";
    private static string JsString(string value)
    {
        var output = new StringBuilder("\"");
        foreach (var c in value)
        {
            output.Append(c switch
            {
                '"' => "\\\"", '\\' => "\\\\", '\b' => "\\b", '\f' => "\\f", '\n' => "\\n", '\r' => "\\r", '\t' => "\\t",
                < ' ' => "\\u" + ((int)c).ToString("x4"), _ => c.ToString(),
            });
        }
        return output.Append('"').ToString();
    }

    private static WikiTemplate? ReadTemplate(JsonElement data)
    {
        var name = Text(data, "name");
        if (name is null || !data.TryGetProperty("args", out var args) || args.ValueKind != JsonValueKind.Object) return null;
        var positions = new SortedDictionary<int, string>();
        var named = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var argument in args.EnumerateObject())
        {
            if (argument.Value.ValueKind != JsonValueKind.String) continue;
            if (int.TryParse(argument.Name, out var index) && index is > 0 and <= 128) positions[index] = argument.Value.GetString()!;
            else named[argument.Name] = argument.Value.GetString()!;
        }
        var positional = positions.Count == 0 ? [] : Enumerable.Range(1, positions.Keys.Max()).Select(i => positions.GetValueOrDefault(i, "")).ToArray();
        return new WikiTemplate(name.Trim(), positional, named, 0, 0);
    }

    private static string Wikitext(WikiTemplate template)
    {
        var text = new StringBuilder("{{").Append(template.Name);
        for (var index = 0; index < template.Positional.Count; index++) text.Append('|').Append(index + 1).Append('=').Append(template.Positional[index]);
        foreach (var (name, value) in template.Named.OrderBy(item => item.Key, StringComparer.Ordinal)) text.Append('|').Append(name).Append('=').Append(value);
        return text.Append("}}").ToString();
    }

    private static bool OnlyInflections(JsonElement record) => record.TryGetProperty("senses", out var senses) && senses.ValueKind == JsonValueKind.Array
        && senses.GetArrayLength() > 0 && senses.EnumerateArray().All(sense =>
            (sense.TryGetProperty("form_of", out var forms) && forms.ValueKind == JsonValueKind.Array && forms.GetArrayLength() > 0)
            || (sense.TryGetProperty("tags", out var tags) && tags.ValueKind == JsonValueKind.Array && tags.EnumerateArray().Any(tag => tag.ValueKind == JsonValueKind.String && tag.GetString() == "form-of")));

    private static string? Text(JsonElement element, string key) => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    private static bool ValidTerm(string? value) => value is { Length: > 0 and <= 150 } && value.Any(char.IsLetterOrDigit)
        && !value.Any(char.IsControl) && !value.Contains(':') && !value.Contains("{{") && !value.Contains('|');
}
