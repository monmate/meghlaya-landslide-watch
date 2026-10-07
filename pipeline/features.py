"""Per-segment static features.

Each segment is sampled every ~30 m along its centreline and at fixed offsets
across it (default -100, -50, 0, 50, 100 m), so the hillside above and below
the road counts, not just the road surface.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from pyproj import Transformer
from scipy.spatial import cKDTree

from .dem import Terrain
from .landcover import LandCover
from .network import Network, sample_points


@dataclass
class SegmentFeatures:
    slope_p90: np.ndarray  # degrees
    relief: np.ndarray  # metres
    cross_slope: np.ndarray  # degrees
    elev_mid: np.ndarray  # metres
    landcover_exposure: np.ndarray  # 0..1, NaN if unavailable
    landcover_major: np.ndarray  # WorldCover code of the most common class (0 = unknown)
    past_slides: np.ndarray  # count of reported slides nearby
    has_landcover: bool


def compute(
    net: Network,
    terrain: Terrain,
    landcover: LandCover | None,
    exposure_map: dict[int, float],
    events: list[dict],
    step_m: float,
    offsets_m: list[float],
    slide_radius_m: float,
    slide_max_accuracy_m: float,
    utm_epsg: int,
) -> SegmentFeatures:
    n = len(net.segments)
    slope_p90 = np.full(n, np.nan, dtype=np.float32)
    relief = np.full(n, np.nan, dtype=np.float32)
    cross = np.full(n, np.nan, dtype=np.float32)
    elev_mid = np.full(n, np.nan, dtype=np.float32)
    lc_exp = np.full(n, np.nan, dtype=np.float32)
    lc_major = np.zeros(n, dtype=np.uint8)
    to_ll = Transformer.from_crs(f"EPSG:{utm_epsg}", "EPSG:4326", always_xy=True)

    lut = np.full(256, np.nan, dtype=np.float32)
    for code, val in exposure_map.items():
        lut[int(code)] = float(val)

    for seg in net.segments:
        xs, ys, on_line, normals = sample_points(seg, step_m, offsets_m)
        s = terrain.sample(terrain.slope, xs, ys)
        if np.isfinite(s).any():
            slope_p90[seg.id] = np.nanpercentile(s, 90)
        rl = terrain.sample(terrain.relief, xs[on_line], ys[on_line])
        if np.isfinite(rl).any():
            relief[seg.id] = np.nanmax(rl)
        gx = terrain.sample(terrain.dzdx, xs[on_line], ys[on_line])
        gy = terrain.sample(terrain.dzdn, xs[on_line], ys[on_line])
        nrm = normals[on_line]
        across = np.abs(gx * nrm[:, 0] + gy * nrm[:, 1])
        if np.isfinite(across).any():
            cross[seg.id] = np.degrees(np.arctan(np.nanmedian(across)))
        mid = len(xs[on_line]) // 2
        ev = terrain.sample(terrain.elev, xs[on_line][mid : mid + 1], ys[on_line][mid : mid + 1])
        elev_mid[seg.id] = ev[0]
        if landcover is not None:
            lon, lat = to_ll.transform(xs, ys)
            codes = landcover.sample(np.asarray(lon), np.asarray(lat))
            known = codes[codes > 0]
            if known.size:
                lc_exp[seg.id] = np.nanmean(lut[known])
                vals, counts = np.unique(known, return_counts=True)
                lc_major[seg.id] = vals[np.argmax(counts)]

    past = count_slides(net, events, slide_radius_m, slide_max_accuracy_m, utm_epsg)
    return SegmentFeatures(
        slope_p90=slope_p90,
        relief=relief,
        cross_slope=cross,
        elev_mid=elev_mid,
        landcover_exposure=lc_exp,
        landcover_major=lc_major,
        past_slides=past,
        has_landcover=landcover is not None and bool(np.isfinite(lc_exp).any()),
    )


def count_slides(net: Network, events: list[dict], radius_m: float,
                 max_accuracy_m: float, utm_epsg: int) -> np.ndarray:
    """Reported slides within max(radius, location accuracy) of each segment."""
    n = len(net.segments)
    out = np.zeros(n, dtype=np.int32)
    usable = [e for e in events if e.get("accuracy_m") is not None and e["accuracy_m"] <= max_accuracy_m]
    if not usable or n == 0:
        return out
    to_utm = Transformer.from_crs("EPSG:4326", f"EPSG:{utm_epsg}", always_xy=True)
    ex, ey = to_utm.transform([e["lon"] for e in usable], [e["lat"] for e in usable])
    ev_xy = np.column_stack([ex, ey])
    radii = np.array([max(radius_m, e["accuracy_m"]) for e in usable])
    # Represent each segment by points every ~50 m.
    pts, owner = [], []
    for seg in net.segments:
        line = seg.utm
        k = max(2, int(line.length // 50) + 1)
        for d in np.linspace(0, line.length, k):
            p = line.interpolate(d)
            pts.append((p.x, p.y))
            owner.append(seg.id)
    tree = cKDTree(np.array(pts))
    owner_arr = np.array(owner)
    for i in range(len(usable)):
        idx = tree.query_ball_point(ev_xy[i], r=radii[i])
        if idx:
            for sid in np.unique(owner_arr[idx]):
                out[sid] += 1
    return out
