"""
Mapping an answer onto the option strings a widget actually offers.

Lifted out of ``routers/fill.py`` unchanged so the deterministic resolvers
(``derived_facts``) and the answer gate (``answer_gate``) can share it without
importing the router. ``fill.py`` re-exports ``match_option`` under its old
private name, so its existing callers and tests are untouched.

The tiers mirror the extension's ``matchOption`` (writeEngine.ts) on purpose:
the backend and the page must agree on what "this answer fits that option"
means, or the backend hands down a value the widget then refuses.
"""

import re
from typing import Optional


def first_number(text: str) -> Optional[float]:
    """The first number (comma thousands-separators tolerated) in text, or None."""
    m = re.search(r"\d+(?:\.\d+)?", text.replace(",", ""))
    return float(m.group()) if m else None


def parse_range(text: str) -> Optional[tuple[float, float]]:
    """Parse a bucketed-range option ("2-3 years", "$90,000-$110,000", "6+
    years", "Under 1 year") into an inclusive (min, max) — Infinity for an
    open end — or None when the text isn't a recognizable numeric range."""
    cleaned = re.sub(r"[,$€£¥]", "", text)
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:-|to|–|—)\s*(\d+(?:\.\d+)?)", cleaned, re.IGNORECASE)
    if m:
        return float(m.group(1)), float(m.group(2))
    m = re.search(r"(\d+(?:\.\d+)?)\s*\+", cleaned)
    if m:
        return float(m.group(1)), float("inf")
    m = re.search(r"(?:under|less than|<)\s*(\d+(?:\.\d+)?)", cleaned, re.IGNORECASE)
    if m:
        return float("-inf"), float(m.group(1))
    return None


def shared_prefix_len(a: str, b: str) -> int:
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return i


def match_option(answer: str, options: list[str]) -> str | None:
    """Match answer text to one of the available options, returning the option
    VERBATIM (never a rewrite of it) or None."""
    a = answer.lower().strip()
    for opt in options:
        if opt.lower().strip() == a:
            return opt
    a_words = [w for w in re.split(r"[^a-z0-9]+", a) if w]
    for opt in options:
        o = opt.lower().strip()
        if len(a_words) <= 1:
            # Single-word answers must match a whole word of the option —
            # "cat" must never fuzzy-match "category" (mirrors the extension's
            # matchOption in writeEngine.ts).
            if a_words and a_words[0] in re.split(r"[^a-z0-9]+", o):
                return opt
        elif o in a or a in o:
            return opt
    # Bucketed numeric options ("2-3 years", "$90,000-$110,000") share no
    # literal substring with a conversational answer ("about 3 years") even
    # though the AI is told to answer with exact option text — check whether
    # the answer's number actually falls inside an option's range.
    target_num = first_number(answer)
    if target_num is not None:
        for opt in options:
            rng = parse_range(opt)
            if rng and rng[0] <= target_num <= rng[1]:
                return opt
    # A bucketed-range option set the range tier couldn't place the answer in
    # must fail here: the buckets normalize to the same tokens ("years", "000"),
    # so token overlap would just pick the first bucket — confidently wrong.
    if sum(1 for opt in options if parse_range(opt) is not None) >= 2:
        return None
    # Morphological near-miss: a >=5-char shared token prefix ("canada" ↔
    # "canadian"). Mirrors the extension's matchOption tier (writeEngine.ts).
    answer_tokens = [w for w in re.split(r"[^a-z0-9]+", a) if len(w) > 2]
    best: tuple[str, float] | None = None
    for opt in options:
        tokens = [w for w in re.split(r"[^a-z0-9]+", opt.lower()) if len(w) > 2]
        if not tokens:
            continue
        overlap = sum(
            1 for w in tokens
            if any(shared_prefix_len(w, t) >= 5 or w == t for t in answer_tokens)
        )
        # Incidental overlap must not select: one shared generic token scores
        # 0.5 on a two-token option ("University of Ottawa" → "University of
        # Oklahoma"). Require two shared tokens, or a fully-covered
        # single-token option ("Canadian") — writeEngine/pickOption parity.
        score = overlap / len(tokens)
        if score < 0.5 or (overlap < 2 and score != 1):
            continue
        if best is None or score > best[1]:
            best = (opt, score)
    if best:
        return best[0]
    return None


# ── Yes/No onto prose options ────────────────────────────────────────────────

# Cues that make an option a NEGATIVE answer. Checked first: "No, I am not 18
# years of age or older" carries the affirmative cue "or older" too, and only
# the negation tells the two options apart.
_NEGATIVE_CUES = (
    r"^\s*no\b", r"\bnot\b", r"\bn['’]t\b", r"\bunder\b", r"\bbelow\b",
    r"\bless than\b", r"\bunable\b", r"\bdecline\b", r"\bnone\b", r"\bnever\b",
)
_AFFIRMATIVE_CUES = (
    r"^\s*yes\b", r"\bat least\b", r"\bor older\b", r"\bor above\b", r"\bor over\b",
    r"\bover\b", r"\bi am\b", r"\bi do\b", r"\bi have\b", r"\bconfirm\b",
    r"\bcertify\b", r"\bagree\b", r"\btrue\b",
)

_NEGATIVE_RE = re.compile("|".join(_NEGATIVE_CUES), re.IGNORECASE)
_AFFIRMATIVE_RE = re.compile("|".join(_AFFIRMATIVE_CUES), re.IGNORECASE)


def option_polarity(option: str) -> bool | None:
    """True for an option that reads as "yes", False for "no", None when the
    text carries no polarity at all ("Prefer not to say", "Select One")."""
    text = option.strip()
    if not text:
        return None
    if _NEGATIVE_RE.search(text):
        return False
    if _AFFIRMATIVE_RE.search(text):
        return True
    return None


def match_boolean_option(value: bool, options: list[str]) -> str | None:
    """The one option that expresses `value`, or None when that is ambiguous.

    A computed yes/no is worthless if the widget words its choices as
    "I am 18 years of age or older" / "I am under 18 years of age" — a literal
    "Yes" matches neither. This reads each option's polarity and returns the
    single option of the wanted polarity, VERBATIM.

    Deliberately refuses when more than one option shares that polarity: two
    ways to say yes means the question is not the yes/no question we thought it
    was, and picking one would be a guess.
    """
    if not options:
        return None
    direct = match_option("yes" if value else "no", options)
    if direct is not None:
        return direct
    hits = [o for o in options if option_polarity(o) is value]
    return hits[0] if len(hits) == 1 else None
