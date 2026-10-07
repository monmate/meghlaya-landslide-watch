# Landslide Watch, Meghalaya

A web app that estimates landslide risk on Meghalaya's main roads, hour by hour,
from terrain and rainfall. It shows a statewide risk map with a rain timeline,
checks a trip for the safest route and departure time, and has a Car Mode that
speaks alerts before risky stretches.

**Live site:** https://monmate.github.io/meghlaya-landslide-watch/

> This is a risk estimate, not a landslide prediction and not an official
> warning. Follow IMD and Meghalaya State Disaster Management Authority
> advisories. Emergency: 112.

## What is real and what is not

| Part | Status |
| --- | --- |
| Road network | Real: OpenStreetMap trunk, primary, secondary and tertiary roads in Meghalaya, cut into ~200 m segments |
| Terrain | Real: Copernicus DEM GLO-30 slope, relief and cross-slope; ESA WorldCover land cover |
| Reported slides | Real: NASA COOLR records (location accuracy varies) |
| Rain | Real model data from Open-Meteo, refreshed hourly; replay uses ERA5 reanalysis for June 2022 |
| Risk rule | **Not fitted to landslide data.** Documented default weights plus IMD's 24-hour rain categories (see `config/risk.yaml`) |
| Reports | Demo only: saved in the browser, not sent anywhere |

If the real data build has not run yet, the site shows **Sample data** and
every road, slope and storm is synthetic.

## How it works

1. **Once:** `pipeline/build.py` downloads roads, the boundary and town names
   (Overpass), the DEM and land cover, and reported slides. It scores every
   segment and publishes compact JSON to `web/public/data/`.
2. **Every hour:** GitHub Actions fetches fresh rain from Open-Meteo and
   redeploys the site.
3. **In the browser:** the app turns rain into a trigger step per hour using
   IMD's categories (heavy 64.5 mm, very heavy 115.6 mm, extremely heavy
   204.5 mm in 24 h, one step higher on wet ground) and combines it with the
   terrain class. Routing runs in the browser on the road graph.

Details: `docs/METHODOLOGY.md`. Sources and licences: `docs/DATA_SOURCES.md`.
Known limits: `docs/LIMITATIONS.md`. Demo click path: `docs/DEMO_SCRIPT.md`.

## Running it

Everything runs on GitHub; nobody needs to install anything to use the site.

- **Rebuild the data** (after changing `config/*.yaml`): on GitHub open
  **Actions → Build data and deploy site → Run workflow**, tick *Rebuild roads
  and terrain data*, then **Run workflow**. Takes about 10 to 20 minutes. The
  result is written to `reports/build_report.md`.
- **Locally** (optional, needs Python 3.13 and Node 22):

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r pipeline/requirements.txt
python -m pytest pipeline/tests -q
python -m pipeline.build --sample --out web/public/data   # synthetic data, no internet
# or: python -m pipeline.build --out web/public/data       # real data, needs internet
cd web && npm ci && npm test && npm run dev
```

## Repository layout

```
config/            region and risk settings (weights, thresholds, replay window)
pipeline/          data adapters, segmentation, features, index, publishing, tests
web/               React + TypeScript + Vite + MapLibre app
web/public/data/   published data the app loads
reports/           build reports committed by GitHub Actions
docs/              methodology, sources, limits, demo script
.github/workflows/ build and deploy
```

## Credits

Map data © OpenStreetMap contributors (ODbL). Basemap by OpenFreeMap and
OpenMapTiles. Produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and
© Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the
European Union and ESA; all rights reserved. ESA WorldCover 2021 (CC BY 4.0).
Weather data by Open-Meteo.com (CC BY 4.0). Landslide reports from NASA COOLR.
