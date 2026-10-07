// Loading and decoding the published data files.

import type { GraphRaw, Meta, Place, RainData, Segments, SegmentsRaw, SlideEvent } from "./types";

const BASE = `${import.meta.env.BASE_URL}data/`;

async function getJson<T>(name: string): Promise<T> {
  const r = await fetch(BASE + name, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

export interface StaticData {
  meta: Meta;
  segs: Segments;
  graph: GraphRaw;
  places: Place[];
  events: SlideEvent[];
  grid: [number, number][];
  boundary: GeoJSON.Feature;
}

export function decodeSegments(raw: SegmentsRaw): Segments {
  const [ox, oy] = raw.origin;
  const k = raw.scale;
  const coords = raw.geom.map((flat) => {
    const out: [number, number][] = [];
    let x = flat[0];
    let y = flat[1];
    out.push([ox + x / k, oy + y / k]);
    for (let i = 2; i < flat.length; i += 2) {
      x += flat[i];
      y += flat[i + 1];
      out.push([ox + x / k, oy + y / k]);
    }
    return out;
  });
  return { raw, coords, n: raw.count };
}

export async function loadStatic(): Promise<StaticData> {
  const [meta, segRaw, graph, places, events, grid, boundary] = await Promise.all([
    getJson<Meta>("meta.json"),
    getJson<SegmentsRaw>("segments.json"),
    getJson<GraphRaw>("graph.json"),
    getJson<{ places: Place[] }>("places.json"),
    getJson<{ events: SlideEvent[] }>("events.json"),
    getJson<{ points: [number, number][] }>("grid.json"),
    getJson<GeoJSON.Feature>("boundary.json"),
  ]);
  return {
    meta,
    segs: decodeSegments(segRaw),
    graph,
    places: places.places,
    events: events.events,
    grid: grid.points,
    boundary,
  };
}

export type RainOrigin = "snapshot" | "live-api" | "replay";

const FRESH_MS = 90 * 60 * 1000;

/**
 * Live rain: use the hourly snapshot published with the site when it is fresh;
 * otherwise try Open-Meteo directly from the browser, then fall back to the
 * snapshot (marked stale by the caller if it no longer covers now).
 */
export async function loadLiveRain(meta: Meta, grid: [number, number][]): Promise<{ rain: RainData; origin: RainOrigin }> {
  let snapshot: RainData | null = null;
  try {
    snapshot = await getJson<RainData>("rain_latest.json");
  } catch {
    snapshot = null;
  }
  const fresh = snapshot && Date.now() - Date.parse(snapshot.fetched_at) < FRESH_MS;
  if (snapshot && (fresh || meta.sample || snapshot.sample)) return { rain: snapshot, origin: "snapshot" };
  try {
    const rain = await fetchOpenMeteo(grid, meta.rain.past_days, meta.rain.forecast_days);
    return { rain, origin: "live-api" };
  } catch {
    if (snapshot) return { rain: snapshot, origin: "snapshot" };
    throw new Error("No rain data available");
  }
}

export async function loadReplay(meta: Meta): Promise<RainData> {
  return getJson<RainData>(`replay_${meta.replay.id}.json`);
}

async function fetchOpenMeteo(grid: [number, number][], pastDays: number, forecastDays: number): Promise<RainData> {
  const BATCH = 50;
  let times: string[] = [];
  const precip: number[][] = [];
  for (let i = 0; i < grid.length; i += BATCH) {
    const chunk = grid.slice(i, i + BATCH);
    const q = new URLSearchParams({
      latitude: chunk.map((p) => p[1].toFixed(4)).join(","),
      longitude: chunk.map((p) => p[0].toFixed(4)).join(","),
      hourly: "precipitation",
      past_days: String(pastDays),
      forecast_days: String(forecastDays),
      timezone: "UTC",
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
    const data = await r.json();
    const items = Array.isArray(data) ? data : [data];
    if (items.length !== chunk.length) throw new Error("Open-Meteo location count mismatch");
    for (const it of items) {
      if (!times.length) times = it.hourly.time;
      precip.push(it.hourly.precipitation.map((v: number | null) => (v == null ? 0 : Math.round(v * 10) / 10)));
    }
  }
  return {
    mode: "live",
    times,
    precip,
    source: "Open-Meteo forecast API (best-match weather models)",
    credit: "Weather data by Open-Meteo.com (CC BY 4.0)",
    fetched_at: new Date().toISOString(),
    sample: false,
  };
}
