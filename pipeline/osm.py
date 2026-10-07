"""OpenStreetMap adapter: state boundary, major roads and town names via Overpass.

Overpass endpoints come from the OSM wiki's list of public instances; the main
FOSSGIS instance asks for fewer than 10,000 queries and 1 GB a day, and this
build makes three queries.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import requests
from shapely.geometry import LineString, MultiPolygon, Polygon, box
from shapely.ops import linemerge, polygonize, unary_union

from .common import Report, log

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]

TOURIST_PLACES = (
    "Dawki|Mawlynnong|Sohra|Cherrapunji|Cherrapunjee|Mawsynram|Pynursla|"
    "Nongriat|Umiam|Mawphlang|Laitlyngkot|Sonapur"
)


@dataclass
class Way:
    id: int
    highway: str
    name: str
    ref: str
    nodes: list[int]
    coords: list[tuple[float, float]]  # (lon, lat)


def overpass(query: str, session: requests.Session, report: Report) -> dict[str, Any]:
    """Run an Overpass query, trying each public endpoint in turn."""
    errors = []
    for url in OVERPASS_ENDPOINTS:
        try:
            log.info("Overpass query via %s", url)
            r = session.post(url, data={"data": query}, timeout=(30, 600))
            r.raise_for_status()
            data = r.json()
            report.note(f"Overpass answered from {url} ({len(r.content) / 1e6:.1f} MB)")
            return data
        except (requests.RequestException, ValueError) as exc:  # ValueError = bad JSON
            errors.append(f"{url}: {exc}")
            log.warning("Overpass endpoint failed: %s", exc)
    raise RuntimeError("All Overpass endpoints failed: " + " | ".join(errors))


def _area_clause(iso: str) -> str:
    return f'area["ISO3166-2"="{iso}"]["admin_level"="4"]->.a;'


def fetch_boundary(iso: str, session: requests.Session, report: Report):
    """Return the state boundary as a shapely (Multi)Polygon in lon/lat."""
    q = (
        "[out:json][timeout:300];"
        f'rel["boundary"="administrative"]["admin_level"="4"]["ISO3166-2"="{iso}"];'
        "out geom;"
    )
    data = overpass(q, session, report)
    rels = [e for e in data.get("elements", []) if e.get("type") == "relation"]
    if not rels:
        raise RuntimeError(f"No boundary relation found for {iso}")
    outer, inner = [], []
    for m in rels[0].get("members", []):
        if m.get("type") != "way" or "geometry" not in m:
            continue
        line = LineString([(p["lon"], p["lat"]) for p in m["geometry"]])
        (inner if m.get("role") == "inner" else outer).append(line)
    outer_polys = list(polygonize(linemerge(outer)))
    if not outer_polys:
        raise RuntimeError("Boundary rings did not close")
    shape = unary_union(outer_polys)
    if inner:
        holes = unary_union(list(polygonize(linemerge(inner))))
        shape = shape.difference(holes)
    if isinstance(shape, Polygon):
        shape = MultiPolygon([shape])
    report.source(
        "OpenStreetMap boundary",
        relation=rels[0].get("id"),
        licence="ODbL 1.0, (c) OpenStreetMap contributors",
    )
    return shape


def fallback_boundary(bbox: list[float]):
    return MultiPolygon([box(*bbox)])


def fetch_roads(iso: str, classes: list[str], session: requests.Session,
                report: Report) -> list[Way]:
    pattern = "|".join(classes)
    q = (
        "[out:json][timeout:600];"
        + _area_clause(iso)
        + f'(way["highway"~"^({pattern})$"](area.a););'
        + "out geom;"
    )
    data = overpass(q, session, report)
    ways = parse_ways(data)
    report.source(
        "OpenStreetMap roads",
        classes=",".join(classes),
        ways=len(ways),
        licence="ODbL 1.0, (c) OpenStreetMap contributors",
    )
    return ways


def parse_ways(data: dict[str, Any]) -> list[Way]:
    ways = []
    for e in data.get("elements", []):
        if e.get("type") != "way":
            continue
        geom = e.get("geometry") or []
        nodes = e.get("nodes") or []
        if len(geom) < 2 or len(geom) != len(nodes):
            continue
        tags = e.get("tags", {})
        ways.append(
            Way(
                id=int(e["id"]),
                highway=tags.get("highway", "unclassified"),
                name=tags.get("name:en") or tags.get("name") or "",
                ref=tags.get("ref", ""),
                nodes=[int(n) for n in nodes],
                coords=[(float(p["lon"]), float(p["lat"])) for p in geom],
            )
        )
    return ways


def fetch_places(iso: str, session: requests.Session, report: Report) -> list[dict[str, Any]]:
    q = (
        "[out:json][timeout:300];"
        + _area_clause(iso)
        + '(node["place"~"^(city|town)$"](area.a);'
        + f'node["place"~"^(village|hamlet|suburb)$"]["name"~"^({TOURIST_PLACES})$"](area.a););'
        + "out;"
    )
    data = overpass(q, session, report)
    places = []
    seen = set()
    for e in data.get("elements", []):
        tags = e.get("tags", {})
        name = tags.get("name:en") or tags.get("name")
        if not name or name in seen:
            continue
        seen.add(name)
        places.append(
            {
                "name": name,
                "lon": round(float(e["lon"]), 5),
                "lat": round(float(e["lat"]), 5),
                "kind": tags.get("place", ""),
            }
        )
    places.sort(key=lambda p: p["name"])
    report.count("places", len(places))
    return places
