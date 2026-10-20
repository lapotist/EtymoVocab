# Test fixtures

Raw wikitext of English Wiktionary pages, used so parser tests run offline and deterministically.
`manifest.json` records each page's title, revision ID and timestamp. You can view a revision at
`https://en.wiktionary.org/w/index.php?oldid=<revisionId>`.

Content © Wiktionary contributors, licensed under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). These files are unmodified copies.

To refresh a fixture, fetch the page again and update `manifest.json`. Tests that assert on specific
etymology details may need updating too, because the pages change over time.
