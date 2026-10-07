# Static data build

- Status: **success**
- Finished: 2026-10-07T19:32:16+00:00 (took 143 s)

## Counts

| Item | Value |
| --- | --- |
| osm_ways | 2103 |
| places | 29 |
| dem_grid | 10263 x 4374 px at 30 m |
| segments | 27569 |
| graph_nodes | 2412 |
| graph_edges | 2690 |
| largest_component_share | 98% |
| road_km | 5362.1 |
| reported_slides_in_bbox | 0 |
| reported_slides_in_state | 0 |
| reported_slides_in_state_dated | 0 |
| reported_slides_dated_within_10km | 0 |
| susceptibility_low_moderate_high | 15837 / 8212 / 3520 |
| slope_p90_median_deg | 15.5 |
| rain_grid_points | 63 |
| file_segments.json_kb | 2975.0 |
| file_graph.json_kb | 230.5 |
| file_places.json_kb | 2.5 |
| file_grid.json_kb | 0.8 |
| file_events.json_kb | 0.0 |
| file_boundary.json_kb | 14.1 |
| file_meta.json_kb | 3.8 |

## Warnings

- Reported slides (COOLR) skipped (404 Client Error: Not Found for url: https://gis.earthdata.nasa.gov/gis05/rest/services/Landslides/COOLR_Reports_Points/FeatureServer/0/query?where=1%3D1&geometry=89.784444%2C25.0006475%2C92.8327367%2C26.14969&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=%2A&returnGeometry=true&outSR=4326&f=geojson&resultOffset=0&resultRecordCount=1000)

## Sources used

| Source | Details |
| --- | --- |
| OpenStreetMap boundary | relation: 2027521; licence: ODbL 1.0, (c) OpenStreetMap contributors; retrieved_at: 2026-10-07T19:29:57+00:00 |
| OpenStreetMap roads | classes: trunk,trunk_link,primary,primary_link,secondary,secondary_link,tertiary,tertiary_link; ways: 2103; licence: ODbL 1.0, (c) OpenStreetMap contributors; retrieved_at: 2026-10-07T19:31:24+00:00 |
| Copernicus DEM GLO-30 | tiles: 8; url: https://copernicus-dem-30m.s3.amazonaws.com; credit: produced using Copernicus WorldDEM-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved; retrieved_at: 2026-10-07T19:31:46+00:00 |
| ESA WorldCover 2021 v200 | tiles: 2; url: https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map; licence: CC BY 4.0, (c) ESA WorldCover project 2021; retrieved_at: 2026-10-07T19:31:57+00:00 |
| Open-Meteo historical (ERA5) | url: https://archive-api.open-meteo.com/v1/archive; points: 63; window: 2022-06-09 to 2022-06-19; retrieved_at: 2026-10-07T19:32:16+00:00 |
| Open-Meteo forecast | url: https://api.open-meteo.com/v1/forecast; points: 63; hours: 192; terms: free API for non-commercial use; CC BY 4.0; retrieved_at: 2026-10-07T19:32:16+00:00 |

## Log

- Overpass answered from https://overpass-api.de/api/interpreter (0.3 MB)
- Overpass answered from https://overpass-api.de/api/interpreter (13.7 MB)
- Overpass answered from https://overpass-api.de/api/interpreter (0.0 MB)
- Working extent (lon/lat): (89.784, 25.001, 92.833, np.float64(26.15))
- Hillshade image 2287 x 1004 px
