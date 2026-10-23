"""Financial-news sentiment with FinBERT (ProsusAI/finbert, open source on HuggingFace).

FinBERT is BERT fine-tuned on the Financial PhraseBank; it classifies a
sentence as positive / negative / neutral. We keep all three probabilities and
report ``score = P(positive) - P(negative)`` in [-1, 1].

If torch/transformers are unavailable (or the model download fails) a small
finance lexicon scorer is used instead, so the pipeline never hard-fails. The
``sentiment_model`` column records which scorer produced each score.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Protocol

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Sentiment:
    label: str  # "positive" | "negative" | "neutral"
    score: float  # P(positive) - P(negative), in [-1, 1]
    confidence: float  # probability (or strength) of the winning label


class SentimentScorer(Protocol):
    name: str

    def score(self, texts: list[str]) -> list[Sentiment]: ...


class FinBertScorer:
    def __init__(self, model_name: str = "ProsusAI/finbert", batch_size: int = 16):
        from transformers import pipeline  # heavy import, deferred

        self.name = model_name
        self.batch_size = batch_size
        self._pipe = pipeline("text-classification", model=model_name, top_k=None)

    def score(self, texts: list[str]) -> list[Sentiment]:
        if not texts:
            return []
        outputs = self._pipe(texts, batch_size=self.batch_size, truncation=True, max_length=256)
        results = []
        for scores in outputs:
            probs = {d["label"].lower(): float(d["score"]) for d in scores}
            label = max(probs, key=probs.get)
            results.append(
                Sentiment(
                    label=label,
                    score=probs.get("positive", 0.0) - probs.get("negative", 0.0),
                    confidence=probs[label],
                )
            )
        return results


# Compact subset in the spirit of the Loughran-McDonald financial word lists.
_POSITIVE = {
    "beat", "beats", "surge", "surges", "soar", "soars", "jump", "jumps", "rally", "rallies", "gain",
    "gains", "record", "upgrade", "upgraded", "outperform", "bullish", "growth", "profit", "profitable",
    "strong", "stronger", "raise", "raises", "raised", "boost", "boosts", "exceed", "exceeds", "rebound",
    "rebounds", "optimistic", "buyback", "dividend", "approval", "approved", "wins", "win", "expands",
    "higher", "rise", "rises", "climbs", "tops", "upbeat",
}
_NEGATIVE = {
    "miss", "misses", "plunge", "plunges", "tumble", "tumbles", "slump", "slumps", "drop", "drops",
    "fall", "falls", "loss", "losses", "downgrade", "downgraded", "underperform", "bearish", "weak",
    "weaker", "cut", "cuts", "lawsuit", "probe", "investigation", "recall", "layoffs", "layoff",
    "bankruptcy", "default", "fraud", "decline", "declines", "warning", "warns", "slowdown", "lower",
    "sinks", "sink", "crash", "fears", "fine", "fined", "halt", "halts", "delay", "delays", "selloff",
}
_TOKEN_RE = re.compile(r"[a-z']+")


class LexiconScorer:
    name = "lexicon-fallback"

    def score(self, texts: list[str]) -> list[Sentiment]:
        results = []
        for text in texts:
            tokens = _TOKEN_RE.findall(text.lower())
            pos = sum(t in _POSITIVE for t in tokens)
            neg = sum(t in _NEGATIVE for t in tokens)
            score = (pos - neg) / (pos + neg + 1)
            if score > 0.15:
                label = "positive"
            elif score < -0.15:
                label = "negative"
            else:
                label = "neutral"
            confidence = abs(score) if label != "neutral" else 1.0 - abs(score)
            results.append(Sentiment(label=label, score=score, confidence=confidence))
        return results


@lru_cache(maxsize=2)
def get_scorer(model_name: str = "ProsusAI/finbert", use_finbert: bool = True) -> SentimentScorer:
    if use_finbert:
        try:
            scorer = FinBertScorer(model_name)
            log.info("sentiment model loaded: %s", model_name)
            return scorer
        except Exception as exc:
            log.warning("FinBERT unavailable (%s: %s); falling back to lexicon scorer", type(exc).__name__, exc)
    return LexiconScorer()
