# Data sources

Checked against official pages on 7 Oct 2026. "Unverified" means the terms
were not found and must be confirmed before commercial use.

| Source | Used for | Access | Licence and terms |
| --- | --- | --- | --- |
| OpenStreetMap via Overpass API | Roads, state boundary, town names | Public Overpass instances, no login | ODbL 1.0; credit "© OpenStreetMap contributors". A published roads-plus-risk dataset is likely a derivative database that must stay ODbL |
| Copernicus DEM GLO-30 | Slope, relief, cross-slope, hillshade | AWS open bucket `copernicus-dem-30m` | Free incl. commercial use, with the credit line in the README. Surface model: includes trees and buildings |
| ESA WorldCover 2021 v200 | Land cover exposure | AWS bucket `esa-worldcover`, no account | CC BY 4.0 |
| NASA COOLR (incl. Global Landslide Catalog) | Reported slides near roads | Public ArcGIS feature service | Unverified: no terms on the service |
| Open-Meteo forecast API | Live and forecast rain | Free API, no key | Data CC BY 4.0; the free API is for non-commercial use only |
| Open-Meteo historical API (ERA5) | June 2022 replay | Free API, no key | As above |
| IMD rainfall categories | Rain trigger thresholds | IMD national bulletins | Public bulletin |
| OpenFreeMap | Basemap tiles | No key | Credit OpenFreeMap, OpenMapTiles, OpenStreetMap |

Not used in this build but planned: GPM IMERG (needs NASA Earthdata login),
ERA5-Land via the Copernicus CDS, SMAP soil moisture, SoilGrids, GSI Bhukosh
geology and landslide inventory, IMD gauge data (paid; no third-party
sharing), NASA LHASA as a benchmark.
