"""Synthetic SAMPLE DATA so the whole system runs without network access.

Nothing here describes the real Meghalaya: terrain, roads, places, slides and
rain are generated. Every file written from it carries "sample": true and the
web app shows a SAMPLE DATA badge.
"""

from __future__ import annotations

import datetime as dt
import math

import numpy as np
from pyproj import Transformer
from shapely.geometry import Polygon

from .dem import derive_terrain, synthetic_transform
from .landcover import LandCover
from .osm import Way


def _utm_center(utm_epsg: int, lon: float = 91.88, lat: float = 25.45):
    t = Transformer.from_crs("EPSG:4326", f"EPSG:{utm_epsg}", always_xy=True)
    return t.transform(lon, lat)


def terrain(utm_epsg: int, relief_window_m: float):
    """A plateau with ridges that drops to a southern lowland, 60 x 40 km at 30 m."""
    cx, cy = _utm_center(utm_epsg)
    res = 30.0
    w, h = 2000, 1334
    x0, y0 = cx - w * res / 2, cy + h * res / 2
    xs = x0 + (np.arange(w) + 0.5) * res
    ys = y0 - (np.arange(h) + 0.5) * res
    X, Y = np.meshgrid(xs, ys)
    plateau = 1300.0 / (1.0 + np.exp(-(Y - (cy - 6000.0)) / 900.0))
    ridges = 260.0 * np.sin((X - cx) / 1100.0) * np.cos((Y - cy) / 1500.0)
    hills = 90.0 * np.sin((X - cx) / 380.0 + 1.3) * np.sin((Y - cy) / 450.0)
    knolls = 260.0 * np.exp(-(((X - cx - 9000) ** 2) + ((Y - cy - 5000) ** 2)) / (2 * 4000.0**2))
    gorge = -420.0 * np.exp(-((X - cx + 7000) ** 2) / (2 * 1200.0**2)) * (Y > cy - 9000)
    elev = (80.0 + plateau + ridges + hills + knolls + gorge).astype(np.float32)
    transform = synthetic_transform(x0, y0, res)
    return derive_terrain(elev, transform, f"EPSG:{utm_epsg}", relief_window_m), (cx, cy)


def roads(utm_epsg: int, center) -> list[Way]:
    """A small connected network: plateau roads plus a switchback descent."""
    cx, cy = center
    to_ll = Transformer.from_crs(f"EPSG:{utm_epsg}", "EPSG:4326", always_xy=True)
    nodes = {
        1: (cx - 18000, cy + 9000),
        2: (cx, cy + 10000),
        3: (cx + 17000, cy + 8000),
        4: (cx - 2000, cy - 1000),
        5: (cx + 12000, cy - 4000),
        6: (cx - 4000, cy - 15000),
        7: (cx + 9000, cy - 16000),
    }
    specs = [
        (1, 2, "trunk", "NH-SAMPLE-1", 300, 6),
        (2, 3, "trunk", "NH-SAMPLE-1", 250, 5),
        (2, 4, "primary", "SH-SAMPLE-2", 500, 7),
        (4, 5, "secondary", "", 400, 6),
        (3, 5, "secondary", "", 350, 5),
        (4, 6, "primary", "SH-SAMPLE-2", 1600, 14),  # switchbacks down the escarpment
        (5, 7, "tertiary", "", 1200, 10),
        (6, 7, "secondary", "", 300, 6),
    ]
    ways = []
    next_node = 1000
    for k, (a, b, hw, ref, amp, waves) in enumerate(specs):
        (ax, ay), (bx, by) = nodes[a], nodes[b]
        t = np.linspace(0, 1, 120)
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy)
        nx, ny = -dy / L, dx / L
        wiggle = amp * np.sin(t * math.pi * waves) * np.sin(t * math.pi)
        px = ax + dx * t + nx * wiggle
        py = ay + dy * t + ny * wiggle
        lon, lat = to_ll.transform(px, py)
        ids = [a] + list(range(next_node, next_node + len(t) - 2)) + [b]
        next_node += len(t)
        ways.append(Way(id=k + 1, highway=hw, name="", ref=ref, nodes=ids,
                        coords=list(zip(map(float, lon), map(float, lat)))))
    return ways


def places(utm_epsg: int, center) -> list[dict]:
    cx, cy = center
    to_ll = Transformer.from_crs(f"EPSG:{utm_epsg}", "EPSG:4326", always_xy=True)
    raw = [
        ("Sample Town West", cx - 18000, cy + 9000),
        ("Sample City", cx, cy + 10000),
        ("Sample Town East", cx + 17000, cy + 8000),
        ("Sample Junction", cx - 2000, cy - 1000),
        ("Sample Ridge Village", cx + 12000, cy - 4000),
        ("Sample Valley Town", cx - 4000, cy - 15000),
        ("Sample Border Market", cx + 9000, cy - 16000),
    ]
    out = []
    for name, x, y in raw:
        lon, lat = to_ll.transform(x, y)
        out.append({"name": name, "lon": round(lon, 5), "lat": round(lat, 5), "kind": "town"})
    return out


def boundary(utm_epsg: int, center):
    cx, cy = center
    to_ll = Transformer.from_crs(f"EPSG:{utm_epsg}", "EPSG:4326", always_xy=True)
    ring = [(cx - 29000, cy + 19000), (cx + 29000, cy + 19000),
            (cx + 29000, cy - 19000), (cx - 29000, cy - 19000)]
    return Polygon([to_ll.transform(x, y) for x, y in ring])


def landcover(bounds) -> LandCover:
    """Forest on the plateau, cropland in the lowland, a few bare patches."""
    minx, miny, maxx, maxy = bounds
    step = 0.00025
    w = int((maxx - minx) / step) + 1
    h = int((maxy - miny) / step) + 1
    rng = np.random.default_rng(7)
    grid = np.full((h, w), 10, dtype=np.uint8)
    grid[int(h * 0.6) :, :] = 40
    for _ in range(40):
        r, c = rng.integers(0, h), rng.integers(0, w)
        grid[max(0, r - 15) : r + 15, max(0, c - 15) : c + 15] = 60
    grid[int(h * 0.2) : int(h * 0.24), int(w * 0.45) : int(w * 0.55)] = 50
    return LandCover(west=minx, north=maxy, step=step, grid=grid)


def events(t, utm_epsg: int, n: int = 12) -> list[dict]:
    """Synthetic reported slides placed on steep ground."""
    to_ll = Transformer.from_crs(f"EPSG:{utm_epsg}", "EPSG:4326", always_xy=True)
    rng = np.random.default_rng(11)
    steep = np.argwhere(t.slope > 30)
    out = []
    for i in rng.choice(len(steep), size=min(n, len(steep)), replace=False):
        r, c = steep[i]
        x = t.transform.c + (c + 0.5) * t.res
        y = t.transform.f - (r + 0.5) * t.res
        lon, lat = to_ll.transform(x, y)
        out.append({"lon": round(lon, 5), "lat": round(lat, 5), "date": "2022-06-17",
                    "accuracy_m": 1000.0, "accuracy_text": "1km", "trigger": "downpour",
                    "title": "SAMPLE reported slide", "source": "SAMPLE DATA", "url": ""})
    return out


def rain_series(grid: list[tuple[float, float]], start: dt.datetime, hours: int,
                storm_center_h: float, peak_mm_h: float) -> dict:
    """A storm crossing the grid from south-west to north-east."""
    times = [(start + dt.timedelta(hours=k)).strftime("%Y-%m-%dT%H:%M") for k in range(hours)]
    g = np.array(grid)
    lon_c, lat_c = g[:, 0].mean(), g[:, 1].mean()
    series = []
    rng = np.random.default_rng(3)
    for lon, lat in grid:
        # Southern points get more rain (the escarpment faces the monsoon).
        boost = 1.0 + 1.2 * max(0.0, (lat_c - lat) / 0.3)
        lag = (lon - lon_c) * 40 + (lat - lat_c) * 30
        k = np.arange(hours)
        storm = peak_mm_h * boost * np.exp(-((k - storm_center_h - lag) ** 2) / (2 * 9.0**2))
        drizzle = np.clip(rng.normal(0.4, 0.5, hours), 0, None)
        series.append([round(float(v), 1) for v in storm + drizzle])
    return {"times": times, "precip": series}
