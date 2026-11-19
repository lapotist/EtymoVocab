using EtymoVocab.Core.Entries;
using EtymoVocab.Core.Languages;
using EtymoVocab.Core.Wikitext;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace EtymoVocab.Core.Lookup;

public sealed class LookupOptions
{
    /// <summary>Upstream round trips one lookup may spend; each fetches up to 50 pages.</summary>
    public int MaxUpstreamRequests { get; set; } = 6;

    /// <summary>Fetch rounds for ancestor pages; each round may extend a chain from its oldest ancestor.</summary>
    public int MaxAncestorRounds { get; set; } = 3;
}

/// <summary>
/// Looks a word up live on English Wiktionary and follows its etymology across ancestor pages:
/// one batched request for the word, then one per ancestor round, then one for morpheme glosses.
/// </summary>
public sealed class WordLookupService(IWiktionaryClient client, LanguageRegistry languages, LookupOptions options)
{
    public const string License = "CC BY-SA 4.0";
    public const int MaxRelatedBatchWords = 20;

    /// <summary>An English word. Wiktionary titles are case-sensitive, so "Inspect" falls back to "inspect".</summary>
    public Task<WordResult?> LookupAsync(string word, CancellationToken ct)
    {
        word = word.Trim();
        var lower = word.ToLowerInvariant();
        string[] candidates = lower == word ? [word] : [word, lower];
        return new Session(client, languages, options, ct).RunAsync(candidates, "en", null, resolveInflections: true);
    }

    /// <summary>Discovery only: reads definitions and lexical relations, following explicit inflections without fetching ancestry.</summary>
    public Task<WordResult?> LookupRelatedAsync(string word, CancellationToken ct)
    {
        word = word.Trim();
        var lower = word.ToLowerInvariant();
        string[] candidates = lower == word ? [word] : [word, lower];
        return new Session(client, languages, options, ct).RunAsync(candidates, "en", null, enrich: false, resolveInflections: true);
    }

    /// <summary>
    /// Fetches a batch's starting pages together, then uses the same sense/inflection rules as
    /// individual discovery. Exact titles and lowercase fallbacks fit in one request for 20 words.
    /// No ancestor pages are fetched. Missing or invalid items remain isolated outcomes.
    /// </summary>
    public async Task<IReadOnlyList<RelatedLookupItem>> LookupRelatedBatchAsync(IReadOnlyList<string> words, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(words);
        if (words.Count > MaxRelatedBatchWords)
            throw new ArgumentOutOfRangeException(nameof(words), $"At most {MaxRelatedBatchWords} words may be looked up together.");
        ct.ThrowIfCancellationRequested();
        var inputs = words.Select(word => word?.Trim() ?? "").ToList();
        var titles = inputs.Where(IsValidRelatedTitle)
            .SelectMany(word => word.ToLowerInvariant() == word ? new[] { word } : new[] { word, word.ToLowerInvariant() })
            .Distinct(StringComparer.Ordinal).ToArray();
        var shared = new DiscoveryBatchClient(client);
        if (titles.Length > 0 && options.MaxUpstreamRequests > 0)
            await shared.GetPagesAsync(titles, ct); // A failure here propagates with its Retry-After.

        var results = new List<RelatedLookupItem>(inputs.Count);
        foreach (var word in inputs)
        {
            ct.ThrowIfCancellationRequested();
            if (!IsValidRelatedTitle(word))
            {
                results.Add(new(word, null, new(400, "無效的查詢字詞", word, null)));
                continue;
            }
            var lower = word.ToLowerInvariant();
            string[] candidates = lower == word ? [word] : [word, lower];
            try
            {
                var result = await new Session(shared, languages, options, ct, shared.Pages)
                    .RunAsync(candidates, "en", null, enrich: false, resolveInflections: true);
                results.Add(result is null
                    ? new(word, null, new(404, "Wiktionary 沒有這個英文詞條", word, null))
                    : new(word, result, null));
            }
            catch (UpstreamUnavailableException error)
            {
                results.Add(new(word, null, RelatedLookupError.FromUpstream(error)));
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                results.Add(new(word, null, new(500, "查詢引擎發生錯誤", error.Message, null)));
            }
        }
        return results;
    }

    private static bool IsValidRelatedTitle(string word) =>
        word.Length is > 0 and <= 100
        && word.IndexOfAny(['#', '<', '>', '[', ']', '{', '}', '|']) < 0
        && !word.Any(char.IsControl);

    /// <summary>Shares preloaded pages and additional lemma fetches even with a non-caching client.</summary>
    private sealed class DiscoveryBatchClient(IWiktionaryClient upstream) : IWiktionaryClient
    {
        private readonly Dictionary<string, WikiPage?> _pages = new(StringComparer.Ordinal);
        private UpstreamUnavailableException? _failure;
        public IReadOnlyDictionary<string, WikiPage?> Pages => _pages;

        public async Task<IReadOnlyDictionary<string, WikiPage?>> GetPagesAsync(IReadOnlyCollection<string> titles, CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();
            var missing = titles.Distinct(StringComparer.Ordinal).Where(title => !_pages.ContainsKey(title)).ToArray();
            if (missing.Length > 0)
            {
                if (_failure is not null) throw _failure;
                try
                {
                    var fetched = await upstream.GetPagesAsync(missing, ct);
                    foreach (var title in missing)
                        _pages[title] = fetched.GetValueOrDefault(title);
                }
                catch (UpstreamUnavailableException error)
                {
                    _failure = error; // Do not retry an unavailable upstream for each remaining lemma.
                    throw;
                }
            }
            return titles.Distinct(StringComparer.Ordinal).ToDictionary(title => title, title => _pages[title], StringComparer.Ordinal);
        }

        public Task<CategoryListing?> GetCategoryMembersAsync(string title, int limit, CancellationToken ct) =>
            upstream.GetCategoryMembersAsync(title, limit, ct);

        public Task<IReadOnlyList<CategorySize>> ListCategoriesAsync(string prefix, int limit, CancellationToken ct) =>
            upstream.ListCategoriesAsync(prefix, limit, ct);

        public Task<IReadOnlyList<string>> SuggestAsync(string prefix, int limit, CancellationToken ct) =>
            upstream.SuggestAsync(prefix, limit, ct);
    }

    /// <summary>
    /// Any language's entry, e.g. Latin <c>speciō</c> or <c>*spekjō</c> (Proto-Italic), for expanding a node of the
    /// etymology tree. With <paramref name="etymonId"/>, only the matching etymology is returned when it exists.
    /// </summary>
    public Task<WordResult?> LookupEntryAsync(string lang, string term, string? etymonId, CancellationToken ct)
    {
        var title = EntryNames.PageTitle(languages, lang, term);
        return title is null
            ? Task.FromResult<WordResult?>(null)
            : new Session(client, languages, options, ct).RunAsync([title], lang, etymonId);
    }

    private sealed class WorkStep(EtymStep step, string? title, string? section, string? entryLang)
    {
        public EtymStep Step { get; } = step;
        public string? Title { get; } = title;
        public string? Section { get; } = section;
        public string? EntryLang { get; } = entryLang;
        public bool Visited { get; set; }
        public bool Extended { get; set; }
        public bool Ambiguous { get; set; }
        public EntrySection? Resolved { get; set; }
        public string? ResolvedTitle { get; set; }
        public string Key => $"{Section}|{Title ?? Step.Lang + ":" + Step.Term}";
    }

    private sealed class Session(IWiktionaryClient client, LanguageRegistry languages, LookupOptions options, CancellationToken ct,
        IReadOnlyDictionary<string, WikiPage?>? initialPages = null)
    {
        private const int MaxBatch = 50;
        private const int MaxGlossLength = 140;

        private readonly Dictionary<string, WikiPage?> _pages = initialPages is null
            ? new(StringComparer.Ordinal) : new(initialPages, StringComparer.Ordinal);
        private readonly Dictionary<(string Title, string Section), IReadOnlyList<EntrySection>?> _parsed = new();
        private readonly Dictionary<(string Lang, string Term, string? Id), string> _glosses = new();
        private readonly List<string> _warnings = [];
        private int _requestsLeft = options.MaxUpstreamRequests - (initialPages is null ? 0 : 1);
        private bool _complete = true;
        private RelatedLookupError? _upstreamError;
        private string _lang = "en";
        private string _sectionName = "English";
        private string? _resolvedFrom;

        public async Task<WordResult?> RunAsync(IReadOnlyList<string> candidates, string lang, string? etymonId, bool enrich = true, bool resolveInflections = false)
        {
            if (languages.SectionNameOf(lang) is not { } sectionName || languages.EntryLanguageOf(lang) is not { } entryLang)
                return null;

            await FetchAsync(candidates); // failure propagates: there is nothing to show without the page

            WikiPage? page = null;
            IReadOnlyList<EntrySection>? entries = null;
            foreach (var candidate in candidates)
            {
                if (_pages.GetValueOrDefault(candidate) is { } p && Parse(p, sectionName, entryLang) is { Count: > 0 } e)
                {
                    (page, entries) = (p, e);
                    break;
                }
            }
            if (page is null || entries is null)
                return null;
            if (etymonId is not null)
            {
                entries = entries.Where(e => e.EtymonId == etymonId).ToList();
                if (entries.Count != 1) return null;
            }
            _lang = lang;
            _sectionName = sectionName;

            try
            {
                if (resolveInflections)
                    (page, entries) = await ResolveInflectionsAsync(page, entries, sectionName, entryLang);
            }
            catch (UpstreamUnavailableException error)
            {
                _complete = false;
                _upstreamError = RelatedLookupError.FromUpstream(error);
                Warn("原形詞條暫時無法從 Wiktionary 取得，請稍後重試。");
            }
            var chains = entries.Select(e => e.Steps.Select(NewWorkStep).ToList()).ToList();
            try
            {
                if (enrich && _upstreamError is null)
                {
                    await ResolveAncestorsAsync(chains);
                    await ResolveGlossesAsync(entries, chains);
                }
            }
            catch (UpstreamUnavailableException error)
            {
                _complete = false;
                _upstreamError = RelatedLookupError.FromUpstream(error);
                Warn("部分祖源資料暫時無法從 Wiktionary 取得，結果不完整。");
            }
            return Build(page, entries, chains);
        }

        private async Task<(WikiPage, IReadOnlyList<EntrySection>)> ResolveInflectionsAsync(
            WikiPage page, IReadOnlyList<EntrySection> entries, string sectionName, string entryLang)
        {
            var original = page;
            var originalEntries = entries;
            var visited = new HashSet<string>(StringComparer.Ordinal) { page.Title };
            while (true)
            {
                var parts = entries.SelectMany(e => e.PartsOfSpeech).ToList();
                var lemmas = parts.SelectMany(p => p.Lemmas).Distinct(StringComparer.Ordinal).ToList();
                if (parts.Count == 0 || parts.Any(p => !p.OnlyInflections) || lemmas.Count != 1)
                    break;
                var title = lemmas[0];
                if (!visited.Add(title))
                {
                    Warn("詞形參照形成循環，保留原查詢詞條。");
                    return (original, originalEntries);
                }
                if (!await FetchAsync([title]))
                    break;
                if (_pages.GetValueOrDefault(title) is not { } lemmaPage
                    || Parse(lemmaPage, sectionName, entryLang) is not { Count: > 0 } lemmaEntries
                    || !lemmaEntries.Any(e => e.PartsOfSpeech.Count > 0))
                {
                    Warn($"Wiktionary 尚無可讀取的原形詞條：{title}。");
                    break;
                }
                if (lemmaPage.Title != title && !visited.Add(lemmaPage.Title))
                {
                    Warn("詞形參照形成循環，保留原查詢詞條。");
                    return (original, originalEntries);
                }
                (page, entries) = (lemmaPage, lemmaEntries);
            }
            _resolvedFrom = page.Title == original.Title ? null : original.Title;
            return (page, entries);
        }

        private async Task<bool> FetchAsync(IEnumerable<string> titles)
        {
            var need = titles.Where(t => !_pages.ContainsKey(t)).Distinct(StringComparer.Ordinal).ToArray();
            foreach (var batch in need.Chunk(MaxBatch))
            {
                if (_requestsLeft <= 0)
                {
                    _complete = false;
                    Warn("已達單次查詢的上游請求上限，部分詞條未展開。");
                    return false;
                }
                _requestsLeft--;
                var fetched = await client.GetPagesAsync(batch, ct);
                foreach (var title in batch)
                    _pages[title] = fetched.GetValueOrDefault(title);
            }
            return true;
        }

        private IReadOnlyList<EntrySection>? Parse(WikiPage page, string sectionName, string entryLang)
        {
            var key = (page.Title, sectionName);
            if (!_parsed.TryGetValue(key, out var entries))
            {
                var section = WikiSections.LanguageSection(page.Wikitext, sectionName);
                entries = section is null ? null : EntryParser.Parse(section, entryLang, languages);
                _parsed[key] = entries;
            }
            return entries;
        }

        private WorkStep NewWorkStep(EtymStep step) => new(
            step,
            EntryNames.PageTitle(languages, step.Lang, step.Term),
            languages.SectionNameOf(step.Lang),
            languages.EntryLanguageOf(step.Lang));

        private async Task ResolveAncestorsAsync(List<List<WorkStep>> chains)
        {
            for (var round = 0; round < options.MaxAncestorRounds; round++)
            {
                var pending = chains.SelectMany(c => c).Where(s => !s.Visited && s.Title is not null).ToList();
                if (pending.Count == 0) return;
                var fetchedAll = await FetchAsync(pending.Select(s => s.Title!));
                foreach (var step in pending)
                {
                    if (!_pages.ContainsKey(step.Title!)) continue;
                    step.Visited = true;
                    Resolve(step);
                }
                foreach (var chain in chains)
                    Extend(chain);
                if (!fetchedAll) return;
            }
        }

        /// <summary>Finds the etymology block on the ancestor's page: by etymon id, else the only one.</summary>
        private void Resolve(WorkStep step)
        {
            if (_pages.GetValueOrDefault(step.Title!) is not { } page || step.Section is null || step.EntryLang is null)
                return;
            var entries = Parse(page, step.Section, step.EntryLang);
            if (entries is null || entries.Count == 0)
                return;

            var matching = step.Step.EtymonId is { } id ? entries.Where(e => e.EtymonId == id).ToList() : entries;
            step.Ambiguous = matching.Count != 1;
            if (!step.Ambiguous) step.Resolved = matching[0];
            step.ResolvedTitle = page.Title;
        }

        /// <summary>Appends the oldest ancestor's own ancestors. Never from a guessed (ambiguous) block.</summary>
        private void Extend(List<WorkStep> chain)
        {
            if (chain.Count == 0)
                return;
            var last = chain[^1];
            if (last.Extended || last.Resolved is null || chain.Any(s => s.Step.Uncertain || !s.Step.Transitive || s.Ambiguous || s.Resolved?.Uncertain == true))
                return;
            last.Extended = true;

            // The ancestor often restates the tail we already have; keep only new steps.
            var keys = chain.Select(s => s.Key).ToHashSet(StringComparer.Ordinal);
            foreach (var ancestor in last.Resolved.Steps)
            {
                var work = NewWorkStep(ancestor);
                if (keys.Add(work.Key))
                    chain.Add(work);
            }
        }

        private async Task ResolveGlossesAsync(IReadOnlyList<EntrySection> entries, List<List<WorkStep>> chains)
        {
            var morphology = entries.SelectMany(e => e.Morphology)
                .Concat(chains.SelectMany(c => c).Where(s => s.Resolved is not null && !s.Ambiguous)
                    .SelectMany(s => s.Resolved!.Morphology));
            var wanted = morphology.SelectMany(m => m.Parts)
                .Select(p => (p.Lang, p.Term, Id: p.EtymonId))
                .Concat(entries.SelectMany((e, i) => GatherRoots(e, chains[i])).Select(r => (r.Lang, Term: r.Root, Id: r.EtymonId)))
                .Distinct()
                .Select(w => (Key: w, Title: EntryNames.PageTitle(languages, w.Lang, w.Term)))
                .Where(w => w.Title is not null)
                .ToList();
            if (wanted.Count == 0) return;
            await FetchAsync(wanted.Select(w => w.Title!));

            foreach (var (key, title) in wanted)
            {
                if (_pages.GetValueOrDefault(title!) is not { } page
                    || languages.SectionNameOf(key.Lang) is not { } section
                    || languages.EntryLanguageOf(key.Lang) is not { } entryLang
                    || Parse(page, section, entryLang) is not { Count: > 0 } found)
                    continue;

                // Affix pages often hold several unrelated morphemes ("in-" = into / not): only accept an exact pick.
                var matches = key.Id is { } id ? found.Where(e => e.EtymonId == id).ToList() : found;
                var chosen = matches.Count == 1 ? matches[0] : null;
                if (chosen?.FirstSense is { } sense)
                    _glosses[key] = Truncate(sense);
            }
        }

        private WordResult Build(WikiPage page, IReadOnlyList<EntrySection> entries, List<List<WorkStep>> chains)
        {
            var permalink = $"https://en.wiktionary.org/w/index.php?title={Uri.EscapeDataString(page.Title)}&oldid={page.RevisionId}"
                + "#" + Uri.EscapeDataString(_sectionName.Replace(' ', '_'));
            var etymologies = entries.Select((entry, i) => new EtymologyResult(
                entry.Number,
                entry.EtymonId,
                PlainTextRenderer.Render(entry.RawEtymology, languages),
                entry.Uncertain,
                chains[i].Select(ToStep).ToList(),
                entry.Morphology.Select(ToMorphology).ToList(),
                GatherRoots(entry, chains[i]).Select(r => new RootResult(
                    r.Lang, languages.NameOf(r.Lang), WikitextCleaner.PlainTerm(r.Root),
                    _glosses.GetValueOrDefault((r.Lang, r.Root, r.EtymonId)), Url(r.Lang, r.Root)) { Id = r.EtymonId }).ToList(),
                entry.Doublets.Select(d => new TermResult(d.Lang, WikitextCleaner.PlainTerm(d.Term), Url(d.Lang, d.Term))).ToList(),
                entry.PartsOfSpeech.Select(p => new PartOfSpeechResult(
                    p.Pos, p.Senses, p.Translations.Select(t => new TranslationResult(t.Sense, t.Terms)).ToList())
                    {
                        Relations = p.Relations.Select(r => new RelationResult(r.Kind, r.Sense, r.Terms)
                        {
                            ThesaurusTargets = r.ThesaurusTargets,
                        }).ToList(),
                    }).ToList()
            )
            {
                EtymologicalRelations = entry.EtymologicalRelations.DistinctBy(r => (r.Kind, r.Lang, r.Term))
                    .Select(r => new EtymologicalRelationResult(r.Kind, r.Lang, r.Term,
                        Url(r.Lang, r.Term), permalink, r.SourceSection)).ToList(),
                OriginAnchors = BuildOriginAnchors(page, entry, chains[i]),
            }).ToList();

            return new WordResult(
                page.Title,
                _lang,
                languages.NameOf(_lang),
                new SourceInfo(page.Title, page.RevisionId, page.Timestamp, permalink, License),
                etymologies,
                _warnings,
                _complete)
            {
                ResolvedFrom = _resolvedFrom,
                UpstreamError = _upstreamError,
                BaseForms = entries.SelectMany(e => e.PartsOfSpeech).SelectMany(p => p.Lemmas)
                    .Where(term => term != page.Title).Distinct(StringComparer.Ordinal).ToList(),
            };
        }

        private IReadOnlyList<OriginAnchorResult> BuildOriginAnchors(WikiPage page, EntrySection entry, IReadOnlyList<WorkStep> chain)
        {
            var anchors = new List<OriginAnchorResult>();
            var seen = new HashSet<(string Key, string Kind)>();

            void Add(string kind, string lang, string term, string? id)
            {
                if (ResolveOrigin(lang, term, id) is not { } origin) return;
                var (originPage, chosen, entryLang, section) = origin;
                var title = EntryNames.ComposeCanonical(originPage.Title);
                string JsonString(string value) => "\"" + JsonEncodedText.Encode(value, JavaScriptEncoder.UnsafeRelaxedJsonEscaping) + "\"";
                var key = "[" + JsonString(entryLang) + "," + JsonString(title) + ","
                    + (chosen.EtymonId is { } idValue ? JsonString(idValue) : "null") + "]";
                if (!seen.Add((key, kind))) return;
                var sourceUrl = $"https://en.wiktionary.org/w/index.php?title={Uri.EscapeDataString(originPage.Title)}&oldid={originPage.RevisionId}"
                    + "#" + Uri.EscapeDataString(section.Replace(' ', '_'));
                var aliases = _pages.Where(p => p.Value?.Title == originPage.Title)
                    .Select(p => p.Key).Concat(originPage.RedirectTitles)
                    .Select(EntryNames.ComposeCanonical).Where(alias => alias != title)
                    .Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
                anchors.Add(new OriginAnchorResult(key, kind, entryLang, WikitextCleaner.PlainTerm(term), title,
                    chosen.EtymonId, EntryNames.PageUrl(title, section), sourceUrl) { LookupAliases = aliases });
            }

            void AddRootsAndComponents(EntrySection section)
            {
                foreach (var root in section.Roots)
                    Add("root", root.Lang, root.Root, root.EtymonId);
                foreach (var part in section.Morphology.SelectMany(m => m.Parts))
                    Add("component", part.Lang, part.Term, part.EtymonId);
            }

            var selfTerm = page.Title.StartsWith("Reconstruction:", StringComparison.Ordinal) && page.Title.IndexOf('/') is var slash && slash >= 0
                ? "*" + page.Title[(slash + 1)..] : page.Title;
            Add("self", _lang, selfTerm, entry.EtymonId);
            // Uncertain history does not make a lexical identity uncertain. Other entries can
            // definitely derive from this word without committing to its own proposed origins.
            if (entry.Uncertain) return anchors;
            AddRootsAndComponents(entry);
            foreach (var step in chain)
            {
                if (!step.Step.Transitive || step.Step.Uncertain || step.Ambiguous
                    || ResolveOrigin(step.Step.Lang, step.Step.Term, step.Step.EtymonId) is not { } origin)
                    break;
                Add("ancestor", step.Step.Lang, step.Step.Term, step.Step.EtymonId);
                if (origin.Entry.Uncertain) break;
                if (origin.Entry.PartsOfSpeech.Any(p => p.Pos == "Root"))
                    Add("root", step.Step.Lang, step.Step.Term, step.Step.EtymonId);
                AddRootsAndComponents(origin.Entry);
            }
            return anchors;
        }

        /// <summary>Unlike display-only first-sense fallback, equality evidence requires an exact id or a sole etymology.</summary>
        private (WikiPage Page, EntrySection Entry, string Lang, string Section)? ResolveOrigin(string lang, string term, string? id)
        {
            if (EntryNames.PageTitle(languages, lang, term) is not { } title
                || languages.EntryLanguageOf(lang) is not { } entryLang
                || languages.SectionNameOf(lang) is not { } section
                || (_pages.GetValueOrDefault(title) ?? _pages.Values.FirstOrDefault(p => p?.Title == title)) is not { } page
                || Parse(page, section, entryLang) is not { Count: > 0 } entries)
                return null;
            var matching = id is null ? entries : entries.Where(e => e.EtymonId == id).ToList();
            if (matching.Count != 1) return null;
            // An id-less selected entry inside a homograph page must never acquire a sole-entry identity.
            if (matching[0].EtymonId is null && entries.Count != 1) return null;
            return (page, matching[0], entryLang, section);
        }

        /// <summary>
        /// Ancestor entries may be the only place where a root is tagged. Preserve that evidence,
        /// stopping at the first ambiguous or non-inherited relation rather than crossing it.
        /// Merely being a reconstructed Proto-language term does not make an ancestor a root.
        /// </summary>
        private static IReadOnlyList<RootRef> GatherRoots(EntrySection entry, IReadOnlyList<WorkStep> chain)
        {
            if (entry.Uncertain) return [];
            var roots = new List<RootRef>(entry.Roots);
            foreach (var step in chain)
            {
                if (!step.Step.Transitive || step.Ambiguous || step.Step.Uncertain) break;
                if (step.Resolved is not { Uncertain: false } resolved) break;
                roots.AddRange(resolved.Roots);
                if (resolved.PartsOfSpeech.Any(p => p.Pos == "Root") && !string.IsNullOrWhiteSpace(step.Step.Term))
                    roots.Add(new(step.Step.Lang, step.Step.Term, step.Step.EtymonId ?? resolved.EtymonId));
            }
            return roots.DistinctBy(r => (r.Lang, WikitextCleaner.PlainTerm(r.Root), r.EtymonId)).ToList();
        }

        private StepResult ToStep(WorkStep s)
        {
            string? gloss = s.Step.Gloss is { } stated ? Truncate(PlainTextRenderer.Render(stated, languages)) : null;
            var glossSource = gloss is null ? null : "etymology";
            if (gloss is null && !s.Ambiguous && s.Resolved?.FirstSense is { } sense)
            {
                gloss = Truncate(sense);
                glossSource = "definition";
            }
            var term = WikitextCleaner.PlainTerm(s.Step.Term);
            var display = s.Step.Display is { } alt ? WikitextCleaner.PlainTerm(alt) : term;
            return new StepResult(
                s.Step.Lang,
                languages.NameOf(s.Step.Lang),
                term == "-" ? "" : term,
                display is "" or "-" ? term : display,
                gloss,
                glossSource,
                s.Step.Relation,
                s.Step.Note,
                s.Step.Uncertain,
                s.Ambiguous,
                EntryNames.PageUrl(s.ResolvedTitle ?? s.Title, s.Section),
                s.Resolved is { Uncertain: false } resolved && !s.Step.Uncertain ? resolved.Morphology.Select(ToMorphology).ToList() : [])
            {
                Id = s.Step.EtymonId ?? s.Resolved?.EtymonId,
                Transitive = s.Step.Transitive,
                AncestryUncertain = s.Resolved?.Uncertain == true,
            };
        }

        private MorphologyResult ToMorphology(Morphology m) => new(
            m.Lang,
            languages.NameOf(m.Lang),
            m.Kind,
            m.Parts.Select(p => new PartResult(
                WikitextCleaner.PlainTerm(p.Term),
                p.Gloss is { } gloss
                    ? PlainTextRenderer.Render(gloss, languages)
                    : _glosses.GetValueOrDefault((p.Lang, p.Term, p.EtymonId)),
                p.EtymonId,
                Url(p.Lang, p.Term), p.Lang, languages.NameOf(p.Lang))).ToList());

        private string? Url(string lang, string term) =>
            EntryNames.PageUrl(EntryNames.PageTitle(languages, lang, term), languages.SectionNameOf(lang));

        private void Warn(string message)
        {
            if (!_warnings.Contains(message))
                _warnings.Add(message);
        }

        private static string Truncate(string text) =>
            text.Length <= MaxGlossLength ? text : text[..(MaxGlossLength - 1)].TrimEnd() + "…";
    }
}
