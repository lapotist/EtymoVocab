# Reverse etymology discovery index

This index finds candidate English words that mention the same source entry in explicit etymology templates. It is a discovery aid, not a list of verified common-origin relationships. The browser must fetch a candidate's current Wiktionary entry and compare qualified origin identities before adding a relationship to the graph. Spelling alone is insufficient to identify a historical word or a homograph.

## Source and attribution

The generated files in `src/EtymoVocab.Web/wwwroot/data/etymology-index/` are derived from [Kaikki's English Wiktionary extraction](https://kaikki.org/dictionary/English/index.html), using its [English JSONL gzip download](https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl.gz). The initial input was extracted on 2026-10-21 from the 2026-10-01 English Wiktionary dump. This is a snapshot; the download URL changes when Kaikki publishes a new extraction.

Dictionary data is © Wiktionary contributors, licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/); see [Wiktionary's copyright notice](https://en.wiktionary.org/wiki/Wiktionary:Copyrights). The generated index adapts that data under the same license. Kaikki / Wiktextract provides the machine-readable extraction. The builder code remains under the repository's Apache-2.0 license.

The manifest records the exact input SHA256, dataset URL, dump and extraction dates, attribution and license. Kaikki entries do not reliably include a source revision ID; the snapshot is therefore not presented as a pinned Wiktionary revision. Current-entry verification supplies revision links for graph evidence.

## Initial generated snapshot

The 2026-10-21 input is 534,135,938 compressed bytes, SHA256 `cabb3a13b7179d5f8c5909e06b1dcd2e2ae6465d05f35de56509a5b4e2bf0a49`.

The builder read 1,499,161 JSONL records and generated 405,105 distinct candidate words, 223,252 source-entry buckets and 825,160 distinct source-to-word pairs. The 256 shards total 17,354,710 bytes (about 16.6 MiB); their mean size is 67,792 bytes and the largest is 393,731 bytes. Browsers fetch only the buckets needed for a query, not the complete index.

Of the input records, 536,684 were explicitly inflection-only, 478,942 had no etymology templates, and 612 had invalid/unsupported word titles. There were 443,927 records contributing an edge before deduplication across parts of speech and etymologies. Unsupported or non-etymological template occurrences numbered 167,834; 36,497 source references used languages outside the current registry, and 18,795 source references had missing or unusable terms. These counts identify parser coverage limits, not errors in the source dictionary.

The generated build ID is `47179d263bfc830a07a04d1ac4772a2adea7b97124edb56f7862cbcbfbce3755`. All 256 shard hashes, bucket assignments and aggregate counts were also checked with the browser's JavaScript hash implementation. A real generated bucket for Latin `panis` proposes `pantry` for a query with `panis` as a trusted origin; the UI still must validate that relationship against current entries.

## Rebuild

With .NET 10 installed and a complete English JSONL or `.jsonl.gz` file downloaded locally:

```bash
dotnet run --project tools/EtymoVocab.IndexBuilder --configuration Release -- \
  --input /path/to/kaikki.org-dictionary-English.jsonl.gz \
  --output src/EtymoVocab.Web/wwwroot/data/etymology-index \
  --source-url https://kaikki.org/dictionary/English/kaikki.org-dictionary-English.jsonl.gz \
  --dump-date 2026-10-01 \
  --extracted-at 2026-10-21
```

Use the dates published for the downloaded extraction when updating. The builder reads gzip and JSONL incrementally; it never loads the multi-gigabyte source document as one object. It keeps only distinct origin-to-word pairs in memory. A malformed input aborts without replacing the manifest. Source hashing and the complete input scan happen before output publication.

Outputs are deterministic for the same input, source metadata and builder version. The builder reuses intact shards and publishes each new or repaired shard by atomic rename. It replaces the manifest after all its shards are ready. Shard filenames contain their full SHA256. Older generated shards are retained by the builder so existing readers of an old manifest can finish; remove unreferenced shards only when preparing a clean publication, not during an active build. CI tests the builder using tiny synthetic inputs rather than downloading the dataset on every build.

## Inclusion rules

- English records only; case and canonical Unicode are preserved.
- Records whose every sense is explicitly an inflection are skipped; records with at least one independent sense remain eligible.
- Read only supported explicit inheritance/borrowing/derivation, root, word-formation and `etymon`/`ety` templates. Process each extracted template independently; adjacent templates are not reconstructed into an invented prose chain.
- Exclude semantic relation fields, cognate/comparison/mention templates, arbitrary links, and nontransitive calque/semantic-loan relations.
- Normalize source languages and page titles with the same Core language registry and entry-title rules as live lookups, including Latin macron removal and reconstruction page titles. Unknown languages are counted and excluded.
- Aggregate distinct English words per source-entry key. Multiple parts of speech and numbered etymologies may propose the same word only once. The snapshot does not resolve homograph identity or prove that a candidate's current etymology still matches.
- No transitive closure and no prefix/substring matching. Candidate lists are not silently truncated. Broad affixes may have large lists; the UI chooses which anchors to search and verifies current evidence.

Unsupported templates, excluded records and ignored source references are counted in `manifest.statistics`. Reading a full English extraction does not mean that every English word or every etymological relationship is covered.

## Browser format

`manifest.json` has `schemaVersion: 1`, `buildId`, `source`, counts, coverage text, statistics and 256 `shards` entries. Each entry has `file`, `sha256` and `bytes`; files use `<two-digit-shard>-<full-sha256>.json`.

A shard is `{ "schemaVersion": 1, "origins": { "<key>": ["word", "…"] } }`. The coarse key is JavaScript `JSON.stringify([entryLanguageCode, snapshotPageTitle])`, preserving case and NFC. Discovery checks the resolved title and its known redirect titles, since a snapshot template can use an older spelling. Verification compares the resolved entry and its etymology ID. The shard number is the low byte of FNV-1a over the key's UTF-8 bytes, formatted as two lowercase hexadecimal digits. Candidate arrays and origin keys use ordinal sorting. No arbitrary URL from the data controls the shard path.

The browser checks the response SHA256 before consuming a shard. This prevents a stale or mixed deployment from joining a manifest to the wrong candidate data. The coarse index key deliberately lacks etymon IDs: current lookup uses separate qualified identity keys, and only those can establish the displayed relationship.
