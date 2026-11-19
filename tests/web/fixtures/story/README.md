# Word-story fixtures

These are complete `WordResult` JSON objects returned by the in-browser engine (`engine.lookupWord`)
for nice, father, inspect, transport and hotel. They were captured on 2026-11-16 from live English
Wiktionary lookups. Each file's `source.revisionId` identifies the page revision it was read from.

Content © Wiktionary contributors, licensed under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

The tests assert on specific glosses. If you recapture a fixture after the page changes, update the
tests in `tests/web/word-story.test.mjs` as well.
