"""Fetch the latest rain for the live view (run hourly by GitHub Actions).

    python -m pipeline.snapshot --data web/public/data

Never fails the deploy: on error it keeps the previous snapshot and says so.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import publish, rain
from .common import ROOT, Report, http_session, load_config, setup_logging


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", default=str(ROOT / "web" / "public" / "data"))
    args = ap.parse_args(argv)
    setup_logging()
    data_dir = Path(args.data)
    grid_file = data_dir / "grid.json"
    if not grid_file.exists():
        print("No grid.json yet; run the static build first")
        return 0
    meta = json.loads((data_dir / "meta.json").read_text(encoding="utf-8"))
    if meta.get("sample"):
        print("Static data is SAMPLE DATA; keeping the synthetic rain")
        return 0
    region, _ = load_config()
    grid = [tuple(p) for p in json.loads(grid_file.read_text(encoding="utf-8"))["points"]]
    report = Report("Rain snapshot")
    try:
        live = rain.fetch_live(http_session(), grid, region["rain"]["past_days"],
                               region["rain"]["forecast_days"], report)
        publish.write_rain(data_dir, "rain_latest.json", live)
        print(f"Rain snapshot written: {len(grid)} points, {len(live['times'])} hours")
    except Exception as exc:
        print(f"Rain snapshot failed, keeping the previous one: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
