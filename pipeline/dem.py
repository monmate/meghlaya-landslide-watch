"""Copernicus DEM GLO-30 adapter and terrain derivatives.

Tiles come from the public AWS bucket copernicus-dem-30m. Folder and file names
follow the bucket readme: Copernicus_DSM_COG_10_<N|S>yy_00_<E|W>xxx_00_DEM, named
by the lower-left corner. The DEM is a surface model (trees and buildings
included), so slopes under forest canopy carry some error.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from rasterio.merge import merge
from rasterio.transform import Affine, from_origin
from rasterio.warp import Resampling, calculate_default_transform, reproject
from scipy import ndimage

from .common import CACHE_DIR, Report, download, log

BUCKET = "https://copernicus-dem-30m.s3.amazonaws.com"
CREDIT = (
    "produced using Copernicus WorldDEM-30 (c) DLR e.V. 2010-2014 and (c) Airbus "
    "Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European "
    "Union and ESA; all rights reserved"
)


@dataclass
class Terrain:
    """Terrain rasters on a north-up UTM grid."""

    transform: Affine
    res: float
    elev: np.ndarray
    slope: np.ndarray  # degrees
    dzdx: np.ndarray  # rise per metre toward east
    dzdn: np.ndarray  # rise per metre toward north
    relief: np.ndarray  # max - min elevation in a moving window (m)
    crs: str

    def rowcol(self, xs: np.ndarray, ys: np.ndarray):
        col = np.floor((xs - self.transform.c) / self.res).astype(np.int64)
        row = np.floor((self.transform.f - ys) / self.res).astype(np.int64)
        h, w = self.elev.shape
        ok = (row >= 0) & (row < h) & (col >= 0) & (col < w)
        return row, col, ok

    def sample(self, arr: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
        row, col, ok = self.rowcol(xs, ys)
        out = np.full(xs.shape, np.nan, dtype=np.float32)
        out[ok] = arr[row[ok], col[ok]]
        return out


def tile_name(lat: int, lon: int) -> str:
    ns = "N" if lat >= 0 else "S"
    ew = "E" if lon >= 0 else "W"
    return f"Copernicus_DSM_COG_10_{ns}{abs(lat):02d}_00_{ew}{abs(lon):03d}_00_DEM"


def tile_names(bounds: tuple[float, float, float, float]) -> list[str]:
    minx, miny, maxx, maxy = bounds
    names = []
    for lat in range(math.floor(miny), math.floor(maxy) + 1):
        for lon in range(math.floor(minx), math.floor(maxx) + 1):
            names.append(tile_name(lat, lon))
    return names


def fetch_tiles(bounds, session, report: Report) -> list[Path]:
    paths = []
    for name in tile_names(bounds):
        url = f"{BUCKET}/{name}/{name}.tif"
        dest = CACHE_DIR / "dem" / f"{name}.tif"
        try:
            paths.append(download(url, dest, session))
            log.info("DEM tile ready: %s", name)
        except Exception as exc:  # a missing tile (e.g. sea) is not fatal
            report.warn(f"DEM tile {name} not downloaded: {exc}")
    if not paths:
        raise RuntimeError("No Copernicus DEM tiles could be downloaded")
    report.source(
        "Copernicus DEM GLO-30",
        tiles=len(paths),
        url=BUCKET,
        credit=CREDIT,
    )
    return paths


def mosaic_to_utm(paths: list[Path], bounds, utm_epsg: int, res: float = 30.0):
    """Mosaic tiles over bounds (lon/lat) and reproject to UTM at res metres."""
    srcs = [rasterio.open(p) for p in paths]
    try:
        arr, transform = merge(srcs, bounds=bounds, nodata=np.nan, dtype="float32")
        src_crs = srcs[0].crs
    finally:
        for s in srcs:
            s.close()
    data = arr[0].astype(np.float32)
    h, w = data.shape
    dst_crs = f"EPSG:{utm_epsg}"
    dst_transform, dst_w, dst_h = calculate_default_transform(
        src_crs, dst_crs, w, h, *bounds, resolution=res
    )
    out = np.full((dst_h, dst_w), np.nan, dtype=np.float32)
    reproject(
        source=data,
        destination=out,
        src_transform=transform,
        src_crs=src_crs,
        src_nodata=np.nan,
        dst_transform=dst_transform,
        dst_crs=dst_crs,
        dst_nodata=np.nan,
        resampling=Resampling.bilinear,
    )
    return out, dst_transform, dst_crs


def derive_terrain(elev: np.ndarray, transform: Affine, crs: str,
                   relief_window_m: float) -> Terrain:
    """Slope (Horn's method), gradients and local relief."""
    res = float(transform.a)
    z = elev.copy()
    holes = np.isnan(z)
    if holes.any():
        fill = np.nanmedian(z) if np.isfinite(np.nanmedian(z)) else 0.0
        z[holes] = fill
    zp = np.pad(z, 1, mode="edge")
    a, b, c = zp[:-2, :-2], zp[:-2, 1:-1], zp[:-2, 2:]
    d, f = zp[1:-1, :-2], zp[1:-1, 2:]
    g, h, i = zp[2:, :-2], zp[2:, 1:-1], zp[2:, 2:]
    dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8.0 * res)
    dzds = ((g + 2 * h + i) - (a + 2 * b + c)) / (8.0 * res)  # rows run south
    dzdn = -dzds
    del zp, a, b, c, d, f, g, h, i, dzds
    slope = np.degrees(np.arctan(np.hypot(dzdx, dzdn))).astype(np.float32)
    size = max(3, int(round(relief_window_m / res)) | 1)
    relief = (ndimage.maximum_filter(z, size=size) - ndimage.minimum_filter(z, size=size)).astype(np.float32)
    for arr in (slope, relief):
        arr[holes] = np.nan
    return Terrain(
        transform=transform,
        res=res,
        elev=elev,
        slope=slope,
        dzdx=dzdx.astype(np.float32),
        dzdn=dzdn.astype(np.float32),
        relief=relief,
        crs=crs,
    )


def hillshade(t: Terrain, azimuth_deg: float = 315.0, altitude_deg: float = 45.0) -> np.ndarray:
    """0-255 hillshade on the terrain grid."""
    az = math.radians(360.0 - azimuth_deg + 90.0)
    alt = math.radians(altitude_deg)
    slope_r = np.radians(t.slope)
    # ESRI convention: aspect = atan2(dz/d(south), -dz/d(east)).
    aspect = np.arctan2(-t.dzdn, -t.dzdx)
    shade = np.sin(alt) * np.cos(slope_r) + np.cos(alt) * np.sin(slope_r) * np.cos(az - aspect)
    out = np.clip(shade * 255.0, 0, 255)
    out[np.isnan(t.slope)] = 255
    return out.astype(np.uint8)


def hillshade_webmercator(t: Terrain, mask_geom_ll, res_m: float = 150.0):
    """Hillshade warped to Web Mercator for a MapLibre image source.

    Returns (uint8 image, [lon_min, lat_min, lon_max, lat_max] of the image).
    Pixels outside the state are set to white so they vanish on a light map.
    """
    from rasterio.features import geometry_mask
    from shapely.geometry import mapping
    from shapely.ops import transform as shp_transform
    from pyproj import Transformer

    shade = hillshade(t).astype(np.float32)
    h, w = shade.shape
    left, top = t.transform.c, t.transform.f
    right, bottom = left + w * t.res, top - h * t.res
    dst_crs = "EPSG:3857"
    dst_transform, dst_w, dst_h = calculate_default_transform(
        t.crs, dst_crs, w, h, left, bottom, right, top, resolution=res_m
    )
    out = np.full((dst_h, dst_w), 255.0, dtype=np.float32)
    reproject(
        source=shade,
        destination=out,
        src_transform=t.transform,
        src_crs=t.crs,
        dst_transform=dst_transform,
        dst_crs=dst_crs,
        resampling=Resampling.average,
    )
    to_merc = Transformer.from_crs("EPSG:4326", dst_crs, always_xy=True)
    geom_merc = shp_transform(lambda x, y, z=None: to_merc.transform(x, y), mask_geom_ll)
    outside = geometry_mask([mapping(geom_merc)], out_shape=out.shape, transform=dst_transform)
    out[outside] = 255.0
    to_ll = Transformer.from_crs(dst_crs, "EPSG:4326", always_xy=True)
    x0, y1 = dst_transform.c, dst_transform.f
    x1, y0 = x0 + dst_w * dst_transform.a, y1 + dst_h * dst_transform.e
    lon0, lat0 = to_ll.transform(x0, y0)
    lon1, lat1 = to_ll.transform(x1, y1)
    return out.astype(np.uint8), [lon0, lat0, lon1, lat1]


def synthetic_transform(x0: float, y0: float, res: float) -> Affine:
    return from_origin(x0, y0, res, res)
