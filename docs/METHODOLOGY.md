# Methodology (hackathon build)

The app gives each road segment a **risk level per hour**: Low, Moderate, High
or Severe. It is a transparent, rules-based estimate. Nothing in it has been
fitted to or validated against landslide records yet.

## 1. Road segments

- OpenStreetMap ways tagged trunk, primary, secondary or tertiary (and their
  links) inside Meghalaya's OSM boundary.
- Ways are split where they meet, giving a routable graph, then each edge is
  cut into equal pieces of about 200 m (in UTM 46N metres).

## 2. Terrain score (built once)

Each segment is sampled every ~30 m along the road and at -100, -50, 0, 50 and
100 m across it, so the slope above and below the road counts.

| Factor | Measure | Scores 0 at | Scores 1 at | Weight |
| --- | --- | --- | --- | --- |
| Slope | 90th percentile of slope across all samples | 10° | 35° | 40% |
| Relief | Height range within ~330 m | 30 m | 250 m | 15% |
| Cross-slope | How steeply the hillside falls across the road | 5° | 30° | 15% |
| Land cover | ESA WorldCover exposure (forest 0.2 to bare ground 1.0) | | | 15% |
| Reported slides | NASA COOLR reports within max(1 km, their location accuracy), only those located within 5 km | 0 | 3 | 15% |

If a factor cannot be computed, its weight is shared out to the others (the
build report says so). Classes are **relative**: among hillside segments (90th
percentile slope of 8° or more), the top 15% are High and the next 35% are
Moderate. Flatter segments stay Low.

## 3. Rain trigger (every hour)

- Rain: hourly precipitation from Open-Meteo on a 0.25° grid (about 25 km).
  Each segment uses its nearest grid point.
- 24-hour total ending at that hour, placed in IMD's categories: heavy from
  64.5 mm, very heavy from 115.6 mm, extremely heavy from 204.5 mm.
- Wet ground: if the 72 hours before that window brought 150 mm or more, the
  trigger moves up one step (a provisional rule).

## 4. Risk level

| Terrain class \ 24 h rain | Below heavy | Heavy | Very heavy | Extremely heavy |
| --- | --- | --- | --- | --- |
| Low | Low | Low | Moderate | High |
| Moderate | Low | Moderate | High | Severe |
| High | Low | High | Severe | Severe |

## 5. Routes and departure times

- **Fastest:** shortest travel time on the road graph (speed assumptions per
  road class in `config/region.yaml`).
- **Safer:** travel time multiplied by (1 + penalty) for the level each
  segment will have when the car reaches it: Moderate 0.25, High 3, Severe 20.
- **Best time to leave:** the fastest path re-scored for each departure hour in
  the next 24 hours; the app suggests the earliest hour with the lowest worst
  level.

## 6. What would make this a trained model

Dated, accurately located landslide records on these roads (MSDMA, PWD, NHAI
logs), plus rain-gauge data to measure satellite and model bias. With about 30
or more dated events a rain threshold can be fitted with an uncertainty band;
with 100 or more, a learned trigger can be compared against it. Until then the
numbers above are documented defaults.
