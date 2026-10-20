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
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task Short_retry_after_is_honoured_once_then_succeeds()
    {
        var (client, handler) = Create(browser: false, _ => Status(HttpStatusCode.ServiceUnavailable, 0), _ => Json(BatchResponse));

        var pages = await client.GetPagesAsync(["inspect_"], CancellationToken.None);

        Assert.Equal(11, pages["inspect_"]!.RevisionId);
        Assert.Equal(2, handler.Requests.Count);
    }
}
