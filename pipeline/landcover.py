"""ESA WorldCover 2021 (v200) adapter.

Tiles are 3 x 3 degree Cloud Optimized GeoTIFFs named by their lower-left corner,
e.g. ESA_WorldCover_10m_2021_v200_N24E090_Map.tif, in the public esa-worldcover
bucket (eu-central-1). We read a decimated window (about 30 m) over the area
instead of downloading whole tiles. Licence: CC BY 4.0.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .common import Report, log

BUCKET = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map"
NATIVE_DEG = 1.0 / 12000.0  # 10 m pixels: 3 degrees = 36,000 pixels
DECIMATE = 3


@dataclass
class LandCover:
    west: float
    north: float
    step: float
    grid: np.ndarray  # uint8 class codes, 0 = unknown

    def sample(self, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
        col = np.floor((lon - self.west) / self.step).astype(np.int64)
        row = np.floor((self.north - lat) / self.step).astype(np.int64)
        h, w = self.grid.shape
        ok = (row >= 0) & (row < h) & (col >= 0) & (col < w)
        out = np.zeros(lon.shape, dtype=np.uint8)
        out[ok] = self.grid[row[ok], col[ok]]
        return out


def tile_name(lat0: int, lon0: int) -> str:
    ns = "N" if lat0 >= 0 else "S"
    ew = "E" if lon0 >= 0 else "W"
    return f"ESA_WorldCover_10m_2021_v200_{ns}{abs(lat0):02d}{ew}{abs(lon0):03d}_Map.tif"


def tiles_for(bounds) -> list[tuple[int, int]]:
    minx, miny, maxx, maxy = bounds
    out = []
    for lat0 in range(3 * math.floor(miny / 3), 3 * math.floor(maxy / 3) + 1, 3):
        for lon0 in range(3 * math.floor(minx / 3), 3 * math.floor(maxx / 3) + 1, 3):
            out.append((lat0, lon0))
    return out


def fetch(bounds, report: Report) -> LandCover:
    """Read WorldCover classes over bounds at ~30 m (nearest-neighbour)."""
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.windows import from_bounds

    minx, miny, maxx, maxy = bounds
    step = NATIVE_DEG * DECIMATE
    # Snap the grid to the global 10 m pixel lattice so tiles line up.
    west = math.floor(minx / step) * step
    north = math.ceil(maxy / step) * step
    width = int(math.ceil((maxx - west) / step))
    height = int(math.ceil((north - miny) / step))
    grid = np.zeros((height, width), dtype=np.uint8)
    env = {
        "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
        "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
        "GDAL_HTTP_MAX_RETRY": "5",
        "GDAL_HTTP_RETRY_DELAY": "3",
        "VSI_CACHE": "TRUE",
    }
    used = 0
    with rasterio.Env(**env):
        for lat0, lon0 in tiles_for(bounds):
            url = f"{BUCKET}/{tile_name(lat0, lon0)}"
            tw, ts, te, tn = lon0, lat0, lon0 + 3, lat0 + 3
            iw, is_, ie, in_ = max(west, tw), max(miny, ts), min(maxx, te), min(north, tn)
            if iw >= ie or is_ >= in_:
                continue
            try:
                with rasterio.open(url) as src:
                    win = from_bounds(iw, is_, ie, in_, transform=src.transform)
                    out_w = int(round((ie - iw) / step))
                    out_h = int(round((in_ - is_) / step))
                    data = src.read(
                        1, window=win, out_shape=(out_h, out_w),
                        resampling=Resampling.nearest, boundless=False,
                    )
            except Exception as exc:
                report.warn(f"WorldCover tile {tile_name(lat0, lon0)} unreadable: {exc}")
                continue
            r0 = int(round((north - in_) / step))
            c0 = int(round((iw - west) / step))
            h = min(data.shape[0], height - r0)
            w = min(data.shape[1], width - c0)
            grid[r0 : r0 + h, c0 : c0 + w] = data[:h, :w]
            used += 1
            log.info("WorldCover tile read: %s", tile_name(lat0, lon0))
    if used == 0:
        raise RuntimeError("No WorldCover tiles could be read")
    report.source("ESA WorldCover 2021 v200", tiles=used, url=BUCKET,
                  licence="CC BY 4.0, (c) ESA WorldCover project 2021")
    return LandCover(west=west, north=north, step=step, grid=grid)
