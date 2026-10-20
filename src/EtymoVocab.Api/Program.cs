using System.Net;
using System.Text.Encodings.Web;
using System.Text.Unicode;
using EtymoVocab.Api.Wiktionary;
using EtymoVocab.Core.Languages;
using EtymoVocab.Core.Lookup;
using Microsoft.Extensions.Caching.Memory;

// JSON API over the same engine the static site runs in the browser. The web UI itself lives in
// src/EtymoVocab.Web; this host is for programmatic and future Android clients.
var builder = WebApplication.CreateBuilder(args);

var wiktionary = builder.Configuration.GetSection(MediaWikiOptions.Section).Get<MediaWikiOptions>() ?? new MediaWikiOptions();
builder.Services.AddSingleton(wiktionary);
builder.Services.AddSingleton(builder.Configuration.GetSection("Lookup").Get<LookupOptions>() ?? new LookupOptions());
builder.Services.AddSingleton<LanguageRegistry>();
// Entry sizes are roughly KB, so this bounds the cache at about 200 MB.
builder.Services.AddMemoryCache(o => o.SizeLimit = 200_000);
builder.Services.AddSingleton<IResponseCache, MemoryResponseCache>();
builder.Services.AddSingleton<IWiktionaryClient>(sp =>
{
    var logger = sp.GetRequiredService<ILogger<MediaWikiClient>>();
    var http = new HttpClient(new SocketsHttpHandler
    {
        AutomaticDecompression = DecompressionMethods.All,
        PooledConnectionLifetime = TimeSpan.FromMinutes(10),
    })
    {
        Timeout = TimeSpan.FromSeconds(wiktionary.TimeoutSeconds),
    };
    return new MediaWikiClient(http, sp.GetRequiredService<IResponseCache>(), wiktionary, message => logger.LogWarning("{Message}", message));
});
builder.Services.AddSingleton<WordLookupService>();
builder.Services.AddSingleton<RootFamilyService>();
builder.Services.AddHostedService<LanguageDataLoader>();
builder.Services.AddProblemDetails();
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.Encoder = JavaScriptEncoder.Create(UnicodeRanges.All));

var app = builder.Build();

app.UseExceptionHandler();

var resultCacheDuration = TimeSpan.FromMinutes(builder.Configuration.GetValue("Lookup:ResultCacheMinutes", 30));

var api = app.MapGroup("/api");
api.AddEndpointFilter(async (context, next) =>
{
    try
    {
        return await next(context);
    }
    catch (UpstreamUnavailableException ex)
    {
        if (ex.RetryAfter is { } retryAfter && retryAfter > TimeSpan.Zero)
            context.HttpContext.Response.Headers.RetryAfter = ((int)Math.Ceiling(retryAfter.TotalSeconds)).ToString();
        return Results.Problem(
            statusCode: StatusCodes.Status503ServiceUnavailable,
            title: "Wiktionary 暫時無法使用",
            detail: ex.Message);
    }
});

api.MapGet("/words/{word}", async (string word, WordLookupService lookup, IMemoryCache cache, CancellationToken ct) =>
{
    word = word.Trim();
    if (!Titles.IsValid(word))
        return Results.Problem(statusCode: StatusCodes.Status400BadRequest, title: "無效的查詢字詞");

    var key = "word:" + word;
    if (cache.TryGetValue(key, out WordResult? cached) && cached is not null)
        return Results.Ok(cached);

    var result = await lookup.LookupAsync(word, ct);
    if (result is null)
        return Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "Wiktionary 沒有這個英文詞條", detail: word);

    if (result.Complete)
        cache.Set(key, result, new MemoryCacheEntryOptions { AbsoluteExpirationRelativeToNow = resultCacheDuration, Size = 32 });
    return Results.Ok(result);
});

api.MapGet("/entries/{lang}/{term}", async (string lang, string term, string? id, WordLookupService lookup, CancellationToken ct) =>
{
    if (!Titles.IsValid(lang) || !Titles.IsValid(term) || (id is not null && !Titles.IsValid(id)))
        return Results.Problem(statusCode: StatusCodes.Status400BadRequest, title: "無效的詞條參數");
    var result = await lookup.LookupEntryAsync(lang, term, id, ct);
    return result is null
        ? Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "Wiktionary 沒有這個詞條", detail: term)
        : Results.Ok(result);
});

api.MapGet("/roots/family", async (string lang, string root, string? target, RootFamilyService families, IMemoryCache cache, CancellationToken ct) =>
{
    target ??= "en";
    if (!Titles.IsValid(lang) || !Titles.IsValid(root) || !Titles.IsValid(target))
        return Results.Problem(statusCode: StatusCodes.Status400BadRequest, title: "無效的詞根參數");

    var key = $"family:{target}:{lang}:{root}";
    if (!cache.TryGetValue(key, out RootFamilyResult? family) || family is null)
    {
        family = await families.GetAsync(lang, root, target, ct);
        if (family is null)
            return Results.Problem(statusCode: StatusCodes.Status404NotFound, title: "Wiktionary 沒有這個詞根的分類", detail: root);
        cache.Set(key, family, new MemoryCacheEntryOptions { AbsoluteExpirationRelativeToNow = resultCacheDuration, Size = 8 });
    }
    return Results.Ok(family);
});

api.MapGet("/suggest", async (string q, IWiktionaryClient client, CancellationToken ct) =>
{
    q = q.Trim();
    if (q.Length is 0 or > 60 || !Titles.IsValid(q))
        return Results.Ok(Array.Empty<string>());
    return Results.Ok(await client.SuggestAsync(q, 8, ct));
});

app.MapGet("/healthz", () => Results.Ok(new { status = "ok" }));

app.Run();

static class Titles
{
    /// <summary>Characters MediaWiki forbids in titles, plus control characters.</summary>
    public static bool IsValid(string value) =>
        value.Length is > 0 and <= 100
        && value.IndexOfAny(['#', '<', '>', '[', ']', '{', '}', '|']) < 0
        && !value.Any(char.IsControl);
}
