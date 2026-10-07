"""Turn OSM ways into a routable graph and ~200 m road segments.

Lengths and cuts are computed in UTM 46N (metres); geometry is stored in WGS 84.
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field

import numpy as np
from pyproj import Transformer
from shapely.geometry import LineString
from shapely.ops import substring

from .osm import Way


@dataclass
class Segment:
    id: int
    edge: int
    highway: str
    name: str
    ref: str
    length_m: float
    utm: LineString
    ll: list[tuple[float, float]]


@dataclass
class Edge:
    id: int
    u: int
    v: int
    highway: str
    length_m: float
    segs: list[int] = field(default_factory=list)


@dataclass
class Network:
    node_ll: list[tuple[float, float]]
    edges: list[Edge]
    segments: list[Segment]
    component: list[int]  # component id per node


def transformers(utm_epsg: int) -> tuple[Transformer, Transformer]:
    to_utm = Transformer.from_crs("EPSG:4326", f"EPSG:{utm_epsg}", always_xy=True)
    to_ll = Transformer.from_crs(f"EPSG:{utm_epsg}", "EPSG:4326", always_xy=True)
    return to_utm, to_ll


def base_class(highway: str) -> str:
    return highway.replace("_link", "")


def build_network(ways: list[Way], target_m: float, utm_epsg: int) -> Network:
    """Split ways at shared nodes into edges, then cut edges into segments."""
    to_utm, to_ll = transformers(utm_epsg)

    # A node becomes a graph vertex if it ends a way or is shared by several ways.
    usage: dict[int, int] = defaultdict(int)
    for w in ways:
        for n in w.nodes:
            usage[n] += 1
        usage[w.nodes[0]] += 1
        usage[w.nodes[-1]] += 1

    vertex_index: dict[int, int] = {}
    node_ll: list[tuple[float, float]] = []

    def vid(osm_id: int, ll: tuple[float, float]) -> int:
        if osm_id not in vertex_index:
            vertex_index[osm_id] = len(node_ll)
            node_ll.append((round(ll[0], 6), round(ll[1], 6)))
        return vertex_index[osm_id]

    edges: list[Edge] = []
    segments: list[Segment] = []

    for w in ways:
        start = 0
        for i in range(1, len(w.nodes)):
            if usage[w.nodes[i]] > 1 or i == len(w.nodes) - 1:
                part_ll = w.coords[start : i + 1]
                u = vid(w.nodes[start], w.coords[start])
                v = vid(w.nodes[i], w.coords[i])
                start = i
                if len(part_ll) < 2:
                    continue
                xs, ys = to_utm.transform(*zip(*part_ll))
                line = LineString(list(zip(xs, ys)))
                length = float(line.length)
                if length < 1.0:
                    continue
                edge = Edge(id=len(edges), u=u, v=v, highway=w.highway, length_m=length)
                n = max(1, int(round(length / target_m)))
                for k in range(n):
                    piece = substring(line, k * length / n, (k + 1) * length / n)
                    if piece.is_empty or piece.geom_type != "LineString":
                        continue
                    px, py = piece.xy
                    lon, lat = to_ll.transform(list(px), list(py))
                    seg = Segment(
                        id=len(segments),
                        edge=edge.id,
                        highway=w.highway,
                        name=w.name,
                        ref=w.ref,
                        length_m=float(piece.length),
                        utm=piece,
                        ll=[(round(a, 5), round(b, 5)) for a, b in zip(lon, lat)],
                    )
                    segments.append(seg)
                    edge.segs.append(seg.id)
                if edge.segs:
                    edges.append(edge)

    component = connected_components(len(node_ll), edges)
    return Network(node_ll=node_ll, edges=edges, segments=segments, component=component)


def connected_components(n_nodes: int, edges: list[Edge]) -> list[int]:
    parent = list(range(n_nodes))

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for e in edges:
        ra, rb = find(e.u), find(e.v)
        if ra != rb:
            parent[ra] = rb
    roots = [find(i) for i in range(n_nodes)]
    # Renumber so the biggest component is 0.
    sizes: dict[int, int] = defaultdict(int)
    for r in roots:
        sizes[r] += 1
    order = {r: i for i, (r, _) in enumerate(sorted(sizes.items(), key=lambda kv: -kv[1]))}
    return [order[r] for r in roots]


def sample_points(seg: Segment, step_m: float, offsets_m: list[float]):
    """Points along a segment and across it, in UTM.

    Returns (xs, ys, on_line_mask, normals) where normals are the unit normal
    vectors at each sample (used for the cross-slope).
    """
    line = seg.utm
    length = line.length
    n_along = max(2, int(math.ceil(length / step_m)) + 1)
    dists = np.linspace(0.0, length, n_along)
    pts = [line.interpolate(d) for d in dists]
    base_x = np.array([p.x for p in pts])
    base_y = np.array([p.y for p in pts])
    # Tangent from neighbouring samples (forward/back differences at the ends).
    tx = np.gradient(base_x)
    ty = np.gradient(base_y)
    norm = np.hypot(tx, ty)
    norm[norm == 0] = 1.0
    tx, ty = tx / norm, ty / norm
    nx, ny = -ty, tx  # left-hand normal
    xs, ys, on_line, normals = [], [], [], []
    for off in offsets_m:
        xs.append(base_x + nx * off)
        ys.append(base_y + ny * off)
        on_line.append(np.full(n_along, off == 0))
        normals.append(np.stack([nx, ny], axis=1))
    return (
        np.concatenate(xs),
        np.concatenate(ys),
        np.concatenate(on_line),
        np.concatenate(normals),
    )


def bearing_deg(seg: Segment) -> float:
    (x0, y0), (x1, y1) = seg.utm.coords[0], seg.utm.coords[-1]
    return (math.degrees(math.atan2(x1 - x0, y1 - y0)) + 360.0) % 360.0
