using System.Runtime.InteropServices.JavaScript;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;
using EtymoVocab.Core.Languages;
using EtymoVocab.Core.Lookup;

namespace EtymoVocab.Web;

internal static partial class BrowserText
{
    [JSImport("normalizeNfc", "etymovocab")]
    internal static partial string NormalizeNfc(string text);
}

/// <summary>
/// Entry points for wwwroot/engine.js. Each returns a JSON envelope, <c>{"ok":true,"data":…}</c> or
/// <c>{"ok":false,"status":…,"title":…,"detail":…,"retryAfter":…}</c>, so JavaScript never sees .NET exceptions.
/// Requests go from the visitor's browser straight to Wiktionary (anonymous CORS).
/// </summary>
public static partial class Engine
{
    private static readonly LanguageRegistry Languages = new();

    private static readonly IWiktionaryClient Client = new MediaWikiClient(
        new HttpClient { Timeout = TimeSpan.FromSeconds(20) },
        new SimpleResponseCache(),
        new MediaWikiOptions { BrowserMode = true });

    private static readonly WordLookupService Words = new(Client, Languages, new LookupOptions());
    private static readonly RootFamilyService Families = new(Client, Languages);

    [JSExport]
    public static Task<string> LookupWord(string word) => Run(async () =>
    {
        if (!IsValidTitle(word))
            return Fail(400, "無效的查詢字詞");
        var result = await Words.LookupAsync(word, CancellationToken.None);
        return result is null ? Fail(404, "Wiktionary 沒有這個英文詞條", word) : Ok(result, EngineJson.Default.WordResult);
    });

    [JSExport]
    public static Task<string> LookupEntry(string lang, string term, string? etymonId) => Run(async () =>
    {
        if (!IsValidTitle(lang) || !IsValidTitle(term))
            return Fail(400, "無效的詞條參數");
        var result = await Words.LookupEntryAsync(lang, term, etymonId, CancellationToken.None);
        return result is null ? Fail(404, "Wiktionary 沒有這個詞條", term) : Ok(result, EngineJson.Default.WordResult);
    });

    [JSExport]
    public static Task<string> RootFamily(string lang, string root) => Run(async () =>
    {
        if (!IsValidTitle(lang) || !IsValidTitle(root))
            return Fail(400, "無效的詞根參數");
        var family = await Families.GetAsync(lang, root, "en", CancellationToken.None);
        return family is null ? Fail(404, "Wiktionary 沒有這個詞根的分類", root) : Ok(family, EngineJson.Default.RootFamilyResult);
    });

    [JSExport]
    public static Task<string> Suggest(string prefix) => Run(async () =>
    {
        prefix = prefix.Trim();
        IReadOnlyList<string> titles = prefix.Length is 0 or > 60 || !IsValidTitle(prefix)
            ? []
            : await Client.SuggestAsync(prefix, 8, CancellationToken.None);
        return Ok(titles, EngineJson.Default.IReadOnlyListString);
    });

    private static async Task<string> Run(Func<Task<string>> action)
    {
        try
        {
            return await action();
        }
        catch (UpstreamUnavailableException ex)
        {
            return Fail(503, "Wiktionary 暫時無法使用", ex.Message, ex.RetryAfter);
        }
        catch (Exception ex)
        {
            return Fail(500, "查詢引擎發生錯誤", ex.Message);
        }
    }

    private static string Ok<T>(T data, JsonTypeInfo<T> typeInfo) =>
        "{\"ok\":true,\"data\":" + JsonSerializer.Serialize(data, typeInfo) + "}";

    private static string Fail(int status, string title, string? detail = null, TimeSpan? retryAfter = null) =>
        JsonSerializer.Serialize(
            new Failure(false, status, title, detail, retryAfter is { } wait ? (int)Math.Ceiling(wait.TotalSeconds) : null),
            EngineJson.Default.Failure);

    /// <summary>Characters MediaWiki forbids in titles, plus control characters.</summary>
    private static bool IsValidTitle(string value) =>
        value.Length is > 0 and <= 100
        && value.IndexOfAny(['#', '<', '>', '[', ']', '{', '}', '|']) < 0
        && !value.Any(char.IsControl);

    internal sealed record Failure(bool Ok, int Status, string Title, string? Detail, int? RetryAfter);
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(WordResult))]
[JsonSerializable(typeof(RootFamilyResult))]
[JsonSerializable(typeof(IReadOnlyList<string>))]
[JsonSerializable(typeof(Engine.Failure))]
internal sealed partial class EngineJson : JsonSerializerContext;
