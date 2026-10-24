"""The website's quant.js must agree with the Python models (run through Node.js if installed)."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from quant import analytics as an
from quant import quant_models as qm

ROOT = Path(__file__).resolve().parent.parent
QUANT_JS = ROOT / "docs" / "assets" / "quant.js"
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="needs Node.js")


def run_js(tmp_path: Path, body: str, data) -> dict:
    (tmp_path / "data.json").write_text(json.dumps(data), encoding="utf-8")
    script = tmp_path / "run.js"
    script.write_text(
        f"const Q = require({json.dumps(str(QUANT_JS))});\n"
        f"const data = JSON.parse(require('fs').readFileSync({json.dumps(str(tmp_path / 'data.json'))}, 'utf8'));\n"
        f"const out = (() => {{ {body} }})();\n"
        "process.stdout.write(JSON.stringify(out));\n", encoding="utf-8")
    done = subprocess.run([NODE, str(script)], capture_output=True, text=True, encoding="utf-8", check=True)
    return json.loads(done.stdout)


def nan_to_none(values) -> list:
    return [None if v is None or (isinstance(v, float) and np.isnan(v)) else float(v) for v in values]


@pytest.fixture(scope="module")
def synthetic():
    rng = np.random.default_rng(7)
    idx = pd.bdate_range("2022-01-03", periods=900)
    cols = ["mkt_rf", "smb", "hml", "rf", "mom", "smb5", "rmw", "cma"]
    f = pd.DataFrame(rng.normal(0, 0.01, (len(idx), len(cols))), index=idx, columns=cols)
    f["rf"] = 0.0001
    r = 0.0003 + 1.1 * f.mkt_rf + 0.3 * f.smb - 0.2 * f.hml + 0.15 * f.mom + 0.1 * f.rmw + rng.normal(0, 0.012, len(idx))
    r.iloc[[5, 6, 300]] = np.nan  # trading halts
    f.iloc[[50, 51], f.columns.get_loc("hml")] = np.nan  # missing factor prints
    f = f.iloc[:-40]  # the French library lags the price history
    return r.rename("r"), f


def test_factor_regressions_match_python(tmp_path, synthetic):
    r, f = synthetic
    data = {"dates": [f"{d:%Y-%m-%d}" for d in r.index], "returns": nan_to_none(r),
            "factors": {"d": [f"{d:%Y-%m-%d}" for d in f.index], **{c: nan_to_none(f[c]) for c in f}}}
    js = run_js(tmp_path, """
        const stock = { dates: data.dates, returns: data.returns }, out = {};
        for (const m of ["FF3", "Carhart", "FF5"]) out[m] = { fit: Q.factorRegression(stock, data.factors, m), roll: Q.rollingExposures(stock, data.factors, m) };
        return out;""", data)
    for model in ("FF3", "Carhart", "FF5"):
        py = qm.factor_regression(r, f, qm.MODELS[model], ticker="X")
        fit = js[model]["fit"]
        assert fit["n_obs"] == py.n_obs and fit["start"] == f"{py.start}" and fit["end"] == f"{py.end}"
        assert fit["alpha_annual"] == pytest.approx(py.alpha_annual, rel=1e-6)
        assert fit["alpha_t"] == pytest.approx(py.alpha_t, rel=1e-6)  # Newey-West, 5 lags, n/(n-k)
        assert fit["r_squared"] == pytest.approx(py.r_squared, rel=1e-9)
        assert fit["idio_vol_annual"] == pytest.approx(py.idio_vol_annual, rel=1e-9)
        for k in qm.MODELS[model]:
            assert fit["betas"][k] == pytest.approx(py.betas[k], rel=1e-7)
            assert fit["t_stats"][k] == pytest.approx(py.t_stats[k], rel=1e-6)
            assert fit["variance_share"][k] == pytest.approx(py.variance_share[k], rel=1e-6, abs=1e-12)
            assert fit["return_attribution"][k] == pytest.approx(py.return_attribution[k], rel=1e-6, abs=1e-12)
        assert fit["tilts"] == py.tilts and fit["dominant_driver"] == py.dominant_driver
        roll = qm.rolling_exposures(r, f, qm.MODELS[model])
        assert js[model]["roll"]["d"] == [f"{d:%Y-%m-%d}" for d in roll.index]
        for k in qm.MODELS[model]:
            assert js[model]["roll"][k] == pytest.approx(roll[k].tolist(), rel=1e-7)


def test_indicators_match_python(tmp_path):
    rng = np.random.default_rng(3)
    close = pd.Series(100 * np.cumprod(1 + rng.normal(0.0005, 0.015, 300)), index=pd.bdate_range("2025-01-01", periods=300))
    ref = an.add_indicators(pd.DataFrame({"open": close, "high": close, "low": close, "close": close, "adj_close": close,
                                          "volume": 1.0}))
    js = run_js(tmp_path, "return { sma: Q.sma(data, 50), rsi: Q.rsi(data, 14), bb: Q.bollinger(data, 20, 2) };", close.tolist())
    assert js["sma"][-1] == pytest.approx(ref.sma_50.iloc[-1])
    assert js["rsi"][-1] == pytest.approx(ref.rsi_14.iloc[-1], abs=0.5)
    assert js["bb"]["upper"][-1] == pytest.approx(ref.bb_upper.iloc[-1], rel=1e-6)


def test_backtest_has_no_lookahead_and_counts_trades(tmp_path):
    # A strategy that "knows" tomorrow's winner would earn ~100%/day if the engine leaked
    # returns. With W[t] applied to R[t+1] it can only earn what yesterday's choice earns.
    data = {"P": [[100, 100], [110, 90], [99, 99], [108.9, 89.1], [98, 98]], "dates": [f"2026-01-0{i + 1}" for i in range(5)]}
    js = run_js(tmp_path, """
        const peek = { weights: (P) => ({ W: P.map((row, t) => t + 1 < P.length ? (P[t + 1][0] > row[0] ? [1, 0] : [0, 1]) : [0, 0]) }) };
        const bt = Q.backtest({ dates: data.dates, symbols: ["A", "B"], P: data.P, strategy: peek, params: {}, costBps: 0 });
        const mom = Q.STRATEGIES.find((s) => s.id === "buyhold");
        const bh = Q.backtest({ dates: data.dates, symbols: ["A", "B"], P: data.P, strategy: mom, params: {}, costBps: 10 });
        return { rets: bt.rets, trades: bt.trades, bh: bh.rets };""", data)
    # Day t's return uses W[t-1], which was chosen with data through t-1 (peeking at t), so the
    # peeking strategy does profit; the engine's job is to apply weights to the *next* day only.
    assert js["rets"][0] == 0
    assert js["rets"][1] == pytest.approx(0.10)  # W[0] picked A, which rose 10% on day 1
    assert len([t for t in js["trades"] if not t.get("open")]) >= 2
    assert js["bh"][0] == pytest.approx(-0.001)  # entering costs 10 bps on 100% turnover
    assert js["bh"][1] == pytest.approx(0.0)  # +10% and -10% at 50/50


# --- TradingView-style indicators ---------------------------------------------------------------
# Python references written from the Pine Script built-ins, cross-checked against the `ta`
# library where it uses the same formulas.

def _ohlcv(n=400, seed=11):
    rng = np.random.default_rng(seed)
    c = 100 * np.cumprod(1 + rng.normal(0.0004, 0.018, n))
    o = c * (1 + rng.normal(0, 0.004, n))
    h = np.maximum(o, c) * (1 + np.abs(rng.normal(0, 0.006, n)))
    lo = np.minimum(o, c) * (1 - np.abs(rng.normal(0, 0.006, n)))
    v = rng.integers(1_000, 50_000, n).astype(float)
    return pd.DataFrame({"open": o, "high": h, "low": lo, "close": c, "volume": v})


def _rma(x: pd.Series, n: int) -> pd.Series:
    out, r, seed = [], None, []
    for v in x:
        if not np.isnan(v):
            if r is None:
                seed.append(v)
                if len(seed) == n:
                    r = float(np.mean(seed))
            else:
                r = (r * (n - 1) + v) / n
        out.append(np.nan if r is None else r)
    return pd.Series(out, index=x.index)


def _ema(x: pd.Series, n: int) -> pd.Series:
    return x.ewm(span=n, adjust=False).mean()


def _tr(df, handle_na=True):
    prev = df.close.shift()
    tr = pd.concat([df.high - df.low, (df.high - prev).abs(), (df.low - prev).abs()], axis=1).max(axis=1)
    tr.iloc[0] = df.high.iloc[0] - df.low.iloc[0] if handle_na else np.nan
    return tr


def _supertrend(df, period=10, factor=3):
    atr = _rma(_tr(df), period)
    src = (df.high + df.low) / 2
    line, direction = [np.nan] * len(df), [np.nan] * len(df)
    prev_upper = prev_lower = prev_st = None
    for i in range(len(df)):
        if np.isnan(atr.iloc[i]):
            continue
        upper, lower = src.iloc[i] + factor * atr.iloc[i], src.iloc[i] - factor * atr.iloc[i]
        pl, pu = prev_lower or 0.0, prev_upper or 0.0
        lower = lower if lower > pl or (i > 0 and df.close.iloc[i - 1] < pl) else pl
        upper = upper if upper < pu or (i > 0 and df.close.iloc[i - 1] > pu) else pu
        if i == 0 or np.isnan(atr.iloc[i - 1]):
            d = 1
        elif prev_st == prev_upper:
            d = -1 if df.close.iloc[i] > upper else 1
        else:
            d = 1 if df.close.iloc[i] < lower else -1
        line[i], direction[i] = (lower if d == -1 else upper), d
        prev_upper, prev_lower, prev_st = upper, lower, line[i]
    return np.array(line), np.array(direction)


def _js_series(values):
    return [np.nan if v is None else v for v in values]


def test_indicators_match_pine_definitions(tmp_path):
    import ta

    df = _ohlcv()
    js = run_js(tmp_path, """
        const d = data, m = Q.macd(d.close), s = Q.stochastic(d.high, d.low, d.close), sr = Q.stochRsi(d.close);
        const dm = Q.dmi(d.high, d.low, d.close), st = Q.supertrend(d.high, d.low, d.close, 10, 3), ich = Q.ichimoku(d.high, d.low, d.close);
        return { ema: Q.ema(d.close, 21), atr: Q.atr(d.high, d.low, d.close, 14), macd: m.macd, signal: m.signal, hist: m.hist,
          k: s.k, d: s.d, srk: sr.k, srd: sr.d, plus: dm.plus, minus: dm.minus, adx: dm.adx, st: st.line, dir: st.dir,
          sar: Q.psar(d.high, d.low, d.close), conv: ich.conversion, base: ich.base, spanA: ich.spanA, spanB: ich.spanB, lag: ich.lagging,
          vwap: Q.vwap(d.high, d.low, d.close, d.volume, (i) => Math.floor(i / 20)), obv: Q.obv(d.close, d.volume) };""",
        {k: df[k].tolist() for k in df})
    close, high, low = df.close, df.high, df.low

    # EMA, ATR, MACD: exact against the Pine definitions and against `ta`.
    assert _js_series(js["ema"]) == pytest.approx(_ema(close, 21).tolist(), rel=1e-12)
    atr = _rma(_tr(df), 14)
    assert _js_series(js["atr"])[13:] == pytest.approx(atr.tolist()[13:], rel=1e-12)
    assert js["atr"][-1] == pytest.approx(ta.volatility.AverageTrueRange(high, low, close, 14).average_true_range().iloc[-1], rel=1e-9)
    macd = _ema(close, 12) - _ema(close, 26)
    assert _js_series(js["macd"]) == pytest.approx(macd.tolist(), rel=1e-12)
    assert _js_series(js["signal"]) == pytest.approx(_ema(macd, 9).tolist(), rel=1e-12)
    assert js["macd"][-1] == pytest.approx(ta.trend.MACD(close).macd().iloc[-1], rel=1e-9)

    # Stochastic (14, 1, 3) and Stoch RSI (14, 14, 3, 3).
    k = 100 * (close - low.rolling(14).min()) / (high.rolling(14).max() - low.rolling(14).min())
    assert _js_series(js["k"])[13:] == pytest.approx(k.tolist()[13:], rel=1e-12)
    assert _js_series(js["d"])[15:] == pytest.approx(k.rolling(3).mean().tolist()[15:], rel=1e-12)
    assert js["k"][-1] == pytest.approx(ta.momentum.StochasticOscillator(high, low, close, 14, 3).stoch().iloc[-1], rel=1e-9)
    delta = close.diff()
    up, down = _rma(delta.clip(lower=0), 14), _rma((-delta).clip(lower=0), 14)
    rsi = 100 - 100 / (1 + up / down)
    srk = (100 * (rsi - rsi.rolling(14).min()) / (rsi.rolling(14).max() - rsi.rolling(14).min())).rolling(3).mean()
    assert _js_series(js["srk"])[40:] == pytest.approx(srk.tolist()[40:], rel=1e-9)
    assert _js_series(js["srd"])[42:] == pytest.approx(srk.rolling(3).mean().tolist()[42:], rel=1e-9)

    # DMI / ADX (TradingView's script: ta.tr without the first bar, Wilder smoothing).
    upm, dnm = high.diff(), -low.diff()
    plus_dm = pd.Series(np.where((upm > dnm) & (upm > 0), upm, 0.0), index=df.index).where(upm.notna())
    minus_dm = pd.Series(np.where((dnm > upm) & (dnm > 0), dnm, 0.0), index=df.index).where(dnm.notna())
    trur = _rma(_tr(df, handle_na=False), 14)
    plus, minus = 100 * _rma(plus_dm, 14) / trur, 100 * _rma(minus_dm, 14) / trur
    adx = 100 * _rma((plus - minus).abs() / (plus + minus).replace(0, 1), 14)
    assert _js_series(js["plus"])[15:] == pytest.approx(plus.tolist()[15:], rel=1e-9)
    assert _js_series(js["adx"])[30:] == pytest.approx(adx.tolist()[30:], rel=1e-9)

    # Supertrend and Parabolic SAR.
    line, direction = _supertrend(df)
    assert _js_series(js["st"])[10:] == pytest.approx(line.tolist()[10:], rel=1e-12)
    assert js["dir"][10:] == direction.tolist()[10:]
    assert set(js["dir"][10:]) == {1, -1}  # both regimes occur in this sample
    sar = np.array(_js_series(js["sar"]))
    up_trend = sar[1:] < close.to_numpy()[1:]
    assert up_trend.any() and (~up_trend).any()  # it flips sides
    assert np.all(np.where(up_trend, sar[1:] <= low.to_numpy()[1:] + 1e-9, sar[1:] >= high.to_numpy()[1:] - 1e-9))

    # Ichimoku: lines exact vs `ta`, spans shifted forward 25 bars, lagging span back 25.
    ich = ta.trend.IchimokuIndicator(high, low, 9, 26, 52, visual=False)
    assert _js_series(js["conv"])[60:] == pytest.approx(ich.ichimoku_conversion_line().tolist()[60:], rel=1e-12)
    assert _js_series(js["base"])[60:] == pytest.approx(ich.ichimoku_base_line().tolist()[60:], rel=1e-12)
    assert _js_series(js["spanA"])[100:] == pytest.approx(ich.ichimoku_a().shift(25).tolist()[100:], rel=1e-12)
    assert _js_series(js["spanB"])[100:] == pytest.approx(ich.ichimoku_b().shift(25).tolist()[100:], rel=1e-12)
    assert _js_series(js["lag"])[:-25] == pytest.approx(close.shift(-25).tolist()[:-25], rel=1e-12)

    # Session VWAP resets per session; OBV accumulates signed volume.
    tp = (high + low + close) / 3
    session = df.index // 20
    vwap = (tp * df.volume).groupby(session).cumsum() / df.volume.groupby(session).cumsum()
    assert js["vwap"] == pytest.approx(vwap.tolist(), rel=1e-12)
    obv = (np.sign(close.diff()).fillna(0) * df.volume).cumsum()
    assert js["obv"] == pytest.approx(obv.tolist(), rel=1e-12)


def test_every_strategy_runs_and_stays_within_bounds(tmp_path):
    rng = np.random.default_rng(5)
    P = (100 * np.cumprod(1 + rng.normal(0.0003, 0.015, (600, 3)), axis=0)).tolist()
    js = run_js(tmp_path, """
        const dates = data.map((_, i) => new Date(Date.UTC(2023, 0, 2) + i * 864e5).toISOString().slice(0, 10));
        return Q.STRATEGIES.map((s) => {
          const params = Object.fromEntries(s.params.map((p) => [p.key, p.def]));
          const syms = ["A", "B", "C"].slice(0, s.maxAssets || 3), P = data.map((row) => row.slice(0, syms.length));
          const bt = Q.backtest({ dates, symbols: syms, P, strategy: s, params, costBps: 5 });
          const gross = Math.max(...bt.W.map((w) => w.reduce((a, x) => a + Math.abs(x), 0)));
          return { id: s.id, n: bt.rets.length, finite: bt.rets.every(Number.isFinite), gross, trades: bt.trades.length };
        });""", P)
    assert {s["id"] for s in js} == {"buyhold", "momentum", "trend", "meanrev", "rsi", "macd", "pairs"}
    for s in js:
        assert s["n"] == 600 and s["finite"] and s["gross"] <= 1 + 1e-9, s
        assert s["trades"] > 0, s


def test_indicator_catalogue_runs_on_partial_data(tmp_path):
    df = _ohlcv(260)
    js = run_js(tmp_path, """
        const full = Object.assign({}, data, { session: (i) => Math.floor(i / 50), intraday: true });
        const closeOnly = { close: data.close };
        return Q.INDICATORS.map((ind) => ({ id: ind.id, kind: ind.kind, tv: ind.tv.length,
          full: Q.indicatorFits(ind, full) ? ind.calc(full).lines.map((l) => l.values.filter((v) => v !== null).length) : null,
          closeOnly: Q.indicatorFits(ind, closeOnly) }));""", {k: df[k].tolist() for k in df})
    by_id = {x["id"]: x for x in js}
    assert set(by_id) >= {"sma", "ema", "bb", "vwap", "ichimoku", "supertrend", "psar", "rsi", "macd", "stochrsi", "stoch", "atr", "adx", "obv"}
    assert all(x["tv"] >= 1 and x["full"] and all(n > 0 for n in x["full"]) for x in js)
    assert {i for i, x in by_id.items() if x["closeOnly"]} == {"sma", "ema", "bb", "rsi", "macd", "stochrsi"}
