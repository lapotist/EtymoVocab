using EtymoVocab.Core.Languages;
using EtymoVocab.Core.Lookup;

namespace EtymoVocab.Api.Wiktionary;

/// <summary>
/// Loads Wiktionary's full language-name tables in the background so rare source languages get proper
/// names and entry lookups. Lookups work before (and without) this, using the curated core.
/// </summary>
public sealed class LanguageDataLoader(
    IWiktionaryClient client,
    LanguageRegistry registry,
    ILogger<LanguageDataLoader> logger) : BackgroundService
{
    private const int MaxAttempts = 6;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        for (var attempt = 1; attempt <= MaxAttempts && !stoppingToken.IsCancellationRequested; attempt++)
        {
            try
            {
                var pages = await client.GetPagesAsync(
                    [LanguageRegistry.LanguagesModule, LanguageRegistry.EtymologyLanguagesModule], stoppingToken);
                registry.Merge(
                    pages.GetValueOrDefault(LanguageRegistry.LanguagesModule)?.Wikitext,
                    pages.GetValueOrDefault(LanguageRegistry.EtymologyLanguagesModule)?.Wikitext);
                logger.LogInformation("Wiktionary language tables loaded: {Loaded}", registry.HasLiveData);
                return;
            }
            catch (UpstreamUnavailableException ex)
            {
                // Back off well beyond Retry-After: this is background work and must not compete with lookups.
                var delay = TimeSpan.FromMinutes(Math.Pow(2, attempt - 1));
                if (ex.RetryAfter > delay)
                    delay = ex.RetryAfter.Value;
                logger.LogWarning("Could not load Wiktionary language tables (attempt {Attempt}): {Message}; retrying in {Delay}",
                    attempt, ex.Message, delay);
                try
                {
                    await Task.Delay(delay, stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
        }
    }
}
