using System.Net;
using System.Text;
using System.Text.Json;
using EtymoVocab.Core.Lookup;

namespace EtymoVocab.Core.Tests;

public class CategoryPaginationTests
{
    private const string Category = "Category:English terms derived from the Proto-Indo-European root *kʷelh₁-";

    private sealed class StubHandler(Func<int, HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        public List<Uri> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Requests.Add(request.RequestUri!);
            return Task.FromResult(respond(Requests.Count, request));
        }
    }

    private static HttpResponseMessage Page(IEnumerable<string> members, int total, string? continuation = null)
    {
        var body = new Dictionary<string, object>
        {
            ["query"] = new
            {
                categorymembers = members.Select(title => new { title }),
                pages = new[] { new { title = Category, categoryinfo = new { pages = total } } },
            },
        };
        if (continuation is not null)
            body["continue"] = new Dictionary<string, string> { ["cmcontinue"] = continuation, ["continue"] = "-||" };
        return new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json"),
        };
    }

    private static (MediaWikiClient Client, StubHandler Handler) Create(Func<int, HttpRequestMessage, HttpResponseMessage> respond)
    {
        var handler = new StubHandler(respond);
        var client = new MediaWikiClient(new HttpClient(handler), new SimpleResponseCache(), new MediaWikiOptions { MaxRetries = 0 });
        return (client, handler);
    }

    private static IEnumerable<string> Members(int start, int count) => Enumerable.Range(start, count).Select(i => $"word{i}");

    [Fact]
    public async Task Family_larger_than_one_page_follows_continuation_deduplicates_and_caches_all_members()
    {
        var (client, handler) = Create((request, _) => request == 1
            ? Page(Members(0, 500), 795, "page two|token")
            : Page(Members(499, 296), 795));

        var result = await client.GetCategoryMembersAsync(Category, RootFamilyService.MaxMembers, CancellationToken.None);
        var cached = await client.GetCategoryMembersAsync(Category, RootFamilyService.MaxMembers, CancellationToken.None);

        Assert.NotNull(result);
        Assert.Equal(795, result.TotalPages);
        Assert.Equal(Members(0, 795), result.Members);
        Assert.Equal(result, cached);
        Assert.Equal(2, handler.Requests.Count);
        Assert.Contains("cmcontinue=page%20two%7Ctoken", handler.Requests[1].Query);
        Assert.Contains("continue=-%7C%7C", handler.Requests[1].Query);
    }

    [Fact]
    public async Task Requested_limit_is_enforced_and_category_total_is_preserved_for_truncation_notice()
    {
        var (client, handler) = Create((request, _) => Page(Members((request - 1) * 500, 500), 3000, $"page{request + 1}"));

        var result = await client.GetCategoryMembersAsync(Category, 600, CancellationToken.None);

        Assert.Equal(600, result!.Members.Count);
        Assert.Equal(3000, result.TotalPages);
        Assert.Equal("word599", result.Members[^1]);
        Assert.Equal(2, handler.Requests.Count);
        Assert.Contains("cmlimit=100", handler.Requests[1].Query);
    }

    [Fact]
    public async Task Large_caller_limit_is_bounded_to_four_full_pages_and_two_thousand_members()
    {
        var (client, handler) = Create((request, _) => Page(Members((request - 1) * 500, 500), 6000, $"page{request + 1}"));

        var result = await client.GetCategoryMembersAsync(Category, 10000, CancellationToken.None);

        Assert.Equal(2000, result!.Members.Count);
        Assert.Equal(6000, result.TotalPages);
        Assert.Equal(4, handler.Requests.Count);
    }

    [Fact]
    public async Task Failure_on_a_later_page_does_not_cache_a_partial_family()
    {
        var (client, handler) = Create((request, _) =>
        {
            if (request != 2) return request is 1 or 3 ? Page(["first"], 2, "next") : Page(["second"], 2);
            var limited = new HttpResponseMessage(HttpStatusCode.TooManyRequests) { Content = new StringContent("Limited") };
            limited.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(30));
            return limited;
        });

        var error = await Assert.ThrowsAsync<UpstreamUnavailableException>(() => client.GetCategoryMembersAsync(Category, 2000, CancellationToken.None));
        var retry = await client.GetCategoryMembersAsync(Category, 2000, CancellationToken.None);

        Assert.Equal(TimeSpan.FromSeconds(30), error.RetryAfter);
        Assert.Equal(["first", "second"], retry!.Members);
        Assert.Equal(4, handler.Requests.Count);
        Assert.DoesNotContain("cmcontinue", handler.Requests[2].Query);
    }

    [Fact]
    public async Task Cancellation_does_not_cache_or_continue_the_interrupted_listing()
    {
        using var cancellation = new CancellationTokenSource();
        var (client, handler) = Create((request, _) =>
        {
            if (request == 1)
            {
                cancellation.Cancel();
                return Page(["first"], 2, "next");
            }
            return Page(["first", "second"], 2);
        });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => client.GetCategoryMembersAsync(Category, 2000, cancellation.Token));
        var retry = await client.GetCategoryMembersAsync(Category, 2000, CancellationToken.None);

        Assert.Equal(["first", "second"], retry!.Members);
        Assert.Equal(2, handler.Requests.Count);
        Assert.DoesNotContain("cmcontinue", handler.Requests[1].Query);
    }

    [Fact]
    public async Task Repeated_continuation_fails_without_persisting_partial_results()
    {
        var (client, handler) = Create((request, _) => request <= 2
            ? Page(["first"], 2, "stuck")
            : Page(["first", "second"], 2));

        await Assert.ThrowsAsync<UpstreamUnavailableException>(() => client.GetCategoryMembersAsync(Category, 2000, CancellationToken.None));
        var retry = await client.GetCategoryMembersAsync(Category, 2000, CancellationToken.None);

        Assert.Equal(["first", "second"], retry!.Members);
        Assert.Equal(3, handler.Requests.Count);
    }
}
