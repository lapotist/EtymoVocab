using System.Text.RegularExpressions;
using EtymoVocab.Core.Languages;
using EtymoVocab.Core.Wikitext;

namespace EtymoVocab.Core.Entries;

/// <summary>Parses one language section of a Wiktionary page into etymology blocks and parts of speech.</summary>
public static partial class EntryParser
{
    public const int MaxSensesPerPartOfSpeech = 8;

    private static readonly HashSet<string> PartOfSpeechTitles = new(StringComparer.Ordinal)
    {
        "Noun", "Verb", "Adjective", "Adverb", "Pronoun", "Preposition", "Postposition", "Conjunction",
        "Interjection", "Determiner", "Article", "Numeral", "Particle", "Prefix", "Suffix", "Infix",
        "Interfix", "Circumfix", "Affix", "Combining form", "Root", "Proper noun", "Phrase",
        "Prepositional phrase", "Proverb", "Contraction", "Symbol", "Letter", "Participle", "Classifier",
    };

    public static IReadOnlyList<EntrySection> Parse(string languageSection, string langCode, LanguageRegistry languages)
    {
        var text = WikitextCleaner.StripNoise(languageSection);
        var headings = WikiSections.Headings(text);
        var etymologyHeadings = Enumerable.Range(0, headings.Count)
            .Where(i => EtymologyHeadingRegex().IsMatch(headings[i].Title))
            .ToList();

        var sections = new List<EntrySection>();
        if (etymologyHeadings.Count == 0)
            sections.Add(new EntrySection { Number = 0 });
        for (var n = 0; n < etymologyHeadings.Count; n++)
        {
            var section = new EntrySection
            {
                Number = n + 1,
                RawEtymology = WikiSections.OwnText(text, headings, etymologyHeadings[n]),
            };
            ReadEtymology(section, langCode);
            sections.Add(section);
        }

        // Single-etymology pages put parts of speech beside "Etymology"; multi-etymology pages nest them under each.
        var current = 0;
        for (var i = 0; i < headings.Count; i++)
        {
            var etymologyIndex = etymologyHeadings.IndexOf(i);
            if (etymologyIndex >= 0)
            {
                current = etymologyIndex;
                continue;
            }
            if (PartOfSpeechTitles.Contains(headings[i].Title))
            {
                var owner = etymologyHeadings.Count <= 1 ? 0 : current;
                sections[owner].PartsOfSpeech.Add(ReadPartOfSpeech(text, headings, i, langCode, languages));
            }
            if (headings[i].Title is "Derived terms" or "Related terms")
            {
                // A language-wide list after several homographs cannot safely be assigned to the last one.
                if (etymologyHeadings.Count > 1
                    && (i < etymologyHeadings[current] || headings[i].Level <= headings[etymologyHeadings[current]].Level))
                    continue;
                var owner = etymologyHeadings.Count <= 1 ? 0 : current;
                sections[owner].EtymologicalRelations.AddRange(EtymologicalRelationReader.Read(
                    WikiSections.OwnText(text, headings, i), headings[i].Title, langCode));
            }
        }
        return sections;
    }

    private static void ReadEtymology(EntrySection section, string langCode)
    {
        var raw = section.RawEtymology;
        var templates = TemplateScanner.Scan(raw);
        string Between(int k) => raw[(k == 0 ? 0 : templates[k - 1].End)..templates[k].Start];

        // "from {{m|la|in}} + {{m|la|speciō}}": mentions joined by '+' describe word formation, not a chain step.
        var plusMember = new bool[templates.Count];
        for (var k = 1; k < templates.Count; k++)
        {
            if (TemplateKinds.IsMention(templates[k - 1].Name) && TemplateKinds.IsMention(templates[k].Name)
                && Between(k).Trim() == "+")
            {
                plusMember[k - 1] = plusMember[k] = true;
            }
        }

        var inAsideClause = false;
        var inComparison = false;
        var inSpecificSense = false;
        var senseSources = new HashSet<(string Lang, string Term)>();
        var sawProseOrigin = false;
        var chainClosed = false;
        List<MorphPart>? plusGroup = null;
        for (var k = 0; k < templates.Count; k++)
        {
            var t = templates[k];
            var between = Between(k).Replace("cf.", "compare", StringComparison.OrdinalIgnoreCase);
            var sentenceEnd = Math.Max(between.LastIndexOf('.'), between.LastIndexOf("\n\n", StringComparison.Ordinal));
            if (sentenceEnd >= 0)
            {
                // Later sentences often switch to a component's history or another sense.
                // Keep their prose for display, without connecting it to the preceding origin.
                chainClosed |= sawProseOrigin;
                inAsideClause = false;
                inComparison = false;
                inSpecificSense = false;
            }
            var clause = between[(sentenceEnd + 1)..];
            inAsideClause |= AsideRegex().IsMatch(clause);
            inComparison |= ComparisonRegex().IsMatch(clause);
            inSpecificSense |= t.Name is "senseno" or "sense";
            inComparison |= ComponentSubjectRegex().IsMatch(clause);
            var hedged = HedgeRegex().IsMatch(between);

            if (plusGroup is not null && !(plusMember[k] && Between(k).Trim() == "+"))
                FlushPlusGroup(section, ref plusGroup);

            if (inComparison)
                continue;
            if (inSpecificSense)
            {
                if (TemplateKinds.DerivationRelation(t.Name) is not null && t.Arg(2) is { } source && t.Arg(3) is { } term)
                    senseSources.Add((source, WikitextCleaner.PlainTerm(term)));
                continue;
            }
            if (TemplateKinds.DerivationRelation(t.Name) is { } relation)
            {
                var target = t.Arg(1);
                var preceding = section.ProseSteps.LastOrDefault();
                var namesPrecedingLanguage = preceding != null && target == preceding.Lang;
                if (inAsideClause || chainClosed || (target != langCode && !namesPrecedingLanguage))
                    continue;
                if (preceding != null && !namesPrecedingLanguage && !FromOfRegex().IsMatch(between.TrimEnd()))
                {
                    chainClosed = true;
                    continue;
                }
                var lang = t.Arg(2);
                if (lang is null)
                    continue;
                var term = InlineTerm.Parse(t.Arg(3) ?? "", allowLangPrefix: false);
                sawProseOrigin = true;
                section.ProseSteps.Add(new EtymStep(
                    lang, term.Term, t.Arg(4) ?? term.Mod("alt"), t.Arg(5) ?? t.Param("t", "gloss") ?? term.Mod("t"),
                    relation, null, hedged || HasUncertainty(term), term.Mod("id") ?? t.Param("id"),
                    TemplateKinds.IsTransitive(relation)));
            }
            else if (TemplateKinds.IsMention(t.Name))
            {
                var lang = t.Arg(1);
                if (lang is null)
                    continue;
                var term = InlineTerm.Parse(t.Arg(2) ?? "", allowLangPrefix: false);
                var gloss = t.Arg(4) ?? t.Param("t", "gloss") ?? term.Mod("t");
                if (plusMember[k])
                {
                    if (chainClosed) continue;
                    sawProseOrigin = true;
                    section.Uncertain |= hedged || HasUncertainty(term);
                    plusGroup ??= [];
                    plusGroup.Add(new MorphPart(lang, term.Term, gloss, term.Mod("id")));
                    continue;
                }
                var connector = FromOfRegex().Match(between.TrimEnd());
                if (!chainClosed && !inAsideClause && connector.Success && term.Term.Length > 0)
                {
                    sawProseOrigin = true;
                    section.ProseSteps.Add(new EtymStep(
                        lang, term.Term, t.Arg(3), gloss, "from", ConnectorNote(between, connector),
                        hedged || HasUncertainty(term), term.Mod("id")));
                }
            }
            else if (TemplateKinds.IsAffix(t.Name))
            {
                sawProseOrigin = true;
                section.Uncertain |= hedged || t.ArgsFrom(2).Any(arg => HasUncertainty(InlineTerm.Parse(arg, false)));
                if (MorphologyReader.FromTemplate(t) is { } morphology)
                    section.AddMorphology(morphology);
            }
            else if (t.Name == "root" && t.Arg(2) is { } rootLang)
            {
                section.Uncertain |= hedged;
                foreach (var root in t.ArgsFrom(3))
                {
                    var parsed = InlineTerm.Parse(root, allowLangPrefix: false);
                    section.Uncertain |= HasUncertainty(parsed);
                    section.Roots.Add(new RootRef(rootLang, parsed.Term, parsed.Mod("id")));
                }
            }
            else if (TemplateKinds.IsDoublet(t.Name) && t.Arg(1) is { } doubletLang)
            {
                foreach (var doublet in t.ArgsFrom(2))
                    section.Doublets.Add(new TermRef(doubletLang, InlineTerm.Parse(doublet, false).Term));
            }
            else if (TemplateKinds.IsEtymon(t.Name))
            {
                section.Uncertain |= hedged;
                ReadEtymon(section, t, langCode);
            }
            else if (TemplateKinds.IsUncertainMarker(t.Name))
            {
                section.Uncertain = true;
            }
        }
        FlushPlusGroup(section, ref plusGroup);
        // An etymon template can repeat a borrowing that the prose explicitly limits to one
        // sense. An unqualified chain cannot represent that edge or anything reached through it.
        var qualified = section.EtymonSteps.FindIndex(step => senseSources.Contains((step.Lang, WikitextCleaner.PlainTerm(step.Term))));
        if (qualified >= 0) section.EtymonSteps.RemoveRange(qualified, section.EtymonSteps.Count - qualified);
        CopyEtymonIdsToProse(section);
    }

    private static void FlushPlusGroup(EntrySection section, ref List<MorphPart>? group)
    {
        if (group is { Count: >= 2 })
            section.AddMorphology(new Morphology(group[0].Lang, "plus", group));
        group = null;
    }

    /// <summary>
    /// <c>{{etymon|en|id=…|:inh|enm:fader&lt;id:father&gt;|:af|…}}</c>: keyword groups, each followed by etymons.
    /// Only the first etymon of the first chain group is followed; further ones are alternatives.
    /// </summary>
    private static void ReadEtymon(EntrySection section, WikiTemplate t, string langCode)
    {
        var lang = t.Arg(1) ?? langCode;
        section.EtymonId ??= t.Param("id");

        string? keyword = null;
        IReadOnlySet<string> keywordFlags = new HashSet<string>();
        var keywordUncertain = false;
        List<MorphPart>? morphology = null;
        var morphologyKind = "af";
        var chainTaken = false;

        void FlushMorphology()
        {
            if (morphology is { Count: > 0 })
                section.AddMorphology(new Morphology(morphology[0].Lang, morphologyKind, morphology));
            morphology = null;
        }

        foreach (var arg in t.ArgsFrom(2))
        {
            if (arg.StartsWith(':'))
            {
                FlushMorphology();
                var parsedKeyword = InlineTerm.Parse(arg[1..], allowLangPrefix: false);
                keyword = parsedKeyword.Term;
                keywordFlags = parsedKeyword.Flags;
                keywordUncertain = HasUncertainty(parsedKeyword);
                if (keywordUncertain)
                    section.Uncertain = true;
                morphologyKind = keywordFlags.Contains("surf") ? "surf" : "af";
                continue;
            }

            var term = InlineTerm.Parse(arg, allowLangPrefix: true);
            var termLang = term.Lang ?? lang;
            if (keyword is null || term.Term.Length == 0)
                continue;
            section.Uncertain |= HasUncertainty(term);

            if (TemplateKinds.IsEtymonMorphology(keyword))
            {
                morphology ??= [];
                morphology.Add(new MorphPart(termLang, term.Term, term.Mod("t") ?? term.Mod("gloss"), term.Mod("id")));
            }
            else if (keyword == "root")
            {
                section.Roots.Add(new RootRef(termLang, term.Term, term.Mod("id")));
            }
            else if (!chainTaken && TemplateKinds.EtymonChainRelation(keyword) is { } relation)
            {
                AddEtymonChain(section.EtymonSteps, term, termLang, relation,
                    keywordUncertain || HasUncertainty(term));
                chainTaken = true;
            }
        }
        FlushMorphology();
    }

    /// <summary>Adds an etymon step, then follows its inline <c>&lt;ety:…&gt;</c> chain if present.</summary>
    private static void AddEtymonChain(List<EtymStep> steps, InlineTerm term, string lang, string relation, bool uncertain)
    {
        steps.Add(new EtymStep(lang, term.Term, term.Mod("alt"), term.Mod("t"), relation, null, uncertain,
            term.Mod("id"), TemplateKinds.IsTransitive(relation)));

        if (!TemplateKinds.IsTransitive(relation) || term.Mod("ety") is not { } ety)
            return;
        var (keyword, flags, terms) = InlineTerm.ParseEty(ety);
        if (terms.Count > 0 && TemplateKinds.EtymonChainRelation(keyword) is { } next)
            AddEtymonChain(steps, terms[0], terms[0].Lang ?? lang, next, flags.Contains("unc") || HasUncertainty(terms[0]));
    }

    /// <summary>Prose steps carry no ids; borrow them from matching etymons so ancestor pages resolve exactly.</summary>
    private static void CopyEtymonIdsToProse(EntrySection section)
    {
        for (var i = 0; i < section.ProseSteps.Count; i++)
        {
            var step = section.ProseSteps[i];
            if (step.EtymonId is not null)
                continue;
            var match = section.EtymonSteps.FirstOrDefault(e =>
                e.EtymonId is not null && e.Lang == step.Lang
                && WikitextCleaner.PlainTerm(e.Term) == WikitextCleaner.PlainTerm(step.Term));
            if (match is not null)
                section.ProseSteps[i] = step with { EtymonId = match.EtymonId };
        }
    }

    private static string? ConnectorNote(string between, Match connector)
    {
        if (!connector.Groups[1].Value.Equals("of", StringComparison.OrdinalIgnoreCase))
            return null;
        var text = between.TrimEnd();
        var start = text.LastIndexOfAny([',', ';', '(', '.']) + 1;
        var note = text[start..].Trim();
        return note.Length > 2 ? note : null;
    }

    private static PartOfSpeech ReadPartOfSpeech(string text, IReadOnlyList<Heading> headings, int index, string langCode, LanguageRegistry languages)
    {
        var definitions = WikiSections.OwnText(text, headings, index);
        var inflections = InflectionReader.Read(definitions, langCode);
        var senses = ReadSenses(definitions, languages).Take(MaxSensesPerPartOfSpeech).ToList();

        IReadOnlyList<TranslationGroup> translations = [];
        for (var j = index + 1; j < headings.Count && headings[j].Level > headings[index].Level; j++)
        {
            if (headings[j].Title == "Translations")
            {
                translations = ReadMandarinTranslations(WikiSections.OwnText(text, headings, j), languages);
                break;
            }
        }
        return new PartOfSpeech(headings[index].Title, senses, translations)
        {
            Relations = LexicalRelationReader.Read(text, headings, index, langCode, languages),
            Lemmas = inflections.Lemmas,
            OnlyInflections = inflections.OnlyInflections,
        };
    }

    private static IEnumerable<string> ReadSenses(string definitions, LanguageRegistry languages)
    {
        var labels = new List<(int Depth, string Text)>();
        foreach (var line in TemplateScanner.SplitTopLevel(definitions, '\n'))
        {
            if (!line.StartsWith('#')) continue;
            var body = line.TrimStart('#');
            var depth = line.Length - body.Length;
            body = body.Trim();
            if (body.Length == 0 || body[0] is ':' or '*') continue;
            labels.RemoveAll(label => label.Depth >= depth);
            var rendered = PlainTextRenderer.Render(body, languages);
            if (rendered.Length == 0) continue;
            // A label-only definition groups the indented senses below it.
            if (body.StartsWith("{{", StringComparison.Ordinal) && IsLabelOnly(body))
            {
                labels.Add((depth, rendered));
                continue;
            }
            yield return labels.Count == 0 ? rendered : string.Join(" ", labels.Select(l => l.Text)) + " " + rendered;
        }
    }

    private static bool IsLabelOnly(string body)
    {
        var end = 0;
        foreach (var template in TemplateScanner.Scan(body))
        {
            if (!body.AsSpan(end, template.Start - end).IsWhiteSpace()
                || template.Name is not ("lb" or "lbl" or "label" or "q" or "qual" or "qualifier" or "senseid"))
                return false;
            end = template.End;
        }
        return end > 0 && body.AsSpan(end).IsWhiteSpace();
    }

    /// <summary>Mandarin rows of the per-sense translation tables (<c>{{trans-top|sense}} … {{trans-bottom}}</c>).</summary>
    private static List<TranslationGroup> ReadMandarinTranslations(string region, LanguageRegistry languages)
    {
        var groups = new List<TranslationGroup>();
        string? sense = null;
        var terms = new List<string>();

        void Flush()
        {
            if (terms.Count > 0)
                groups.Add(new TranslationGroup(sense ?? "", terms.ToList()));
            terms.Clear();
        }

        foreach (var t in TemplateScanner.Scan(region))
        {
            switch (t.Name)
            {
                case "trans-top" or "trans-top-also" or "trans-top-see" or "checktrans-top":
                    Flush();
                    var gloss = t.Arg(1) ?? t.Param("id");
                    sense = gloss is null ? null : PlainTextRenderer.Render(gloss, languages);
                    break;
                case "trans-bottom" or "checktrans-bottom":
                    Flush();
                    sense = null;
                    break;
                default:
                    if (TemplateKinds.TranslationTemplates.Contains(t.Name) && t.Arg(1) is "cmn" && t.Arg(2) is { } raw)
                    {
                        var term = WikitextCleaner.PlainTerm(raw);
                        if (term.Length > 0 && !terms.Contains(term))
                            terms.Add(term);
                    }
                    break;
            }
        }
        Flush();
        return groups;
    }

    [GeneratedRegex(@"^Etymology(?:\s+\d+)?$")]
    private static partial Regex EtymologyHeadingRegex();

    private static bool HasUncertainty(InlineTerm term) => term.Flags.Contains("unc")
        || term.Mod("unc") is { } value && value.ToLowerInvariant() is not ("0" or "no" or "false");

    // Clauses whose mentions are side remarks, not ancestors: "compare X", "see X", "akin to X", ...
    [GeneratedRegex(@"\b(compare|see|akin|cognate|cognates|related|equivalent|influenced|contrast|unrelated|confer)\b", RegexOptions.IgnoreCase)]
    private static partial Regex AsideRegex();

    // "Equivalent to" can introduce an explicit surface formation. A comparison assigns
    // subsequent terms and formations to another word.
    [GeneratedRegex(@"\b(compare|see|akin|cognates?|contrast|unrelated|confer)\b", RegexOptions.IgnoreCase)]
    private static partial Regex ComparisonRegex();

    [GeneratedRegex(@"\b(?:the|its)\s+(?:prefix|suffix|first component|second component)\b", RegexOptions.IgnoreCase)]
    private static partial Regex ComponentSubjectRegex();

    [GeneratedRegex(@"\b(probably|possibly|potentially|likely|presumably|perhaps|maybe|uncertain|unclear|doubtful|unknown)\b", RegexOptions.IgnoreCase)]
    private static partial Regex HedgeRegex();

    [GeneratedRegex(@"(?:^|[\s,;(])(from|of)$", RegexOptions.IgnoreCase)]
    private static partial Regex FromOfRegex();
}
