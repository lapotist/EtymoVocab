namespace EtymoVocab.Api.Wiktionary;

public sealed class WiktionaryOptions
{
    public const string Section = "Wiktionary";

    public string ApiUrl { get; set; } = "https://en.wiktionary.org/w/api.php";

    /// <summary>
    /// Wikimedia's User-Agent policy requires a descriptive agent with contact information
    /// (a URL or e-mail). Deployments should put their own contact here.
    /// </summary>
    public string UserAgent { get; set; } = "EtymoVocab/0.1 (https://github.com/lapotist/EtymoVocab) dotnet-HttpClient";

    /// <summary>Wikimedia asks API clients to keep concurrent requests at 3 or fewer.</summary>
    public int MaxConcurrency { get; set; } = 3;

    public int TimeoutSeconds { get; set; } = 15;

    /// <summary>Retries for 429/502/503/504, only when the wait (Retry-After or backoff) is short.</summary>
    public int MaxRetries { get; set; } = 2;

    public int MaxRetryDelaySeconds { get; set; } = 5;

    public int PageCacheMinutes { get; set; } = 30;

    public int MissingPageCacheMinutes { get; set; } = 10;
}
