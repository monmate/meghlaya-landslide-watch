"""NASA COOLR adapter (includes the Global Landslide Catalog).

Public ArcGIS feature service; standard ArcGIS REST query parameters; 2,000
records per page at most. The service states no licence, so treat these
records as "terms unverified" until NASA's terms are confirmed.
"""

from __future__ import annotations

import datetime as dt
import re
from typing import Any

from .common import Report, log

URL = (
    "https://gis.earthdata.nasa.gov/gis05/rest/services/Landslides/"
    "COOLR_Reports_Points/FeatureServer/0/query"
)

_ACC = re.compile(r"(\d+(?:\.\d+)?)\s*(km|m)\b", re.I)


def accuracy_m(text: Any) -> float | None:
    """Parse COOLR location accuracy ('exact', '5km', '25km', 'unknown')."""
    if text is None:
        return None
    s = str(text).strip().lower()
    if s in ("exact", "exact location"):
        return 100.0
    m = _ACC.search(s)
    if not m:
        return None
    value = float(m.group(1))
    return value * 1000.0 if m.group(2).lower() == "km" else value


def parse_date(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        # ArcGIS dates are milliseconds since the epoch, UTC.
        return dt.datetime.fromtimestamp(value / 1000.0, tz=dt.timezone.utc).date().isoformat()
    s = str(value).strip()
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    for fmt in ("%m/%d/%Y", "%Y/%m/%d"):
        try:
            return dt.datetime.strptime(s.split()[0], fmt).date().isoformat()
        except ValueError:
            continue
    return None


def _first(props: dict[str, Any], *keys: str) -> Any:
    for k in keys:
        if k in props and props[k] not in (None, ""):
            return props[k]
    return None


def fetch(bounds, session, report: Report) -> list[dict[str, Any]]:
    minx, miny, maxx, maxy = bounds
    events: list[dict[str, Any]] = []
    offset = 0
    page = 1000
    while True:
        params = {
            "where": "1=1",
            "geometry": f"{minx},{miny},{maxx},{maxy}",
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "*",
            "returnGeometry": "true",
            "outSR": "4326",
            "f": "geojson",
            "resultOffset": offset,
            "resultRecordCount": page,
        }
        r = session.get(URL, params=params, timeout=(20, 120))
        r.raise_for_status()
        data = r.json()
        if "error" in data:
            raise RuntimeError(f"COOLR query error: {data['error']}")
        feats = data.get("features", [])
        for f in feats:
            geom = f.get("geometry") or {}
            coords = geom.get("coordinates") or [None, None]
            if coords[0] is None:
                continue
            p = f.get("properties") or {}
            events.append(
                {
                    "lon": round(float(coords[0]), 5),
                    "lat": round(float(coords[1]), 5),
                    "date": parse_date(_first(p, "event_date", "date", "event_date_utc")),
                    "accuracy_m": accuracy_m(_first(p, "location_accuracy", "location_accuracy_text")),
                    "accuracy_text": str(_first(p, "location_accuracy") or ""),
                    "trigger": str(_first(p, "landslide_trigger", "trigger") or ""),
                    "title": str(_first(p, "event_title", "location_description", "event_description") or "")[:160],
                    "source": str(_first(p, "source_name", "event_import_source") or ""),
                    "url": str(_first(p, "source_link") or ""),
                }
            )
        exceeded = data.get("exceededTransferLimit") or (data.get("properties") or {}).get("exceededTransferLimit")
        if len(feats) < page and not exceeded:
            break
        offset += len(feats)
        if not feats:
            break
    log.info("COOLR events in bbox: %d", len(events))
    report.source("NASA COOLR (incl. Global Landslide Catalog)", url=URL, events=len(events),
                  terms="not stated on the service; unverified")
    return events
