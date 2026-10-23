using EtymoVocab.Core.Entries;
using EtymoVocab.Core.Languages;
using EtymoVocab.Core.Wikitext;

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

    private sealed class Session(IWiktionaryClient client, LanguageRegistry languages, LookupOptions options, CancellationToken ct)
    {
        private const int MaxBatch = 50;
        private const int MaxGlossLength = 140;

        private readonly Dictionary<string, WikiPage?> _pages = new(StringComparer.Ordinal);
        private readonly Dictionary<(string Title, string Section), IReadOnlyList<EntrySection>?> _parsed = new();
        private readonly Dictionary<(string Lang, string Term, string? Id), string> _glosses = new();
        private readonly List<string> _warnings = [];
        private int _requestsLeft = options.MaxUpstreamRequests;
        private bool _complete = true;
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
            if (etymonId is not null && entries.Where(e => e.EtymonId == etymonId).ToList() is { Count: > 0 } matching)
                entries = matching;
            _lang = lang;
            _sectionName = sectionName;

            try
            {
                if (resolveInflections)
                    (page, entries) = await ResolveInflectionsAsync(page, entries, sectionName, entryLang);
            }
            catch (UpstreamUnavailableException)
            {
                _complete = false;
                Warn("原形詞條暫時無法從 Wiktionary 取得，請稍後重試。");
            }
            var chains = entries.Select(e => e.Steps.Select(NewWorkStep).ToList()).ToList();
            try
            {
                if (enrich)
                {
                    await ResolveAncestorsAsync(chains);
                    await ResolveGlossesAsync(entries, chains);
                }
            }
            catch (UpstreamUnavailableException)
            {
                _complete = false;
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
            var need = titles.Where(t => !_pages.ContainsKey(t)).Distinct(StringComparer.Ordinal).Take(MaxBatch).ToList();
            if (need.Count == 0)
                return true;
            if (_requestsLeft <= 0)
            {
                Warn("已達單次查詢的上游請求上限，部分詞條未展開。");
                return false;
            }
            _requestsLeft--;
            var fetched = await client.GetPagesAsync(need, ct);
            foreach (var title in need)
                _pages[title] = fetched.GetValueOrDefault(title);
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
                if (pending.Count == 0 || !await FetchAsync(pending.Select(s => s.Title!)))
                    return;
                foreach (var step in pending)
                {
                    step.Visited = true;
                    Resolve(step);
                }
                foreach (var chain in chains)
                    Extend(chain);
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

            var chosen = step.Step.EtymonId is { } id ? entries.FirstOrDefault(e => e.EtymonId == id) : null;
            if (chosen is null)
            {
                chosen = entries[0];
                step.Ambiguous = entries.Count > 1;
            }
            step.Resolved = chosen;
            step.ResolvedTitle = page.Title;
        }

        /// <summary>Appends the oldest ancestor's own ancestors. Never from a guessed (ambiguous) block.</summary>
        private void Extend(List<WorkStep> chain)
        {
            if (chain.Count == 0)
                return;
            var last = chain[^1];
            if (last.Extended || last.Resolved is null || last.Ambiguous || !last.Step.Transitive)
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
                .Where(p => p.Gloss is null)
                .Select(p => (p.Lang, p.Term, Id: p.EtymonId))
                .Concat(entries.SelectMany(e => e.Roots).Select(r => (r.Lang, Term: r.Root, Id: r.EtymonId)))
                .Distinct()
                .Select(w => (Key: w, Title: EntryNames.PageTitle(languages, w.Lang, w.Term)))
                .Where(w => w.Title is not null)
                .ToList();
            if (wanted.Count == 0 || !await FetchAsync(wanted.Select(w => w.Title!)))
                return;

            foreach (var (key, title) in wanted)
            {
                if (_pages.GetValueOrDefault(title!) is not { } page
                    || languages.SectionNameOf(key.Lang) is not { } section
                    || languages.EntryLanguageOf(key.Lang) is not { } entryLang
                    || Parse(page, section, entryLang) is not { Count: > 0 } found)
                    continue;

                // Affix pages often hold several unrelated morphemes ("in-" = into / not): only accept an exact pick.
                var chosen = key.Id is { } id ? found.FirstOrDefault(e => e.EtymonId == id) : null;
                chosen ??= found.Count(e => e.FirstSense is not null) == 1 ? found.First(e => e.FirstSense is not null) : null;
                if (chosen?.FirstSense is { } sense)
                    _glosses[key] = Truncate(sense);
            }
        }

        private WordResult Build(WikiPage page, IReadOnlyList<EntrySection> entries, List<List<WorkStep>> chains)
        {
            var etymologies = entries.Select((entry, i) => new EtymologyResult(
                entry.Number,
                entry.EtymonId,
                PlainTextRenderer.Render(entry.RawEtymology, languages),
                entry.Uncertain,
                chains[i].Select(ToStep).ToList(),
                entry.Morphology.Select(ToMorphology).ToList(),
                entry.Roots.Select(r => new RootResult(
                    r.Lang, languages.NameOf(r.Lang), WikitextCleaner.PlainTerm(r.Root),
                    _glosses.GetValueOrDefault((r.Lang, r.Root, r.EtymonId)), Url(r.Lang, r.Root))).ToList(),
                entry.Doublets.Select(d => new TermResult(d.Lang, WikitextCleaner.PlainTerm(d.Term), Url(d.Lang, d.Term))).ToList(),
                entry.PartsOfSpeech.Select(p => new PartOfSpeechResult(
                    p.Pos, p.Senses, p.Translations.Select(t => new TranslationResult(t.Sense, t.Terms)).ToList())
                    {
                        Relations = p.Relations.Select(r => new RelationResult(r.Kind, r.Sense, r.Terms)).ToList(),
                    }).ToList()
            )).ToList();

            var permalink = $"https://en.wiktionary.org/w/index.php?title={Uri.EscapeDataString(page.Title)}&oldid={page.RevisionId}"
                + "#" + Uri.EscapeDataString(_sectionName.Replace(' ', '_'));
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
                BaseForms = entries.SelectMany(e => e.PartsOfSpeech).SelectMany(p => p.Lemmas)
                    .Where(term => term != page.Title).Distinct(StringComparer.Ordinal).ToList(),
            };
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
                s.Resolved is not null && !s.Ambiguous ? s.Resolved.Morphology.Select(ToMorphology).ToList() : []);
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
                Url(p.Lang, p.Term))).ToList());

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
