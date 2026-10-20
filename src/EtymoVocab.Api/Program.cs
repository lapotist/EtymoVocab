using System.Net;
using System.Text.Encodings.Web;
using System.Text.Unicode;
using EtymoVocab.Api.Wiktionary;
using EtymoVocab.Core.Languages;
using EtymoVocab.Core.Lookup;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;

var builder = WebApplication.CreateBuilder(args);

builder.Services.Configure<WiktionaryOptions>(builder.Configuration.GetSection(WiktionaryOptions.Section));
builder.Services.AddSingleton(builder.Configuration.GetSection("Lookup").Get<LookupOptions>() ?? new LookupOptions());
builder.Services.AddSingleton<LanguageRegistry>();
builder.Services.AddSingleton<WiktionaryThrottle>();
// Entry sizes are roughly KB, so this bounds the cache at about 200 MB.
builder.Services.AddMemoryCache(o => o.SizeLimit = 200_000);
builder.Services
    .AddHttpClient<IWiktionaryClient, WiktionaryApiClient>((sp, http) =>
    {
        var options = sp.GetRequiredService<IOptions<WiktionaryOptions>>().Value;
        http.Timeout = TimeSpan.FromSeconds(options.TimeoutSeconds);
        http.DefaultRequestHeaders.UserAgent.TryParseAdd(options.UserAgent);
    })
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
    {
        AutomaticDecompression = DecompressionMethods.All,
        PooledConnectionLifetime = TimeSpan.FromMinutes(10),
    });
builder.Services.AddTransient<WordLookupService>();
builder.Services.AddTransient<RootFamilyService>();
builder.Services.AddHostedService<LanguageDataLoader>();
builder.Services.AddProblemDetails();
builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.Encoder = JavaScriptEncoder.Create(UnicodeRanges.All));

var app = builder.Build();

app.UseExceptionHandler();
app.UseDefaultFiles();
app.UseStaticFiles();

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
