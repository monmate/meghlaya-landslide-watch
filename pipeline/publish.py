"""Write the compact JSON files the web app loads.

Geometry is stored as integers (1e-5 degree, about 1 m) with the first point
relative to an origin and later points as deltas, which keeps the statewide
network small enough for a phone.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np
from scipy.spatial import cKDTree
from shapely.geometry import mapping

from .features import SegmentFeatures
from .index import Susceptibility
from .network import Network, base_class

SCALE = 100000
REASON_LETTER = {"slope": "s", "relief": "r", "cross_slope": "c", "landcover": "l", "past_slides": "p"}


def _num(arr: np.ndarray, mult: float = 1.0, nan: int = -1) -> list[int]:
    a = np.asarray(arr, dtype=np.float64) * mult
    out = np.where(np.isfinite(a), np.round(a), nan)
    return out.astype(np.int64).tolist()


def _dump(path: Path, obj: Any) -> int:
    text = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
    path.write_text(text, encoding="utf-8")
    return len(text)


def write_static(out_dir: Path, net: Network, feats: SegmentFeatures, susc: Susceptibility,
                 cells: np.ndarray, grid: list, places: list[dict], events: list[dict],
                 boundary, meta: dict[str, Any], speeds: dict[str, float]) -> dict[str, int]:
    out_dir.mkdir(parents=True, exist_ok=True)
    sizes: dict[str, int] = {}

    all_ll = np.array([p for s in net.segments for p in s.ll])
    lon0 = math.floor(all_ll[:, 0].min() * 100) / 100
    lat0 = math.floor(all_ll[:, 1].min() * 100) / 100

    classes = sorted({base_class(s.highway) for s in net.segments})
    cls_idx = {c: i for i, c in enumerate(classes)}
    names: list[str] = [""]
    name_idx: dict[str, int] = {"": 0}

    geom, hw, name = [], [], []
    for s in net.segments:
        xs = [int(round((lon - lon0) * SCALE)) for lon, _ in s.ll]
        ys = [int(round((lat - lat0) * SCALE)) for _, lat in s.ll]
        flat = [xs[0], ys[0]]
        for k in range(1, len(xs)):
            flat += [xs[k] - xs[k - 1], ys[k] - ys[k - 1]]
        geom.append(flat)
        hw.append(cls_idx[base_class(s.highway)])
        label = " ".join(x for x in (s.ref, s.name) if x).strip()
        if label not in name_idx:
            name_idx[label] = len(names)
            names.append(label)
        name.append(name_idx[label])

    segs = {
        "version": 1,
        "sample": bool(meta.get("sample")),
        "count": len(net.segments),
        "scale": SCALE,
        "origin": [lon0, lat0],
        "classes": classes,
        "names": names,
        "geom": geom,
        "edge": [s.edge for s in net.segments],
        "hw": hw,
        "name": name,
        "len": [int(round(s.length_m)) for s in net.segments],
        "susc": _num(susc.index, 100),
        "sclass": susc.sclass.astype(int).tolist(),
        "cell": cells.astype(int).tolist(),
        "slope": _num(feats.slope_p90, 10),
        "relief": _num(feats.relief),
        "cross": _num(feats.cross_slope, 10),
        "lc": _num(feats.landcover_exposure, 100),
        "lcm": feats.landcover_major.astype(int).tolist(),
        "slides": feats.past_slides.astype(int).tolist(),
        "elev": _num(feats.elev_mid),
        "reasons": ["".join(REASON_LETTER[r] for r in rs) for rs in susc.reasons],
    }
    sizes["segments.json"] = _dump(out_dir / "segments.json", segs)

    node = np.array(net.node_ll)
    graph = {
        "version": 1,
        "scale": SCALE,
        "origin": [lon0, lat0],
        "classes": classes,
        "speed_kmh": {c: float(speeds.get(c, speeds.get("default", 25))) for c in classes},
        "nodes": {
            "x": [int(round((x - lon0) * SCALE)) for x in node[:, 0]],
            "y": [int(round((y - lat0) * SCALE)) for y in node[:, 1]],
            "comp": list(net.component),
        },
        "edges": {
            "u": [e.u for e in net.edges],
            "v": [e.v for e in net.edges],
            "len": [int(round(e.length_m)) for e in net.edges],
            "hw": [cls_idx[base_class(e.highway)] for e in net.edges],
            "segs": [e.segs for e in net.edges],
        },
    }
    sizes["graph.json"] = _dump(out_dir / "graph.json", graph)

    # Snap places to the nearest graph node (in the largest component when close).
    scale = np.array([math.cos(math.radians(float(node[:, 1].mean()))), 1.0])
    tree = cKDTree(node * scale)
    out_places = []
    for p in places:
        d, i = tree.query(np.array([p["lon"], p["lat"]]) * scale)
        dist_m = float(d) * 111_320.0
        if dist_m > 8000:
            continue
        out_places.append({**p, "node": int(i), "snap_m": int(round(dist_m))})
    sizes["places.json"] = _dump(out_dir / "places.json", {"places": out_places})

    sizes["grid.json"] = _dump(out_dir / "grid.json", {"points": [list(p) for p in grid]})
    sizes["events.json"] = _dump(out_dir / "events.json", {"events": events})
    simple = boundary.simplify(0.003, preserve_topology=True)
    sizes["boundary.json"] = _dump(
        out_dir / "boundary.json",
        {"type": "Feature", "properties": {"name": meta.get("region", {}).get("name", "")},
         "geometry": mapping(simple)},
    )
    meta = dict(meta)
    meta["files"] = sizes
    sizes["meta.json"] = _dump(out_dir / "meta.json", meta)
    return sizes


def write_rain(out_dir: Path, name: str, rain: dict[str, Any]) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    return _dump(out_dir / name, rain)
