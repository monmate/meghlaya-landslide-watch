"""Rain grid and Open-Meteo adapters (live snapshot and storm replay).

Open-Meteo's free API is for non-commercial use (CC BY 4.0 data). Multiple
coordinates can be comma-separated in one request; the response is then a
list with one object per location. Hourly `precipitation` is the sum over the
preceding hour, in mm. Forecast and recent hours come from weather models,
not rain gauges.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
from shapely.geometry import Point
from shapely.prepared import prep

from .common import Report, log, utcnow_iso

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
CREDIT = "Weather data by Open-Meteo.com (CC BY 4.0)"
BATCH = 50


def make_grid(boundary, step: float, margin: float) -> list[tuple[float, float]]:
    """Grid points (lon, lat) every `step` degrees within `margin` of the boundary."""
    minx, miny, maxx, maxy = boundary.bounds
    near = prep(boundary.buffer(margin))
    lon0 = math.floor(minx / step) * step
    lat0 = math.floor(miny / step) * step
    pts = []
    lat = lat0
    while lat <= maxy + step:
        lon = lon0
        while lon <= maxx + step:
            if near.contains(Point(lon, lat)):
                pts.append((round(lon, 4), round(lat, 4)))
            lon += step
        lat += step
    return pts


def assign_cells(mid_lonlat: np.ndarray, grid: list[tuple[float, float]]) -> np.ndarray:
    """Index of the nearest grid point for each segment midpoint."""
    g = np.array(grid)
    # Degrees of longitude are ~0.9 of latitude here; scale before comparing.
    scale = np.array([math.cos(math.radians(float(g[:, 1].mean()))), 1.0])
    from scipy.spatial import cKDTree

    tree = cKDTree(g * scale)
    _, idx = tree.query(mid_lonlat * scale)
    return idx.astype(np.int32)


def _fetch_many(session, url: str, grid, params: dict[str, Any]) -> dict[str, Any]:
    times: list[str] | None = None
    series: list[list[float]] = []
    for i in range(0, len(grid), BATCH):
        chunk = grid[i : i + BATCH]
        q = dict(params)
        q["latitude"] = ",".join(f"{p[1]:.4f}" for p in chunk)
        q["longitude"] = ",".join(f"{p[0]:.4f}" for p in chunk)
        r = session.get(url, params=q, timeout=(20, 120))
        r.raise_for_status()
        data = r.json()
        items = data if isinstance(data, list) else [data]
        if len(items) != len(chunk):
            raise RuntimeError(f"Open-Meteo returned {len(items)} locations for {len(chunk)}")
        for it in items:
            if it.get("error"):
                raise RuntimeError(f"Open-Meteo error: {it.get('reason')}")
            hourly = it["hourly"]
            if times is None:
                times = hourly["time"]
            vals = [0.0 if v is None else round(float(v), 1) for v in hourly["precipitation"]]
            series.append(vals)
    return {"times": times or [], "precip": series}


def fetch_live(session, grid, past_days: int, forecast_days: int, report: Report) -> dict[str, Any]:
    data = _fetch_many(
        session,
        FORECAST_URL,
        grid,
        {
            "hourly": "precipitation",
            "past_days": past_days,
            "forecast_days": forecast_days,
            "timezone": "UTC",
        },
    )
    data.update(
        {
            "mode": "live",
            "source": "Open-Meteo forecast API (best-match weather models)",
            "credit": CREDIT,
            "fetched_at": utcnow_iso(),
            "sample": False,
        }
    )
    report.source("Open-Meteo forecast", url=FORECAST_URL, points=len(grid),
                  hours=len(data["times"]), terms="free API for non-commercial use; CC BY 4.0")
    log.info("Live rain: %d points x %d hours", len(grid), len(data["times"]))
    return data


def fetch_archive(session, grid, start_date: str, end_date: str, report: Report) -> dict[str, Any]:
    data = _fetch_many(
        session,
        ARCHIVE_URL,
        grid,
        {
            "hourly": "precipitation",
            "start_date": start_date,
            "end_date": end_date,
            "timezone": "UTC",
        },
    )
    data.update(
        {
            "mode": "replay",
            "source": "Open-Meteo historical weather API (ERA5 reanalysis, about 25 km)",
            "credit": CREDIT,
            "fetched_at": utcnow_iso(),
            "sample": False,
        }
    )
    report.source("Open-Meteo historical (ERA5)", url=ARCHIVE_URL, points=len(grid),
                  window=f"{start_date} to {end_date}")
    return data
