"""Build the static data for the web app.

    python -m pipeline.build --out web/public/data            # real data (needs internet)
    python -m pipeline.build --out web/public/data --sample   # SAMPLE DATA, no internet

Writes a Markdown build report (counts, warnings, sources) even when it fails.
"""

from __future__ import annotations

import argparse
import datetime as dt
import sys
import traceback
from pathlib import Path

import numpy as np

from . import DATA_VERSION, coolr, dem, features, index, landcover, network, osm, publish, rain
from . import sample as sample_mod
from .common import ROOT, Report, http_session, load_config, setup_logging, utcnow_iso


def _bounds_union(*bs):
    return (min(b[0] for b in bs), min(b[1] for b in bs), max(b[2] for b in bs), max(b[3] for b in bs))


def _save_hillshade(img: np.ndarray, out_dir: Path) -> str:
    from PIL import Image

    path = out_dir / "hillshade.jpg"
    Image.fromarray(img, mode="L").save(path, quality=80, optimize=True, progressive=True)
    return path.name


def _event_counts(events, boundary, report: Report) -> None:
    from shapely.geometry import Point
    from shapely.prepared import prep

    inside = prep(boundary)
    in_state = [e for e in events if inside.contains(Point(e["lon"], e["lat"]))]
    dated = [e for e in in_state if e.get("date")]
    precise = [e for e in dated if e.get("accuracy_m") is not None and e["accuracy_m"] <= 10000]
    report.count("reported_slides_in_bbox", len(events))
    report.count("reported_slides_in_state", len(in_state))
    report.count("reported_slides_in_state_dated", len(dated))
    report.count("reported_slides_dated_within_10km", len(precise))
    years = sorted({e["date"][:4] for e in dated})
    if years:
        report.count("reported_slides_years", f"{years[0]} to {years[-1]}")


def build(out_dir: Path, use_sample: bool, report: Report) -> None:
    region, risk = load_config()
    rcfg, fcfg, raincfg = region["roads"], region["features"], region["rain"]
    utm = region["region"]["utm_epsg"]
    warnings_extra: list[str] = []

    if use_sample:
        report.note("SAMPLE DATA mode: everything below is synthetic")
        session = None
        terrain, center = sample_mod.terrain(utm, fcfg["relief_window_m"])
        ways = sample_mod.roads(utm, center)
        places = sample_mod.places(utm, center)
        boundary = sample_mod.boundary(utm, center)
        events = sample_mod.events(terrain, utm)
        lc = sample_mod.landcover(boundary.buffer(0.05).bounds)
        net = network.build_network(ways, rcfg["segment_target_m"], utm)
    else:
        session = http_session()
        iso = region["region"]["iso3166_2"]
        try:
            boundary = osm.fetch_boundary(iso, session, report)
        except Exception as exc:
            report.warn(f"State boundary not read from OSM ({exc}); using the fallback box")
            boundary = osm.fallback_boundary(region["region"]["fallback_bbox"])
        ways = osm.fetch_roads(iso, rcfg["highway_classes"], session, report)
        report.count("osm_ways", len(ways))
        try:
            places = osm.fetch_places(iso, session, report)
        except Exception as exc:
            report.warn(f"Town names not read ({exc})")
            places = []
        net = network.build_network(ways, rcfg["segment_target_m"], utm)
        ll = np.array([p for s in net.segments for p in s.ll])
        bounds = _bounds_union(boundary.bounds, (ll[:, 0].min(), ll[:, 1].min(), ll[:, 0].max(), ll[:, 1].max()))
        bounds = (bounds[0] - 0.03, bounds[1] - 0.03, bounds[2] + 0.03, bounds[3] + 0.03)
        report.note(f"Working extent (lon/lat): {tuple(round(b, 3) for b in bounds)}")
        tiles = dem.fetch_tiles(bounds, session, report)
        elev, tr, crs = dem.mosaic_to_utm(tiles, bounds, utm)
        report.count("dem_grid", f"{elev.shape[1]} x {elev.shape[0]} px at 30 m")
        terrain = dem.derive_terrain(elev, tr, crs, fcfg["relief_window_m"])
        del elev
        try:
            lc = landcover.fetch(bounds, report)
        except Exception as exc:
            report.warn(f"Land cover skipped ({exc}); its weight is shared out to the other factors")
            lc = None
        try:
            events = coolr.fetch(bounds, session, report)
        except Exception as exc:
            report.warn(f"Reported slides (COOLR) skipped ({exc})")
            events = []

    comp_sizes = np.bincount(np.array(net.component)) if net.component else np.array([0])
    report.count("segments", len(net.segments))
    report.count("graph_nodes", len(net.node_ll))
    report.count("graph_edges", len(net.edges))
    report.count("largest_component_share", f"{comp_sizes.max() / max(1, comp_sizes.sum()):.0%}")
    total_km = sum(s.length_m for s in net.segments) / 1000
    report.count("road_km", round(total_km, 1))
    _event_counts(events, boundary, report)

    feats = features.compute(
        net, terrain, lc, risk["susceptibility"]["landcover_exposure"], events,
        fcfg["sample_step_m"], fcfg["offsets_m"], fcfg["slide_radius_m"],
        fcfg["slide_max_accuracy_m"], utm,
    )
    susc = index.compute(feats, risk)
    counts = np.bincount(susc.sclass, minlength=3)
    report.count("susceptibility_low_moderate_high", f"{counts[0]} / {counts[1]} / {counts[2]}")
    report.count("slope_p90_median_deg", round(float(np.nanmedian(feats.slope_p90)), 1))
    if not feats.has_landcover:
        warnings_extra.append("Land cover unavailable; index uses the other factors only")

    grid = rain.make_grid(boundary, raincfg["grid_step_deg"], raincfg["grid_margin_deg"])
    mids = np.array([s.ll[len(s.ll) // 2] for s in net.segments])
    cells = rain.assign_cells(mids, grid)
    report.count("rain_grid_points", len(grid))

    out_dir.mkdir(parents=True, exist_ok=True)
    hill = None
    try:
        img, hb = dem.hillshade_webmercator(terrain, boundary)
        hill = {"file": _save_hillshade(img, out_dir), "bounds": [round(v, 5) for v in hb]}
        report.note(f"Hillshade image {img.shape[1]} x {img.shape[0]} px")
    except Exception as exc:
        report.warn(f"Hillshade skipped ({exc})")

    meta = {
        "data_version": DATA_VERSION,
        "built_at": utcnow_iso(),
        "sample": use_sample,
        "region": region["region"],
        "bounds": [round(v, 4) for v in boundary.bounds],
        "counts": dict(report.counts),
        "weights_used": susc.weights_used,
        "class_thresholds": susc.thresholds,
        "susceptibility_config": risk["susceptibility"],
        "trigger": risk["trigger"],
        "levels": risk["levels"],
        "replay": region["replay"],
        "rain": {"past_days": raincfg["past_days"], "forecast_days": raincfg["forecast_days"]},
        "hillshade": hill,
        "sources": report.sources,
        "warnings": report.warnings + warnings_extra,
        "disclaimer": (
            "Risk estimate from terrain and rainfall rules. Not a landslide prediction and "
            "not an official warning. Follow IMD and Meghalaya State Disaster Management "
            "Authority advisories. Emergency: 112."
        ),
    }
    sizes = publish.write_static(out_dir, net, feats, susc, cells, grid, places, events,
                                 boundary, meta, rcfg["speed_kmh"])
    for k, v in sizes.items():
        report.count(f"file_{k}_kb", round(v / 1024, 1))

    # Rain: replay window and a first live snapshot.
    rp = region["replay"]
    if use_sample:
        now = dt.datetime.now(dt.timezone.utc).replace(minute=0, second=0, microsecond=0)
        live = sample_mod.rain_series(grid, now - dt.timedelta(hours=24 * raincfg["past_days"]),
                                      24 * (raincfg["past_days"] + raincfg["forecast_days"]),
                                      storm_center_h=24 * raincfg["past_days"] + 6, peak_mm_h=16.0)
        live.update({"mode": "live", "source": "SAMPLE DATA (synthetic storm)", "credit": "",
                     "fetched_at": utcnow_iso(), "sample": True})
        publish.write_rain(out_dir, "rain_latest.json", live)
        start = dt.datetime.fromisoformat(rp["start_date"]).replace(tzinfo=dt.timezone.utc)
        days = (dt.date.fromisoformat(rp["end_date"]) - dt.date.fromisoformat(rp["start_date"])).days + 1
        rep = sample_mod.rain_series(grid, start, 24 * days, storm_center_h=24 * 6 + 10, peak_mm_h=22.0)
        rep.update({"mode": "replay", "source": "SAMPLE DATA (synthetic storm)", "credit": "",
                    "fetched_at": utcnow_iso(), "sample": True})
        rep["event"] = {k: rp[k] for k in ("id", "title", "show_from", "show_to", "note", "source_url")}
        publish.write_rain(out_dir, f"replay_{rp['id']}.json", rep)
    else:
        try:
            rep = rain.fetch_archive(session, grid, rp["start_date"], rp["end_date"], report)
            rep["event"] = {k: rp[k] for k in ("id", "title", "show_from", "show_to", "note", "source_url")}
            publish.write_rain(out_dir, f"replay_{rp['id']}.json", rep)
        except Exception as exc:
            report.warn(f"Replay rain not fetched ({exc})")
        try:
            live = rain.fetch_live(session, grid, raincfg["past_days"], raincfg["forecast_days"], report)
            publish.write_rain(out_dir, "rain_latest.json", live)
        except Exception as exc:
            report.warn(f"Live rain snapshot not fetched ({exc})")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default=str(ROOT / "web" / "public" / "data"))
    ap.add_argument("--sample", action="store_true", help="use synthetic SAMPLE DATA")
    ap.add_argument("--report", default=str(ROOT / "reports" / "build_report.md"))
    args = ap.parse_args(argv)
    setup_logging()
    report = Report("Static data build" + (" (SAMPLE DATA)" if args.sample else ""))
    status = "success"
    try:
        build(Path(args.out), args.sample, report)
    except Exception:
        status = "failed"
        report.warn("Build failed:\n```\n" + traceback.format_exc() + "```")
    rp = Path(args.report)
    rp.parent.mkdir(parents=True, exist_ok=True)
    rp.write_text(report.to_markdown(status), encoding="utf-8")
    print(f"Build {status}; report at {rp}")
    return 0 if status == "success" else 1


if __name__ == "__main__":
    sys.exit(main())
