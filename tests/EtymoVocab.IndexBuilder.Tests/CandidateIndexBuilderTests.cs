using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using EtymoVocab.IndexBuilder;

namespace EtymoVocab.IndexBuilder.Tests;

public class CandidateIndexBuilderTests
{
    [Fact]
    public void Typed_origins_are_canonical_and_semantic_or_comparison_templates_never_become_candidates()
    {
        var builder = new CandidateIndexBuilder();
        Add(builder, """
            {"word":"sample","lang_code":"en","etymology_templates":[
              {"name":"bor","args":{"1":"en","2":"la-lat","3":"praedicō"}},
              {"name":"inh","args":{"1":"en","2":"enm","3":"sample"}},
              {"name":"root","args":{"1":"en","2":"ine-pro","3":"*deyḱ-"}},
              {"name":"cog","args":{"1":"de","2":"noise"}},
              {"name":"m","args":{"1":"la","2":"unrelated"}},
              {"name":"cal","args":{"1":"en","2":"fr","3":"modèle"}},
              {"name":"syn","args":{"1":"en","2":"noise"}}
            ]}
            """);
        Assert.Equal(3, builder.Origins.Count);
        Assert.Contains("sample", builder.Origins[CandidateIndexBuilder.OriginKey("la", "praedico")]);
        Assert.Contains("sample", builder.Origins[CandidateIndexBuilder.OriginKey("enm", "sample")]);
        Assert.Contains("sample", builder.Origins[CandidateIndexBuilder.OriginKey("ine-pro", "Reconstruction:Proto-Indo-European/deyḱ-")]);
        Assert.Equal(4, builder.Statistics.UnsupportedTemplates);
    }

    [Fact]
    public void Etymon_aliases_nested_chains_and_delegated_surface_templates_supply_origins()
    {
        var builder = new CandidateIndexBuilder();
        Add(builder, """
            {"word":"biology","lang_code":"en","etymology_number":"2","etymology_templates":[
              {"name":"surf","args":{"1":"+af","2":"en","3":"bio-","4":"-logy"}},
              {"name":"ety","args":{"1":"en","2":":bor","3":"la:biologia<ety:bor<grc:βίος>>","id":"science"}}
            ]}
            """);
        Assert.Contains(CandidateIndexBuilder.OriginKey("en", "bio-"), builder.Origins.Keys);
        Assert.Contains(CandidateIndexBuilder.OriginKey("en", "-logy"), builder.Origins.Keys);
        Assert.Contains(CandidateIndexBuilder.OriginKey("la", "biologia"), builder.Origins.Keys);
        Assert.Contains(CandidateIndexBuilder.OriginKey("grc", "βίος"), builder.Origins.Keys);
        Assert.DoesNotContain(builder.Origins.Keys, key => key.Contains("+af"));
    }

    [Fact]
    public void Duplicate_parts_of_speech_deduplicate_without_folding_case_and_only_inflection_records_are_skipped()
    {
        var builder = new CandidateIndexBuilder();
        const string template = "\"etymology_templates\":[{\"name\":\"af\",\"args\":{\"1\":\"en\",\"2\":\"base\"}}]";
        Add(builder, "{\"word\":\"Word\",\"lang_code\":\"en\"," + template + "}");
        Add(builder, "{\"word\":\"Word\",\"lang_code\":\"en\",\"pos\":\"verb\"," + template + "}");
        Add(builder, "{\"word\":\"word\",\"lang_code\":\"en\"," + template + "}");
        Add(builder, "{\"word\":\"forms\",\"lang_code\":\"en\",\"senses\":[{\"form_of\":[{\"word\":\"form\"}]}]," + template + "}");
        Add(builder, "{\"word\":\"mixed\",\"lang_code\":\"en\",\"senses\":[{\"form_of\":[{\"word\":\"form\"}]},{\"glosses\":[\"independent sense\"]}]," + template + "}");
        Assert.Equal(["Word", "mixed", "word"], builder.Origins.Single().Value.Order(StringComparer.Ordinal));
        Assert.Equal(1, builder.Statistics.InflectionOnlyRecords);
    }

    [Fact]
    public void Keys_and_utf8_shard_hash_match_javascript_for_diacritics_quotes_and_supplementary_unicode()
    {
        Assert.Equal("[\"grc\",\"φωνή\"]", CandidateIndexBuilder.OriginKey("grc", "φωνή"));
        Assert.Equal("[\"en\",\"a\\\"b\\\\c\"]", CandidateIndexBuilder.OriginKey("en", "a\"b\\c"));
        Assert.Equal("[\"en\",\"😀\u2028\"]", CandidateIndexBuilder.OriginKey("en", "😀\u2028"));
        // Independently computed with Math.imul(FNV ^ byte,16777619) over TextEncoder bytes.
        Assert.Equal((byte)0x83, CandidateIndexBuilder.ShardByte("[\"grc\",\"φωνή\"]"));
    }

    [Fact]
    public async Task Build_is_deterministic_integrity_checked_and_reads_gzip_without_publishing_invalid_input()
    {
        var directory = Path.Combine(Path.GetTempPath(), "etymovocab-index-test-" + Guid.NewGuid());
        Directory.CreateDirectory(directory);
        try
        {
            var input = Path.Combine(directory, "sample.jsonl.gz");
            var line = "{\"word\":\"word\",\"lang_code\":\"en\",\"etymology_templates\":[{\"name\":\"root\",\"args\":{\"1\":\"en\",\"2\":\"ine-pro\",\"3\":\"*speḱ-\"}}]}\n";
            await using (var stream = File.Create(input))
            await using (var gzip = new GZipStream(stream, CompressionMode.Compress))
                await gzip.WriteAsync(Encoding.UTF8.GetBytes(line));
            var source = new SourceMetadata("Fixture", "https://example.test/dataset", "2026-10-01", "2026-10-21", "CC BY-SA 4.0", "https://example.test/license", "Test");
            var a = await new CandidateIndexBuilder().BuildAsync(input, Path.Combine(directory, "a"), source);
            var b = await new CandidateIndexBuilder().BuildAsync(input, Path.Combine(directory, "b"), source);
            Assert.Equal(a.BuildId, b.BuildId);
            Assert.Equal(1, a.EntryCount);
            Assert.Equal(1, a.OriginCount);
            Assert.Equal(1, a.EdgeCount);
            Assert.Equal(256, a.Shards.Count);
            Assert.Equal(Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(input))), a.Source.InputSha256);
            foreach (var (prefix, metadata) in a.Shards)
            {
                Assert.Equal($"{prefix}-{metadata.Sha256}.json", metadata.File);
                var bytes = await File.ReadAllBytesAsync(Path.Combine(directory, "a", metadata.File));
                Assert.Equal(metadata.Bytes, bytes.Length);
                Assert.Equal(metadata.Sha256, Convert.ToHexStringLower(SHA256.HashData(bytes)));
            }
            var output = Path.Combine(directory, "a");
            var intact = Path.Combine(output, a.Shards["00"].File);
            var damaged = Path.Combine(output, a.Shards["01"].File);
            var timestamp = new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc);
            File.SetLastWriteTimeUtc(intact, timestamp);
            await File.WriteAllBytesAsync(damaged, new byte[a.Shards["01"].Bytes]);
            await Task.WhenAll(new CandidateIndexBuilder().BuildAsync(input, output, source),
                new CandidateIndexBuilder().BuildAsync(input, output, source));
            Assert.Equal(timestamp, File.GetLastWriteTimeUtc(intact));
            Assert.Equal(a.Shards["01"].Sha256, Convert.ToHexStringLower(SHA256.HashData(await File.ReadAllBytesAsync(damaged))));
            Assert.Empty(Directory.EnumerateFiles(output, "*.tmp"));
            var bad = Path.Combine(directory, "bad.jsonl");
            await File.WriteAllTextAsync(bad, line + "{broken");
            await Assert.ThrowsAnyAsync<JsonException>(() => new CandidateIndexBuilder().BuildAsync(bad, Path.Combine(directory, "a"), source));
            var preserved = JsonDocument.Parse(await File.ReadAllBytesAsync(Path.Combine(directory, "a", "manifest.json")));
            Assert.Equal(a.BuildId, preserved.RootElement.GetProperty("buildId").GetString());
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    private static void Add(CandidateIndexBuilder builder, string json)
    {
        using var document = JsonDocument.Parse(json);
        builder.AddRecord(document.RootElement);
    }
}
