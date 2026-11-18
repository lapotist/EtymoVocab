"""Builds src/EtymoVocab.Web/wwwroot/data/en-frequency.txt: the most frequent English words, one per line,
most frequent first (line number = rank). The site uses it only to order word-family lists.

    python -m venv .venv && .venv/bin/pip install wordfreq==3.1.1
    .venv/bin/python tools/frequency/build_en_frequency.py

Data: wordfreq (https://github.com/rspeer/wordfreq), CC BY-SA 4.0; see the generated folder's README.md.
"""
import sys
import unicodedata
from importlib.metadata import version
from pathlib import Path

import wordfreq

EXPECTED_VERSION = "3.1.1"  # wordfreq's data is frozen; pin it so rebuilds are reproducible
WORDS = 50_000


def is_word(token: str) -> bool:
    """Lowercase letters (Unicode Ll, so accents are fine) with inner apostrophes or hyphens.

    Drops numbers, symbols and "other letters" such as "ツ" or "º", which are not English words.
    """
    return (token[0].isalpha() and token[-1].isalpha()
            and all(c in "'-" or unicodedata.category(c) == "Ll" for c in token))


if version("wordfreq") != EXPECTED_VERSION:
    sys.exit(f"wordfreq {EXPECTED_VERSION} required, found {version('wordfreq')}")

words = []
for word in wordfreq.top_n_list("en", WORDS * 2, wordlist="best"):
    if is_word(word):
        words.append(word)
        if len(words) == WORDS:
            break

out = Path(__file__).resolve().parents[2] / "src/EtymoVocab.Web/wwwroot/data/en-frequency.txt"
out.write_text("\n".join(words) + "\n", encoding="utf-8")
print(f"wrote {len(words)} words to {out} ({out.stat().st_size} bytes); first: {words[:8]}")
