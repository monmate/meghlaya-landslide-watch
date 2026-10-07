"""Unit tests for the geometry and index logic (no network needed)."""

from __future__ import annotations

import math

import numpy as np
import pytest
from pyproj import Transformer

from pipeline import coolr, features, index, network, rain
from pipeline.dem import derive_terrain, synthetic_transform
from pipeline.osm import Way

UTM = 32646


def _way(way_id, pts_utm, node_ids, highway="primary"):
    to_ll = Transformer.from_crs(f"EPSG:{UTM}", "EPSG:4326", always_xy=True)
    xs, ys = zip(*pts_utm)
    lon, lat = to_ll.transform(xs, ys)
    return Way(id=way_id, highway=highway, name="", ref="", nodes=node_ids,
               coords=list(zip(lon, lat)))


def _plane_terrain(rise_east_per_m: float, rise_north_per_m: float):
    """A tilted plane: z = a*x + b*y, on a 30 m UTM grid around (500 km, 2820 km)."""
    res = 30.0
    w = h = 400
    x0, y0 = 494_000.0, 2_826_000.0
    xs = x0 + (np.arange(w) + 0.5) * res
    ys = y0 - (np.arange(h) + 0.5) * res
    X, Y = np.meshgrid(xs, ys)
    z = (rise_east_per_m * (X - x0) + rise_north_per_m * (Y - (y0 - h * res))).astype(np.float32)
    return derive_terrain(z, synthetic_transform(x0, y0, res), f"EPSG:{UTM}", 330)


def test_horn_slope_and_gradient_signs():
    t = _plane_terrain(0.5, 0.0)
    inner = t.slope[5:-5, 5:-5]
    assert np.allclose(inner, math.degrees(math.atan(0.5)), atol=0.05)
    assert np.allclose(t.dzdx[5:-5, 5:-5], 0.5, atol=1e-3)
    assert np.allclose(t.dzdn[5:-5, 5:-5], 0.0, atol=1e-3)
    t2 = _plane_terrain(0.0, 0.25)  # rises toward the north
    assert np.allclose(t2.dzdn[5:-5, 5:-5], 0.25, atol=1e-3)


def test_segments_are_about_200_m_and_share_nodes():
    a = _way(1, [(500_000, 2_820_000), (500_000, 2_821_000)], [1, 2])
    b = _way(2, [(500_000, 2_821_000), (500_550, 2_821_000)], [2, 3])
    net = network.build_network([a, b], 200, UTM)
    lengths = [s.length_m for s in net.segments]
    assert len(net.edges) == 2
    assert sum(lengths) == pytest.approx(1550, rel=0.01)
    assert all(150 <= L <= 300 for L in lengths)
    assert len(net.node_ll) == 3  # the shared node is one vertex
    assert set(net.component) == {0}


def test_way_split_at_interior_shared_node():
    a = _way(1, [(500_000, 2_820_000), (500_000, 2_820_500), (500_000, 2_821_000)], [1, 5, 2])
    b = _way(2, [(499_500, 2_820_500), (500_000, 2_820_500)], [7, 5])
    net = network.build_network([a, b], 200, UTM)
    assert len(net.edges) == 3  # way a split at node 5


def test_cross_slope_depends_on_road_direction():
    t = _plane_terrain(0.5, 0.0)  # hillside rises to the east
    ns = _way(1, [(500_000, 2_816_000), (500_000, 2_817_000)], [1, 2])  # road runs north
    ew = _way(2, [(499_000, 2_818_000), (500_000, 2_818_000)], [3, 4])  # road runs east
    net = network.build_network([ns, ew], 200, UTM)
    f = features.compute(net, t, None, {}, [], 30, [-100, -50, 0, 50, 100], 1000, 5000, UTM)
    by_edge = {}
    for s in net.segments:
        by_edge.setdefault(s.edge, []).append(f.cross_slope[s.id])
    north_road = np.nanmedian(by_edge[0])
    east_road = np.nanmedian(by_edge[1])
    assert north_road == pytest.approx(math.degrees(math.atan(0.5)), abs=0.5)
    assert east_road == pytest.approx(0.0, abs=0.5)


def test_index_ramps_and_classes():
    n = 100
    slope = np.linspace(5, 40, n).astype(np.float32)
    f = features.SegmentFeatures(
        slope_p90=slope,
        relief=np.full(n, 100, np.float32),
        cross_slope=np.full(n, 10, np.float32),
        elev_mid=np.zeros(n, np.float32),
        landcover_exposure=np.full(n, np.nan, np.float32),
        landcover_major=np.zeros(n, np.uint8),
        past_slides=np.zeros(n, np.int32),
        has_landcover=False,
    )
    cfg = {
        "susceptibility": {
            "weights": {"slope": 0.4, "relief": 0.15, "cross_slope": 0.15, "landcover": 0.15, "past_slides": 0.15},
            "ramps": {"slope_p90_deg": [10, 35], "relief_m": [30, 250], "cross_slope_deg": [5, 30],
                      "past_slides_count": [0, 3]},
            "landcover_exposure": {},
            "flat_slope_deg": 8,
            "classes": {"moderate_quantile": 0.5, "high_quantile": 0.85},
        }
    }
    s = index.compute(f, cfg)
    assert "landcover" not in s.weights_used
    assert sum(s.weights_used.values()) == pytest.approx(1.0, abs=0.01)
    assert np.all(np.diff(s.index) >= -1e-9)  # steeper never scores lower here
    assert s.sclass[0] == 0  # flat segment
    assert s.sclass[-1] == 2
    hill = slope >= 8
    assert (s.sclass[hill] == 2).mean() == pytest.approx(0.15, abs=0.03)


@pytest.mark.parametrize(
    "text,expected",
    [("exact", 100.0), ("5km", 5000.0), ("25 km", 25000.0), ("unknown", None), (None, None)],
)
def test_coolr_accuracy(text, expected):
    assert coolr.accuracy_m(text) == expected


def test_coolr_dates():
    assert coolr.parse_date(1655424000000) == "2022-06-17"
    assert coolr.parse_date("2022-06-17T05:00:00") == "2022-06-17"
    assert coolr.parse_date("") is None


def test_rain_grid_and_cells():
    from shapely.geometry import box

    grid = rain.make_grid(box(91.0, 25.0, 92.0, 25.5), 0.25, 0.1)
    assert (91.0, 25.0) in grid and (92.0, 25.5) in grid
    cells = rain.assign_cells(np.array([[91.02, 25.01], [91.98, 25.49]]), grid)
    assert grid[cells[0]] == (91.0, 25.0)
    assert grid[cells[1]] == (92.0, 25.5)
