"""Company-name relevance filter for headlines.

Keyword RSS searches ("AAPL stock") return plenty of stories that only mention a
company in passing. Each headline gets a relevance score in [0, 1]:

  1.00  the company (alias or ticker) is the subject, named early in the headline.
        A roundup prefix such as "Stock Market Today, Oct. 16:" is skipped first.
  0.75  named later in the headline ("UK regulator set to push Apple to ...")
  0.40  one of several names in a list ("All eyes on Meta, Tesla, SpaceX earnings"),
        paired in a preview ("Meta and Tesla report: what to watch"), late in a
        market roundup, or another company leads ("Intel Shares Rise ... Tesla Deal")
  0.30  named only in the summary
  0.15  named only in passing: as the analyst ("... as J.P. Morgan puts it on
        negative watch"), as a bank's research view ("..., J.P. Morgan Says") or as
        a modifier ("Nvidia-Backed CoreWeave ...")
  0.00  not named, or boilerplate rather than news (quote/forecast pages, options
        chains, 13F holding, ETF-flow and Form 4 notices)

Headlines scoring >= RELEVANCE_THRESHOLD count as being about the company.
Rules are checked against hand-labelled headlines in tests/fixtures/relevance_labels.csv.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from functools import lru_cache

RELEVANCE_THRESHOLD = 0.5
SUBJECT_POSITION = 0.35  # alias starting within the first 35% of the headline = subject

_LEGAL_SUFFIXES = {
    "inc", "incorporated", "corp", "corporation", "co", "company", "ltd", "limited", "plc",
    "holdings", "holding", "group", "sa", "nv", "ag", "lp", "llc", "the",
}

# Pages and machine-generated notices that are about a company but aren't news.
# Also used at ingestion to skip them entirely.
BOILERPLATE_RE = re.compile(
    r"""
      \bstock\s+quotes?\b
    | \boptions\s+chain\b
    | \bquote\s*(?:&|and)\s*(?:news|history)\b
    | \bprice,\s*news,\s*quote\b
    | \bstock\s+price\s+today\b
    | \b(?:price|quotes?|forecast|news|history|chart)(?:\s*(?:,|&|and)\s*(?:price|quotes?|forecast|news|history|chart)){2,}\b
    | \bstock\s+(?:price\s+)?(?:forecasts?|predictions?)\b(?=\s*(?:$|[.|&]|and\b|for\b|\d{4}(?:-\d{4})?\s*(?:$|[|$])))
    | ^\S+(?:\s\S+)?\s+overview$
    | \$[A-Z.]+\s+(?:stock|shares)\b.{0,90}?\b(?:(?:bought|sold|purchased|acquired)\s+by|position|stake|holdings)\b
    | \bfund\s+update:
    | \bshares\s+delivered\s+or\s+withheld\b
    | \betfs?\s+(?:bought|sold|are\s+(?:buying|selling|net\s+(?:buyers|sellers)))\b
    | \b\d+\s+etfs?\s+add\b
    | \bnet\s+etf\s+(?:buying|selling)\b
    | \b(?:etf|spdr)\b[^.]{0,40}?\badds\b
    """,
    re.IGNORECASE | re.VERBOSE,
)

# Analyst language right after a name means the firm is the *source*, not the subject.
_ANALYST_ACTION_RE = re.compile(
    r"""^\W*(?:['’]s\s+)?(?:
        (?:upgrades?|downgrades?)\b[^.:;]{0,50}?\b(?:to|at)\s+
            (?:buy|sell|hold|neutral|overweight|underweight|outperform|underperform|market\s+perform|equal[-\s]weight|strong\s+buy)
      | initiates?\s+(?:coverage|at|with)
      | reiterates?\s+(?:buy|sell|hold|overweight|underweight|outperform|neutral|rating)
      | resumes\s+coverage
      | puts\b[^.:;]{0,40}?\bwatch
      | (?:raises|cuts|lifts|lowers|trims|boosts)\s+(?:its\s+|the\s+)?(?:price\s+)?target
      | (?:strategists?|economists?)\b
      | rates\s
    )""",
    re.IGNORECASE | re.VERBOSE,
)
# For banks and brokers, "<firm> says / sees / names ..." is almost always research,
# and "<firm>'s ... conference" is the venue. Applied only when source_firm=True.
_SOURCE_FIRM_RE = re.compile(
    r"""^\W*(?:['’]s\s+(?:[\w.]+\s+){0,2}?)?(?:says|said|sees|predicts|warns|names|picks|likes|prefers
            |recommends|analysts?|research|top\s+picks)\b
      | ^['’]s\s+(?:\d{4}\s+)?[^.:;]{0,60}?\b(?:conference|summit|forum)\b""",
    re.IGNORECASE | re.VERBOSE,
)
_MODIFIER_RE = re.compile(r"^-(?:backed|owned|linked|supported|funded|led)\b", re.IGNORECASE)

_ROUNDUP_RE = re.compile(
    r"\b(?:dow\s+jones|s&p\s*500|nasdaq\s+composite|stock\s+market\s+today|stocks?\s+to\s+watch|"
    r"premarket\s+movers|biggest\s+(?:stock\s+)?movers|making\s+the\s+biggest\s+moves|"
    r"magnificent\s+seven|mag\s*7|market\s+wrap|stock\s+futures)\b",
    re.IGNORECASE,
)
# Week-ahead previews: a company paired with others here is one item on a calendar.
_PREVIEW_RE = re.compile(
    r"\b(?:what\s+to\s+watch|things\s+to\s+watch|week\s+ahead|investors\s+to\s+(?:monitor|watch)|"
    r"earnings\s+to\s+watch|stocks\s+that\s+explain|winners,?\s+(?:and\s+)?losers)\b",
    re.IGNORECASE,
)
# "Intel Shares Rise ...", "Could Shopify Stock Repeat ...": another name leads as the stock in focus.
_GENERIC_LEADS = {"u.s.", "us", "ai", "tech", "chip", "bank", "energy", "oil", "growth", "value", "dividend",
                  "ev", "china", "chinese", "global", "world", "market", "big", "top", "best", "this", "these",
                  "that", "which", "what", "my", "your", "new", "why", "how"}
_LEAD_STOCK_RE = re.compile(
    r"^(?:(?i:could|should|will|can|is|are|why|how|does|did|has)\s+)?(?:(?i:the)\s+)?"
    r"([A-Z][\w.&'’-]*(?:\s+[A-Z][\w.&'’-]*){0,2})\s+(?i:stock|shares)\b"
)

# A name counts as "listed" when it sits in a run of >= 3 single-word names:
# "Meta, Tesla, SpaceX", "SIX, MU, JNJ, and more", "MSFT +16%, AMZN +10%, META -10%".
_PCT = r"(?:\s+[+\-−]?\d+(?:\.\d+)?%)?"
_NAME = rf"[A-Z$][\w$.'’-]*{_PCT}"
_SEP = r"(?:\s*,\s*(?:and\s+|&\s+)?|\s+(?:and|&)\s+)"
_LIST_FIRST_RE = re.compile(rf"^{_PCT}{_SEP}{_NAME}{_SEP}{_NAME}")
_LIST_BEFORE_RE = re.compile(rf"{_NAME}{_SEP}$")
_LIST_AFTER_RE = re.compile(rf"^{_PCT}{_SEP}{_NAME}")
_LIST_LAST_RE = re.compile(rf"{_NAME}{_SEP}{_NAME}{_SEP}$")
_PAIRED_BEFORE_RE = re.compile(r"[A-Z$][\w$.'’-]*(?:\s*,|\s+(?:and|&))\s*$")
_PAIRED_AFTER_RE = re.compile(r"^[^,.:;]{0,12}?(?:,\s*|\s+(?:and|&)\s+)[A-Z$]")


def clean_company_name(name: str | None) -> str | None:
    """'Amazon.com, Inc.' -> 'Amazon'; 'JPMorgan Chase & Co' -> 'JPMorgan Chase'."""
    if not name:
        return None
    tokens = re.sub(r"[,.]", " ", re.sub(r"\.com\b", "", name, flags=re.IGNORECASE)).split()
    while tokens and (tokens[-1].lower() in _LEGAL_SUFFIXES or tokens[-1] == "&"):
        tokens.pop()
    cleaned = " ".join(tokens)
    return cleaned.title() if cleaned.isupper() else cleaned or None


def build_aliases(ticker: str, company_name: str | None, curated: Iterable[str] = ()) -> tuple[str, ...]:
    names = [*curated, clean_company_name(company_name)]
    return tuple(dict.fromkeys(n for n in names if n and len(n) >= 2))


def is_research_firm(sic: str | int | None) -> bool:
    """Banks, credit institutions and brokers (SIC 6000-6299) publish research that
    headlines attribute to them ("..., J.P. Morgan says")."""
    try:
        return 6000 <= int(sic) <= 6299
    except (TypeError, ValueError):
        return False


def _alias_regex(alias: str) -> str:
    # "Johnson & Johnson" also matches "Johnson and Johnson" and "Johnson &Johnson".
    parts = [r"\s+".join(map(re.escape, part.split())) for part in alias.split("&")]
    return r"\s*(?:&|and)\s*".join(p for p in parts if p)


@lru_cache(maxsize=256)
def _alias_pattern(aliases: tuple[str, ...]) -> re.Pattern | None:
    if not aliases:
        return None
    alts = "|".join(_alias_regex(a) for a in sorted(aliases, key=len, reverse=True))
    return re.compile(rf"(?<![\w&])(?:{alts})(?![\w&])", re.IGNORECASE)


@lru_cache(maxsize=256)
def _ticker_pattern(ticker: str) -> re.Pattern:
    # Case-sensitive so the ticker "META" doesn't match the word "meta".
    return re.compile(rf"(?<![A-Za-z0-9])\$?{re.escape(ticker)}(?![A-Za-z0-9])")


def _mentions(text: str, ticker: str, aliases: tuple[str, ...]) -> list[re.Match]:
    matches = list(_ticker_pattern(ticker).finditer(text))
    pattern = _alias_pattern(aliases)
    if pattern:
        matches += pattern.finditer(text)
    return sorted(matches, key=lambda m: m.start())


def _strip_roundup_prefix(title: str, ticker: str, aliases: tuple[str, ...]) -> tuple[str, bool]:
    """'Stock Market Today, Oct. 16: Apple Edges Higher' -> 'Apple Edges Higher'. A prefix
    that names the company itself ('Tesla Stock vs. the S&P 500: ...') is kept."""
    head, sep, rest = title.partition(":")
    if sep and rest.strip() and _ROUNDUP_RE.search(head) and not _mentions(head, ticker, aliases):
        return rest.lstrip(), True
    return title, False


def _is_listed(text: str, match: re.Match) -> bool:
    before, after = text[: match.start()], text[match.end():]
    return bool(
        _LIST_FIRST_RE.search(after)
        or (_LIST_BEFORE_RE.search(before) and _LIST_AFTER_RE.search(after))
        or _LIST_LAST_RE.search(before)
    )


def _is_paired(text: str, match: re.Match) -> bool:
    return bool(_PAIRED_BEFORE_RE.search(text[: match.start()]) or _PAIRED_AFTER_RE.match(text[match.end():]))


def _in_passing(text: str, match: re.Match, source_firm: bool) -> bool:
    after = text[match.end():]
    return bool(
        _ANALYST_ACTION_RE.match(after)
        or _MODIFIER_RE.match(after)
        or (source_firm and _SOURCE_FIRM_RE.match(after))
    )


def relevance_score(
    title: str, summary: str | None, ticker: str, aliases: tuple[str, ...], source_firm: bool = False
) -> float:
    title = title if isinstance(title, str) else ""
    summary = summary if isinstance(summary, str) else None  # pandas may hand us NaN
    if BOILERPLATE_RE.search(title):
        return 0.0
    body, had_roundup_prefix = _strip_roundup_prefix(title, ticker, aliases)
    hits = _mentions(body, ticker, aliases)
    subject_hits = [m for m in hits if not _in_passing(body, m, source_firm)]

    if subject_hits:
        first = subject_hits[0]
        lead = _LEAD_STOCK_RE.match(body)
        if (
            _is_listed(body, first)
            or (_PREVIEW_RE.search(title) and _is_paired(body, first))
            or (lead and lead.group(1).split()[0].lower() not in _GENERIC_LEADS
                and not _mentions(lead.group(1), ticker, aliases))
        ):
            return 0.4
        if first.start() / max(len(body), 1) <= SUBJECT_POSITION:
            return 1.0
        return 0.4 if had_roundup_prefix or _ROUNDUP_RE.search(body) or _PREVIEW_RE.search(body) else 0.75
    if hits:
        return 0.15
    if summary and _mentions(summary, ticker, aliases):
        return 0.3
    return 0.0


def is_relevant(score: float | None, threshold: float = RELEVANCE_THRESHOLD) -> bool:
    return score is not None and score >= threshold
