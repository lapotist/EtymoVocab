using System.Net;
using System.Text;
using EtymoVocab.Core.Lookup;

namespace EtymoVocab.Core.Tests;

public class MediaWikiClientTests
{
    private sealed class StubHandler(params Func<HttpRequestMessage, HttpResponseMessage>[] responses) : HttpMessageHandler
    {
        public List<HttpRequestMessage> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Requests.Add(request);
            return Task.FromResult(responses[Math.Min(Requests.Count, responses.Length) - 1](request));
        }
    }

    private static HttpResponseMessage Json(string body) =>
        new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private static HttpResponseMessage Status(HttpStatusCode code, int retryAfterSeconds)
    {
        var response = new HttpResponseMessage(code) { Content = new StringContent("Too many requests") };
        response.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(retryAfterSeconds));
        return response;
    }

    private const string BatchResponse = """
        {"batchcomplete":true,"query":{
          "normalized":[{"from":"inspect_","to":"inspect"}],
          "redirects":[{"from":"colour","to":"color"}],
          "pages":[
            {"ns":0,"title":"qwertyzzz","missing":true},
            {"pageid":1,"ns":0,"title":"inspect","revisions":[{"revid":11,"timestamp":"2026-08-27T18:24:54Z","slots":{"main":{"content":"==English=="}}}]},
            {"pageid":2,"ns":0,"title":"color","revisions":[{"revid":22,"timestamp":"2026-01-01T00:00:00Z","slots":{"main":{"content":"==English=="}}}]}
          ]}}
        """;

    private static (MediaWikiClient Client, StubHandler Handler) Create(bool browser, params Func<HttpRequestMessage, HttpResponseMessage>[] responses)
    {
        var handler = new StubHandler(responses);
        var client = new MediaWikiClient(new HttpClient(handler), new SimpleResponseCache(), new MediaWikiOptions { BrowserMode = browser });
        return (client, handler);
    }

    [Fact]
    public async Task Batch_maps_requested_titles_through_normalization_and_redirects_and_caches_them()
    {
        var (client, handler) = Create(browser: false, _ => Json(BatchResponse));

        var pages = await client.GetPagesAsync(["inspect_", "colour", "qwertyzzz"], CancellationToken.None);
        var again = await client.GetPagesAsync(["colour", "qwertyzzz"], CancellationToken.None);

        Assert.Equal(11, pages["inspect_"]!.RevisionId);
        Assert.Equal("color", pages["colour"]!.Title);
        Assert.Null(pages["qwertyzzz"]);
        Assert.Equal(22, again["colour"]!.RevisionId);
        Assert.Null(again["qwertyzzz"]); // negative result served from cache
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task Incoming_redirect_titles_are_kept_even_when_the_canonical_title_was_requested()
    {
        var (client, handler) = Create(browser: false,
            _ => Json("""
                {"continue":{"rdcontinue":"next","continue":"||"},"query":{"pages":[
                  {"title":"color","revisions":[{"revid":22,"timestamp":"2026-01-01T00:00:00Z","slots":{"main":{"content":"==English=="}}}],
                   "redirects":[{"title":"colour"}]}]}}
                """),
            _ => Json("""{"query":{"pages":[{"title":"color","redirects":[{"title":"old spelling"}]}]}}"""));

        var pages = await client.GetPagesAsync(["color"], CancellationToken.None);
        var page = Assert.IsType<WikiPage>(pages["color"]);
        Assert.Equal(22, page.RevisionId);
        Assert.Equal(["colour", "old spelling"], page.RedirectTitles.Order(StringComparer.Ordinal));
        Assert.Contains("rdcontinue=next", handler.Requests[1].RequestUri!.Query);
    }

    [Fact]
    public async Task Server_mode_identifies_with_user_agent()
    {
        var (client, handler) = Create(browser: false, _ => Json(BatchResponse));

        await client.GetPagesAsync(["inspect_"], CancellationToken.None);

        var request = handler.Requests.Single();
        Assert.DoesNotContain("origin=", request.RequestUri!.Query);
        Assert.Contains("EtymoVocab", request.Headers.UserAgent.ToString());
    }

    [Fact]
    public async Task Browser_mode_uses_anonymous_cors_and_api_user_agent()
    {
        var (client, handler) = Create(browser: true, _ => Json(BatchResponse));

        await client.GetPagesAsync(["inspect_"], CancellationToken.None);

        var request = handler.Requests.Single();
        Assert.Contains("origin=%2A", request.RequestUri!.Query);
        Assert.True(request.Headers.Contains("Api-User-Agent"));
    }

    [Fact]
    public async Task Long_retry_after_fails_fast_and_reports_the_wait()
    {
        var (client, handler) = Create(browser: true, _ => Status(HttpStatusCode.TooManyRequests, 30));

        var error = await Assert.ThrowsAsync<UpstreamUnavailableException>(
            () => client.GetPagesAsync(["inspect"], CancellationToken.None));

        Assert.Equal(TimeSpan.FromSeconds(30), error.RetryAfter);
        Assert.True(error.RateLimited);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task Category_listing_follows_continuation_up_to_the_limit()
    {
        const string first = """
            {"continue":{"cmcontinue":"page|5452414e53504f5254|1","continue":"-||"},
             "query":{"pages":[{"ns":14,"title":"Category:English terms prefixed with trans-","categoryinfo":{"pages":794}}],
                      "categorymembers":[{"ns":0,"title":"transfer"},{"ns":0,"title":"translate"}]}}
            """;
        const string second = """
            {"batchcomplete":true,"query":{"pages":[{"ns":14,"title":"Category:English terms prefixed with trans-","categoryinfo":{"pages":794}}],
                      "categorymembers":[{"ns":0,"title":"transport"}]}}
            """;
        var (client, handler) = Create(browser: false, _ => Json(first), _ => Json(second));

        var listing = await client.GetCategoryMembersAsync("Category:English terms prefixed with trans-", 2000, CancellationToken.None);

        Assert.Equal(["transfer", "translate", "transport"], listing!.Members);
        Assert.Equal(794, listing.TotalPages);
        Assert.Equal(2, handler.Requests.Count);
        Assert.Contains("cmcontinue=page%7C5452414e53504f5254%7C1", handler.Requests[1].RequestUri!.Query);
    }

    [Fact]
    public async Task Category_search_returns_titles_with_article_counts()
    {
        const string body = """
            {"batchcomplete":true,"query":{"allcategories":[
              {"category":"English terms prefixed with in- (not)","size":180,"pages":177,"files":0,"subcats":0},
              {"category":"English terms prefixed with in- (la-into)","size":10,"pages":10,"files":0,"subcats":0}]}}
            """;
        var (client, handler) = Create(browser: false, _ => Json(body));

        var categories = await client.ListCategoriesAsync("English terms prefixed with in- (", 50, CancellationToken.None);

        Assert.Equal([new CategorySize("Category:English terms prefixed with in- (not)", 177),
            new CategorySize("Category:English terms prefixed with in- (la-into)", 10)], categories);
        Assert.Contains("acprefix=English%20terms%20prefixed%20with%20in-%20%28", handler.Requests.Single().RequestUri!.Query);
    }

    [Fact]
    public async Task Short_retry_after_is_honoured_once_then_succeeds()
    {
        var (client, handler) = Create(browser: false, _ => Status(HttpStatusCode.ServiceUnavailable, 0), _ => Json(BatchResponse));

        var pages = await client.GetPagesAsync(["inspect_"], CancellationToken.None);

        Assert.Equal(11, pages["inspect_"]!.RevisionId);
        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task Headerless_429_retains_its_status_when_no_retries_remain()
    {
        var handler = new StubHandler(_ => new(HttpStatusCode.TooManyRequests));
        using var http = new HttpClient(handler);
        var client = new MediaWikiClient(http, new SimpleResponseCache(), new MediaWikiOptions { MaxRetries = 0 });

        var error = await Assert.ThrowsAsync<UpstreamUnavailableException>(
            () => client.SuggestAsync("inspect", 8, CancellationToken.None));
        Assert.Equal(429, RelatedLookupError.FromUpstream(error).Status);
        Assert.Null(error.RetryAfter);
    }

    [Fact]
    public async Task Elapsed_retry_date_allows_an_immediate_retry()
    {
        var (client, handler) = Create(false, _ =>
        {
            var response = new HttpResponseMessage(HttpStatusCode.TooManyRequests);
            response.Headers.RetryAfter = new(DateTimeOffset.UtcNow.AddMinutes(-5));
            return response;
        }, _ => Json(BatchResponse));

        var pages = await client.GetPagesAsync(["inspect_"], CancellationToken.None);
        Assert.Equal(11, pages["inspect_"]!.RevisionId);
        Assert.Equal(2, handler.Requests.Count);
    }

    private sealed class StalledBody : MemoryStream
    {
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return 0;
        }
    }

    [Fact]
    public async Task Timeout_covers_the_response_body_and_releases_the_request_permit()
    {
        var handler = new StubHandler(_ =>
        {
            var content = new StreamContent(new StalledBody());
            content.Headers.ContentType = new("application/json");
            return new(HttpStatusCode.OK) { Content = content };
        }, _ => Json(BatchResponse));
        using var http = new HttpClient(handler) { Timeout = TimeSpan.FromMilliseconds(100) };
        var client = new MediaWikiClient(http, new SimpleResponseCache(), new MediaWikiOptions { MaxConcurrency = 1 });
        using var guard = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        var error = await Assert.ThrowsAsync<UpstreamUnavailableException>(
            () => client.GetPagesAsync(["inspect_"], guard.Token));
        Assert.IsAssignableFrom<OperationCanceledException>(error.InnerException);
        Assert.Equal(11, (await client.GetPagesAsync(["inspect_"], guard.Token))["inspect_"]!.RevisionId);
    }
}
