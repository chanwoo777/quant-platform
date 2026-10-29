"""Headline relevance filter, exercised with headline patterns seen in the live feeds."""

from __future__ import annotations

import csv
from pathlib import Path

import pytest

from quant.config import DEFAULT_ALIASES
from quant.ingestion.relevance import (
    RELEVANCE_THRESHOLD,
    build_aliases,
    clean_company_name,
    is_research_firm,
    relevance_score,
)

LABELS = Path(__file__).parent / "fixtures" / "relevance_labels.csv"


@pytest.mark.parametrize(
    "raw, cleaned",
    [
        ("Apple Inc.", "Apple"),
        ("Amazon.com, Inc.", "Amazon"),
        ("JPMorgan Chase & Co", "JPMorgan Chase"),
        ("NVIDIA CORP", "Nvidia"),
        ("Meta Platforms, Inc.", "Meta Platforms"),
        ("Johnson & Johnson", "Johnson & Johnson"),
        (None, None),
    ],
)
def test_clean_company_name(raw, cleaned):
    assert clean_company_name(raw) == cleaned


def _score(title, ticker, summary=None):
    aliases = build_aliases(ticker, None, DEFAULT_ALIASES.get(ticker, ()))
    return relevance_score(title, summary, ticker, aliases)


@pytest.mark.parametrize(
    "title, ticker, expected",
    [
        ("Apple beats earnings estimates", "AAPL", 1.0),
        ("Apple sees strong iPhone demand into the holidays", "AAPL", 1.0),  # company guidance, not an analyst
        ("$NVDA calls surge ahead of earnings", "NVDA", 1.0),
        ("Johnson & Johnson Beats Estimates, Raises Guidance", "JNJ", 1.0),  # title case is not a list
        ("Stock Market Today, Oct. 16: Apple Edges Higher on iPhone Duo Preorder Surge", "AAPL", 1.0),
        ("UK regulator set to push Apple to open iPhone payment tech", "AAPL", 0.75),
        ("JPMorgan upgrades Tesla to overweight", "TSLA", 0.75),
        ("Dow Jones, Nasdaq, S&P 500 preview: All eyes on Meta, Tesla, SpaceX earnings", "META", 0.4),
        ("Dow Jones, Nasdaq, S&P 500 preview: All eyes on Meta, Tesla, SpaceX earnings", "TSLA", 0.4),
        ("Why Did AAPL, KO, PM Stocks Jump To 52-Week Highs Today?", "AAPL", 0.4),
        ("Biggest stock movers Tuesday: SIX, MU, JNJ, and more", "JNJ", 0.4),
        ("B&M falls 3% as J.P. Morgan puts it on negative watch before results", "JPM", 0.15),
        ("JPMorgan upgrades Tesla to overweight", "JPM", 0.15),
        ("Goldman's strategists see S&P 500 at 7,500", "JPM", 0.0),
        ("Metaverse hype fades as headsets stall", "META", 0.0),  # word boundary + case-sensitive ticker
        ("Stocks rise pre-bell as traders prepare for busy earnings week", "TSLA", 0.0),
    ],
)
def test_relevance_score(title, ticker, expected):
    assert _score(title, ticker) == expected


@pytest.mark.parametrize(
    "title, ticker, expected",
    [
        # name variants
        ("Johnson &Johnson Stock Earnings: Can a Spinoff Fix Its Medtech Problem", "JNJ", 1.0),
        ("Johnson and Johnson Stock Plunges 6% As Medical Device Sales Miss", "JNJ", 1.0),
        ("JPMorganChase Declares Preferred Stock Dividends", "JPM", 1.0),
        # boilerplate: about the company, but not news
        ("Apple (AAPL) Stock Forecast and Price Target 2026 $AAPL", "AAPL", 0.0),
        ("XOM Stock Price Prediction 2026-2027 | Exxon Mobil Forecast", "XOM", 0.0),
        ("Alphabet (GOOGL) Stock Quotes, Company News And Chart Analysis", "GOOGL", 0.0),
        ("TSLA 261016 375.00P (TSLA261016P375000) Stock Options Chain | Quotes & News", "TSLA", 0.0),
        ("Apple Overview", "AAPL", 0.0),
        ("JPMorgan Chase & Co. $JPM Stock: Thurston Springer Miller Herd & Titak Inc. Lowers Stake", "JPM", 0.0),
        ("Amazon.com, Inc. $AMZN Stock Sold by Westwind Capital", "AMZN", 0.0),
        ("ETFs Are Net Sellers of Microsoft (MSFT) on Oct. 15", "MSFT", 0.0),
        ("Microsoft (MSFT) officer Amy Coleman reports 32 shares delivered or withheld at $533.69 each.", "MSFT", 0.0),
        # ...but real articles with similar words stay
        ("Alphabet (GOOGL) Stock Price Forecast 2026: Cloud Hit $20B But FCF Collapsed — Buy or Short?", "GOOGL", 1.0),
        ("Apple Stock Price Prediction: Wall Street's Next Big Surprise Could Be Closer Than You Think", "AAPL", 1.0),
        # another company is the subject
        ("Could Shopify Stock Repeat Amazon's Run Since 2007?", "AMZN", 0.4),
        ("Intel Shares Rise Nearly 4% Following JPMorgan Upgrade and Tesla Foundry Agreement", "TSLA", 0.4),
        ("Nvidia-Backed CoreWeave's Stock Plunges Amid Worries About AI Debt", "NVDA", 0.15),
        ("U.S. Stock Market Movers | Reports Suggest Microsoft (MSFT.US) to Deploy Its Own AI Chips", "MSFT", 0.75),
        # previews and roundups
        ("Meta and Musk earnings and September pending home sales: What to Watch", "META", 0.4),
        ("A big 'yikes' still hangs over the AI trade as Meta and Tesla report: What to watch this week", "TSLA", 0.4),
        ("The Week That Proved AI Is Real: MSFT +16%, AMZN +10%, META -10%, AAPL -4%", "MSFT", 0.4),
        ("Earnings Preview: What to Expect From Apple's Report", "AAPL", 0.75),  # single-company preview stays
    ],
)
def test_tuned_rules(title, ticker, expected):
    assert _score(title, ticker) == expected


@pytest.mark.parametrize(
    "title, expected",
    [
        ("Alphabet Stock Can Soar 22%, J.P. Morgan Says.", 0.15),
        ('U.S. economy is "booming," JPMorgan’s Dimon says', 0.15),
        ("JPM names best and worst-positioned European Building Materials stocks for Q3", 0.15),
        ("KinderCare to Participate in J.P. Morgan’s 2026 Ultimate Services Investor Conference", 0.15),
        ("JPMorgan profit misses analyst estimates as Jamie Dimon warns of risks", 1.0),
    ],
)
def test_bank_named_as_research_source(title, expected):
    aliases = build_aliases("JPM", None, DEFAULT_ALIASES["JPM"])
    assert relevance_score(title, None, "JPM", aliases, source_firm=True) == expected


def test_source_rule_only_applies_to_research_firms():
    # "Apple says ..." is Apple's own news, not a research attribution
    assert _score("Services revenue hit a record, Apple says", "AAPL") == 0.75
    assert is_research_firm("6021") and is_research_firm(6211) and not is_research_firm("3571")


def test_hand_labelled_headlines_regression():
    """540 real headlines (2026-10-12..19), labelled by hand; see the fixture's header."""
    with LABELS.open(encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    preds, labels = [], []
    for row in rows:
        t = row["ticker"]
        aliases = build_aliases(t, None, DEFAULT_ALIASES.get(t, ()))
        preds.append(relevance_score(row["title"], None, t, aliases, source_firm=t == "JPM") >= RELEVANCE_THRESHOLD)
        labels.append(row["label"] == "1")
    tp = sum(p and lab for p, lab in zip(preds, labels))
    precision = tp / sum(preds)
    recall = tp / sum(labels)
    assert precision >= 0.97 and recall >= 0.98, (precision, recall)


def test_two_company_headline_is_still_relevant_to_both():
    title = "Apple, Google face EU probe over app store fees"
    assert _score(title, "AAPL") >= RELEVANCE_THRESHOLD
    assert _score(title, "GOOGL") >= RELEVANCE_THRESHOLD


def test_summary_only_mention_is_below_threshold():
    score = _score("Alphabet looks better by the day", "AMZN", summary="...unlike Amazon, which...")
    assert score == 0.3 and score < RELEVANCE_THRESHOLD


def test_sec_name_extends_curated_aliases():
    aliases = build_aliases("ACME", "ACME WIDGETS CORP")
    assert aliases == ("Acme Widgets",)
    assert relevance_score("Acme Widgets recalls 1M units", None, "ACME", aliases) == 1.0
