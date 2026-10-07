"""Rules-based susceptibility index (a transparent risk estimate, not a prediction).

Each factor is scored 0..1 with a linear ramp from config/risk.yaml, then
combined with documented weights. Classes are relative: the top 15% of
hillside segments are High, the next 35% Moderate, the rest Low.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .features import SegmentFeatures

# Reason codes; the web app turns them into plain-language sentences.
REASONS = ["slope", "relief", "cross_slope", "landcover", "past_slides"]


@dataclass
class Susceptibility:
    index: np.ndarray  # 0..1
    sclass: np.ndarray  # 0 low, 1 moderate, 2 high
    reasons: list[list[str]]  # up to 3 codes per segment, strongest first
    weights_used: dict[str, float]
    thresholds: dict[str, float]


def ramp(x: np.ndarray, lo: float, hi: float) -> np.ndarray:
    return np.clip((x - lo) / (hi - lo), 0.0, 1.0)


def compute(f: SegmentFeatures, cfg: dict) -> Susceptibility:
    s_cfg = cfg["susceptibility"]
    r = s_cfg["ramps"]
    scores = {
        "slope": ramp(f.slope_p90, *r["slope_p90_deg"]),
        "relief": ramp(f.relief, *r["relief_m"]),
        "cross_slope": ramp(f.cross_slope, *r["cross_slope_deg"]),
        "landcover": f.landcover_exposure.astype(np.float64),
        "past_slides": ramp(f.past_slides.astype(np.float64), *r["past_slides_count"]),
    }
    weights = dict(s_cfg["weights"])
    if not f.has_landcover:
        weights.pop("landcover")
    total_w = sum(weights.values())
    weights = {k: v / total_w for k, v in weights.items()}

    n = f.slope_p90.shape[0]
    index = np.zeros(n, dtype=np.float64)
    wsum = np.zeros(n, dtype=np.float64)
    contrib = {}
    for k, w in weights.items():
        sc = scores[k]
        ok = np.isfinite(sc)
        c = np.where(ok, sc * w, 0.0)
        contrib[k] = c
        index += c
        wsum += np.where(ok, w, 0.0)
    with np.errstate(invalid="ignore", divide="ignore"):
        index = np.where(wsum > 0, index / wsum, np.nan)

    flat = ~(f.slope_p90 >= s_cfg["flat_slope_deg"])  # NaN counts as flat
    hill = ~flat & np.isfinite(index)
    q_mod = float(np.quantile(index[hill], s_cfg["classes"]["moderate_quantile"])) if hill.any() else 1.0
    q_high = float(np.quantile(index[hill], s_cfg["classes"]["high_quantile"])) if hill.any() else 1.0
    sclass = np.zeros(n, dtype=np.uint8)
    sclass[hill & (index >= q_mod)] = 1
    sclass[hill & (index >= q_high)] = 2

    reasons: list[list[str]] = []
    keys = list(weights.keys())
    cmat = np.column_stack([contrib[k] for k in keys]) if keys else np.zeros((n, 0))
    for i in range(n):
        order = np.argsort(-cmat[i])
        picked = [keys[j] for j in order[:3] if cmat[i, j] >= 0.04 and scores[keys[j]][i] >= 0.4]
        reasons.append(picked)

    return Susceptibility(
        index=np.nan_to_num(index, nan=0.0),
        sclass=sclass,
        reasons=reasons,
        weights_used={k: round(v, 3) for k, v in weights.items()},
        thresholds={"moderate_index": round(q_mod, 4), "high_index": round(q_high, 4)},
    )
