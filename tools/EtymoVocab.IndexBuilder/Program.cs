using EtymoVocab.IndexBuilder;

try
{
    if (args.Length == 0 || args.Contains("--help"))
    {
        Console.WriteLine("Usage: dotnet run --project tools/EtymoVocab.IndexBuilder -- --input english.jsonl[.gz] --output directory --source-url URL --dump-date YYYY-MM-DD --extracted-at YYYY-MM-DD");
        return 0;
    }
    var options = new Dictionary<string, string>(StringComparer.Ordinal);
    if (args.Length % 2 != 0) throw new ArgumentException("Every option needs a value.");
    for (var i = 0; i < args.Length; i += 2)
    {
        if (!new[] { "--input", "--output", "--source-url", "--dump-date", "--extracted-at" }.Contains(args[i]) || !options.TryAdd(args[i], args[i + 1]))
            throw new ArgumentException("Unknown or repeated option: " + args[i]);
    }
    string Required(string name) => options.GetValueOrDefault(name) is { Length: > 0 } value ? value : throw new ArgumentException("Missing " + name);
    var metadata = new SourceMetadata("Kaikki / English Wiktionary", Required("--source-url"), Required("--dump-date"), Required("--extracted-at"),
        "CC BY-SA 4.0", "https://en.wiktionary.org/wiki/Wiktionary:Copyrights", "Wiktionary contributors; machine-readable extraction by Kaikki / Wiktextract");
    if (!Uri.TryCreate(metadata.Url, UriKind.Absolute, out var uri) || uri.Scheme != "https") throw new ArgumentException("Source URL must use HTTPS.");
    if (!DateOnly.TryParseExact(metadata.DumpDate, "yyyy-MM-dd", out _) || !DateOnly.TryParseExact(metadata.ExtractedAt, "yyyy-MM-dd", out _))
        throw new ArgumentException("Source dates must use YYYY-MM-DD.");
    var builder = new CandidateIndexBuilder();
    var manifest = await builder.BuildAsync(Required("--input"), Required("--output"), metadata,
        count => Console.Error.WriteLine($"Read {count:N0} entries…"));
    Console.WriteLine($"Index {manifest.BuildId}: {manifest.EntryCount:N0} words, {manifest.OriginCount:N0} origins, {manifest.EdgeCount:N0} candidate edges, {manifest.Shards.Count} shards.");
    Console.WriteLine($"Source SHA256: {manifest.Source.InputSha256}");
    return 0;
}
catch (Exception error) when (error is ArgumentException or IOException or System.Text.Json.JsonException)
{
    Console.Error.WriteLine(error.Message);
    return 1;
}
