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
        List<MorphPart>? plusGroup = null;
        for (var k = 0; k < templates.Count; k++)
        {
            var t = templates[k];
            var between = Between(k).Replace("cf.", "compare", StringComparison.OrdinalIgnoreCase);
            var sentenceEnd = between.LastIndexOf('.');
            if (sentenceEnd >= 0)
                inAsideClause = false;
            if (AsideRegex().IsMatch(sentenceEnd >= 0 ? between[(sentenceEnd + 1)..] : between))
                inAsideClause = true;
            var hedged = HedgeRegex().IsMatch(between);

            if (plusGroup is not null && !(plusMember[k] && Between(k).Trim() == "+"))
                FlushPlusGroup(section, ref plusGroup);

            if (TemplateKinds.DerivationRelation(t.Name) is { } relation)
            {
                var lang = t.Arg(2);
                if (lang is null)
                    continue;
                var term = InlineTerm.Parse(t.Arg(3) ?? "", allowLangPrefix: false);
                section.ProseSteps.Add(new EtymStep(
                    lang, term.Term, t.Arg(4) ?? term.Mod("alt"), t.Arg(5) ?? t.Param("t", "gloss") ?? term.Mod("t"),
                    relation, null, hedged || term.Flags.Contains("unc"), term.Mod("id") ?? t.Param("id"),
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
                    plusGroup ??= [];
                    plusGroup.Add(new MorphPart(lang, term.Term, gloss, term.Mod("id")));
                    continue;
                }
                var connector = FromOfRegex().Match(between.TrimEnd());
                if (!inAsideClause && connector.Success && term.Term.Length > 0)
                {
                    section.ProseSteps.Add(new EtymStep(
                        lang, term.Term, t.Arg(3), gloss, "from", ConnectorNote(between, connector),
                        hedged, term.Mod("id")));
                }
            }
            else if (TemplateKinds.IsAffix(t.Name))
            {
                if (MorphologyReader.FromTemplate(t) is { } morphology)
                    section.AddMorphology(morphology);
            }
            else if (t.Name == "root" && t.Arg(2) is { } rootLang)
            {
                foreach (var root in t.ArgsFrom(3))
                {
                    var parsed = InlineTerm.Parse(root, allowLangPrefix: false);
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
                ReadEtymon(section, t, langCode);
            }
            else if (TemplateKinds.IsUncertainMarker(t.Name))
            {
                section.Uncertain = true;
            }
        }
        FlushPlusGroup(section, ref plusGroup);
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
                if (keywordFlags.Contains("unc"))
                    section.Uncertain = true;
                morphologyKind = keywordFlags.Contains("surf") ? "surf" : "af";
                continue;
            }

            var term = InlineTerm.Parse(arg, allowLangPrefix: true);
            var termLang = term.Lang ?? lang;
            if (keyword is null || term.Term.Length == 0)
                continue;

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
                    keywordFlags.Contains("unc") || term.Flags.Contains("unc"));
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
            AddEtymonChain(steps, terms[0], terms[0].Lang ?? lang, next, flags.Contains("unc"));
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
        var senses = definitions.Split('\n')
            .Where(line => line.Length > 1 && line[0] == '#' && line[1] is not (':' or '*' or '#'))
            .Select(line => PlainTextRenderer.Render(line[1..], languages))
            .Where(sense => sense.Length > 0)
            .Take(MaxSensesPerPartOfSpeech)
            .ToList();

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
        };
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
                case "trans-top" or "trans-top-also" or "checktrans-top":
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

    // Clauses whose mentions are side remarks, not ancestors: "compare X", "see X", "akin to X", ...
    [GeneratedRegex(@"\b(compare|see|akin|cognate|cognates|related|equivalent|influenced|contrast|unrelated|confer)\b", RegexOptions.IgnoreCase)]
    private static partial Regex AsideRegex();

    [GeneratedRegex(@"\b(probably|possibly|perhaps|maybe|uncertain|unclear|doubtful|unknown)\b", RegexOptions.IgnoreCase)]
    private static partial Regex HedgeRegex();

    [GeneratedRegex(@"(?:^|[\s,;(])(from|of)$", RegexOptions.IgnoreCase)]
    private static partial Regex FromOfRegex();
}
