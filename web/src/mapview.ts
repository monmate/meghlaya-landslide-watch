// MapLibre wrapper: basemap, hillshade, road risk, slides, rain, routes, car.
// Imperative on purpose: React state changes call small setter methods here.

import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";
// MapLibre v6 looks for its worker next to its own module; Vite bundles the
// worker separately, so point MapLibre at the bundled file.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { Meta, SlideEvent } from "./types";

const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
const BASEMAP_CREDIT =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' +
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a> ' +
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

maplibregl.setWorkerUrl(workerUrl);

export const RISK_LIGHT = ["#86ab9e", "#d9a521", "#d65a22", "#8b1c45"];
export const RISK_DARK = ["#6f9c8f", "#f0c350", "#f27c3f", "#ec5b8c"];

export interface MapCallbacks {
  onSegment: (seg: number, lngLat: [number, number]) => void;
  onEvent: (ev: SlideEvent) => void;
  onReady: () => void;
}

const FALLBACK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: "bg", type: "background", paint: { "background-color": "#e4e9e6" } }],
};

const WORLD: GeoJSON.Feature = {
  type: "Feature",
  properties: {},
  geometry: { type: "Polygon", coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] },
};

// Each segment's level for the selected hour lives in feature-state ("lv"), so
// moving the slider only touches roads whose level changed. Terrain mode reads
// the static class from the feature's properties.
function levelExpr(terrain: boolean): maplibregl.ExpressionSpecification {
  return terrain ? ["get", "sc"] : ["coalesce", ["feature-state", "lv"], 0];
}

export class MapView {
  map: MLMap;
  private ready = false;
  private hour = 0;
  private terrain = false;
  private dark = false;
  private pulseTimer = 0;
  private hasSevere = false;
  private carMoving = false;
  private levels: string[] | null = null;
  private cur: Int8Array | null = null;
  private feats: GeoJSON.Feature[] = [];
  private marker: maplibregl.Marker | null = null;
  private reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(container: HTMLElement, private meta: Meta, private cb: MapCallbacks) {
    const [w, s, e, n] = meta.bounds;
    this.map = new maplibregl.Map({
      container,
      style: FALLBACK_STYLE,
      bounds: [[w, s], [e, n]],
      fitBoundsOptions: { padding: 24 },
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    this.map.addControl(
      new maplibregl.AttributionControl({ compact: true, customAttribution: BASEMAP_CREDIT }),
      "bottom-right",
    );
    this.map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
    void this.loadBasemap();
  }

  private async loadBasemap() {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(STYLE_URL, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) throw new Error(String(r.status));
      const style = (await r.json()) as maplibregl.StyleSpecification;
      // diff: false forces a full reload, so "style.load" fires and our layers are re-added.
      this.map.setStyle(style, { diff: false });
    } catch {
      // Offline or blocked: keep the plain background so the risk layers still show.
    }
    const add = () => this.addLayers();
    if (this.map.isStyleLoaded()) add();
    else this.map.once("style.load", add);
    // setStyle may finish after a fallback "load"; make sure layers exist either way.
    this.map.once("idle", () => {
      if (!this.map.getSource("segs")) this.addLayers();
    });
  }

  private firstSymbolLayer(): string | undefined {
    return this.map.getStyle().layers.find((l) => l.type === "symbol")?.id;
  }

  private addLayers() {
    if (this.map.getSource("segs")) return;
    const before = this.firstSymbolLayer();
    const m = this.map;
    const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

    m.addSource("world", { type: "geojson", data: WORLD });
    m.addLayer(
      { id: "night", type: "fill", source: "world", paint: { "fill-color": "#0f1915", "fill-opacity": 0.8 }, layout: { visibility: "none" } },
      before,
    );
    if (this.meta.hillshade) {
      const [x0, y0, x1, y1] = this.meta.hillshade.bounds;
      m.addSource("hillshade", {
        type: "image",
        url: `${import.meta.env.BASE_URL}data/${this.meta.hillshade.file}`,
        coordinates: [[x0, y1], [x1, y1], [x1, y0], [x0, y0]],
      });
      m.addLayer(
        { id: "hillshade", type: "raster", source: "hillshade", paint: { "raster-opacity": 0.32, "raster-fade-duration": 0 } },
        before,
      );
    }
    m.addSource("boundary", { type: "geojson", data: empty });
    m.addLayer(
      { id: "boundary", type: "line", source: "boundary", paint: { "line-color": "#4e6158", "line-width": 1.2, "line-dasharray": [3, 2], "line-opacity": 0.7 } },
      before,
    );
    m.addSource("rain", { type: "geojson", data: empty });
    m.addLayer(
      {
        id: "rain",
        type: "circle",
        source: "rain",
        layout: { visibility: "none" },
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, ["*", 0.06, ["get", "mm"]], 10, ["*", 0.25, ["get", "mm"]]],
          "circle-color": "#2f5d8a",
          "circle-opacity": 0.18,
          "circle-blur": 0.6,
        },
      },
      before,
    );
    m.addSource("segs", { type: "geojson", data: empty, promoteId: "i" });
    m.addLayer({ id: "seg-casing", type: "line", source: "segs", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-opacity": 0.85, "line-width": ["interpolate", ["linear"], ["zoom"], 7, 2, 12, 6.5, 16, 12] } }, before);
    m.addLayer({ id: "seg-risk", type: "line", source: "segs", layout: { "line-cap": "round", "line-join": "round" } }, before);
    m.addSource("severe", { type: "geojson", data: empty });
    m.addLayer({ id: "seg-severe", type: "line", source: "severe", layout: { "line-cap": "round" }, paint: { "line-blur": 3 } }, before);
    m.addLayer({ id: "seg-hit", type: "line", source: "segs", paint: { "line-color": "#000", "line-opacity": 0, "line-width": 16 } });

    m.addSource("route-alt", { type: "geojson", data: empty });
    m.addLayer({ id: "route-alt", type: "line", source: "route-alt", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#41524a", "line-width": 4, "line-dasharray": [1, 1.5], "line-opacity": 0.8 } });
    m.addSource("route", { type: "geojson", data: empty });
    m.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#1d2b24", "line-width": 11 } });
    m.addLayer({ id: "route-line", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-width": 6.5 } });

    m.addSource("events", { type: "geojson", data: empty });
    m.addLayer({
      id: "events",
      type: "circle",
      source: "events",
      layout: { visibility: "none" },
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 3.5, 13, 7],
        "circle-color": "#ffffff",
        "circle-stroke-color": "#5b2338",
        "circle-stroke-width": 2,
      },
    });
    m.addSource("reports", { type: "geojson", data: empty });
    m.addLayer({
      id: "reports",
      type: "circle",
      source: "reports",
      paint: { "circle-radius": 7, "circle-color": "#2f5d8a", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 },
    });

    m.on("click", "seg-hit", (e) => {
      const f = e.features?.[0];
      if (f) this.cb.onSegment(Number(f.properties?.i), [e.lngLat.lng, e.lngLat.lat]);
    });
    m.on("click", "events", (e) => {
      const f = e.features?.[0];
      if (f) this.cb.onEvent(JSON.parse(String(f.properties?.ev)) as SlideEvent);
    });
    for (const id of ["seg-hit", "events"]) {
      m.on("mouseenter", id, () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", id, () => (m.getCanvas().style.cursor = ""));
    }
    this.ready = true;
    this.applyStyle();
    this.applyLevels();
    this.startPulse();
    this.cb.onReady();
  }

  isReady() {
    return this.ready;
  }

  setBoundary(f: GeoJSON.Feature) {
    (this.map.getSource("boundary") as GeoJSONSource | undefined)?.setData(f);
  }

  setSegments(fc: GeoJSON.FeatureCollection) {
    this.feats = fc.features;
    (this.map.getSource("segs") as GeoJSONSource | undefined)?.setData(fc);
    if (this.levels) this.cur = new Int8Array(this.levels.length).fill(-1);
    this.applyLevels();
  }

  /** One string per segment, one character per hour of the window. */
  setLevels(levels: string[]) {
    this.levels = levels;
    this.cur = new Int8Array(levels.length).fill(-1);
    this.applyLevels();
  }

  private applyLevels() {
    if (!this.ready || !this.levels || !this.cur) return;
    const h = this.hour;
    const severe: GeoJSON.Feature[] = [];
    for (let i = 0; i < this.levels.length; i++) {
      const c = this.levels[i].charCodeAt(h);
      const lv = Number.isNaN(c) ? 0 : c - 48;
      if (this.cur[i] !== lv) {
        this.map.setFeatureState({ source: "segs", id: i }, { lv });
        this.cur[i] = lv;
      }
      if (lv === 3 && this.feats[i]) severe.push(this.feats[i]);
    }
    this.hasSevere = !this.terrain && severe.length > 0;
    (this.map.getSource("severe") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: this.terrain ? [] : severe,
    });
  }

  setEvents(events: SlideEvent[]) {
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: events.map((ev) => ({
        type: "Feature",
        properties: { ev: JSON.stringify(ev) },
        geometry: { type: "Point", coordinates: [ev.lon, ev.lat] },
      })),
    };
    (this.map.getSource("events") as GeoJSONSource | undefined)?.setData(fc);
  }

  setReports(points: { lon: number; lat: number }[]) {
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: points.map((p) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [p.lon, p.lat] } })),
    };
    (this.map.getSource("reports") as GeoJSONSource | undefined)?.setData(fc);
  }

  setRain(grid: [number, number][], mm: number[]) {
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: grid.map((p, i) => ({ type: "Feature", properties: { mm: mm[i] ?? 0 }, geometry: { type: "Point", coordinates: p } })),
    };
    (this.map.getSource("rain") as GeoJSONSource | undefined)?.setData(fc);
  }

  setVisible(layer: "events" | "rain", on: boolean) {
    if (this.map.getLayer(layer)) this.map.setLayoutProperty(layer, "visibility", on ? "visible" : "none");
  }

  setHour(h: number) {
    this.hour = h;
    this.applyLevels();
  }

  setTerrainMode(on: boolean) {
    this.terrain = on;
    this.applyStyle();
    this.applyLevels();
  }

  setDark(on: boolean) {
    this.dark = on;
    if (this.map.getLayer("night")) this.map.setLayoutProperty("night", "visibility", on ? "visible" : "none");
    if (this.map.getLayer("hillshade")) this.map.setPaintProperty("hillshade", "raster-opacity", on ? 0.12 : 0.32);
    if (this.map.getLayer("seg-casing")) this.map.setPaintProperty("seg-casing", "line-color", on ? "#0f1915" : "#ffffff");
    this.applyStyle();
  }

  private colors() {
    return this.dark ? RISK_DARK : RISK_LIGHT;
  }

  private applyStyle() {
    if (!this.ready) return;
    const m = this.map;
    const lv = levelExpr(this.terrain);
    const [c0, c1, c2, c3] = this.colors();
    m.setPaintProperty("seg-risk", "line-color", ["match", lv, 3, c3, 2, c2, 1, c1, c0]);
    m.setPaintProperty("seg-risk", "line-width", [
      "interpolate", ["linear"], ["zoom"],
      7, ["match", lv, 3, 2.8, 2, 2.2, 1, 1.5, 0.8],
      12, ["match", lv, 3, 7, 2, 5.5, 1, 3.5, 1.8],
      16, ["match", lv, 3, 12, 2, 10, 1, 7, 4],
    ]);
    m.setPaintProperty("seg-severe", "line-color", c3);
    m.setPaintProperty("seg-severe", "line-width", ["interpolate", ["linear"], ["zoom"], 7, 7, 12, 16, 16, 24]);
    const [, , r2, r3] = this.colors();
    m.setPaintProperty("route-line", "line-color", ["match", ["get", "lv"], 3, r3, 2, r2, 1, c1, c0]);
  }

  /**
   * Severe stretches pulse gently. Throttled to ~7 frames a second, paused when
   * the tab is hidden, when nothing is Severe, and while Car Mode is moving
   * (each pulse repaints the whole map, which costs battery).
   */
  private startPulse() {
    window.clearInterval(this.pulseTimer);
    if (this.reduceMotion) {
      this.map.setPaintProperty("seg-severe", "line-opacity", 0.35);
      return;
    }
    let k = 0;
    this.pulseTimer = window.setInterval(() => {
      if (document.hidden || !this.hasSevere || !this.map.getLayer("seg-severe")) return;
      if (this.carMoving) {
        this.map.setPaintProperty("seg-severe", "line-opacity", 0.35);
        return;
      }
      k += 1;
      this.map.setPaintProperty("seg-severe", "line-opacity", 0.18 + 0.32 * (0.5 + 0.5 * Math.sin(k / 2.2)));
    }, 140);
  }

  /** Draw a route; the line grows along its length unless motion is reduced. */
  setRoute(steps: { coords: [number, number][]; lv: number }[] | null, alt: [number, number][] | null) {
    const routeSrc = this.map.getSource("route") as GeoJSONSource | undefined;
    const altSrc = this.map.getSource("route-alt") as GeoJSONSource | undefined;
    if (!routeSrc || !altSrc) return;
    altSrc.setData(
      alt
        ? { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: alt } }
        : { type: "FeatureCollection", features: [] },
    );
    if (!steps) {
      routeSrc.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    const all: GeoJSON.Feature[] = steps.map((s) => ({
      type: "Feature",
      properties: { lv: s.lv },
      geometry: { type: "LineString", coordinates: s.coords },
    }));
    if (this.reduceMotion) {
      routeSrc.setData({ type: "FeatureCollection", features: all });
      return;
    }
    const frames = 12;
    let k = 0;
    const step = () => {
      k++;
      const upto = Math.ceil((all.length * k) / frames);
      routeSrc.setData({ type: "FeatureCollection", features: all.slice(0, upto) });
      if (k < frames) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  fit(coords: [number, number][], padding = 60) {
    if (!coords.length) return;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [x, y] of coords) {
      w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
    }
    this.map.fitBounds([[w, s], [e, n]], { padding, duration: this.reduceMotion ? 0 : 700, maxZoom: 14 });
  }

  setCar(pos: [number, number] | null, follow: boolean) {
    this.carMoving = !!pos && follow;
    if (!pos) {
      this.marker?.remove();
      this.marker = null;
      return;
    }
    if (!this.marker) {
      const el = document.createElement("div");
      el.className = "car-dot";
      el.setAttribute("aria-hidden", "true");
      this.marker = new maplibregl.Marker({ element: el }).setLngLat(pos).addTo(this.map);
    } else {
      this.marker.setLngLat(pos);
    }
    if (follow) {
      // Frequent small jumps read as a smooth glide and never queue up animations.
      this.map.jumpTo({ center: pos, zoom: Math.max(this.map.getZoom(), 12.5) });
    }
  }

  popup(lngLat: [number, number], html: string) {
    new maplibregl.Popup({ maxWidth: "300px", focusAfterOpen: false }).setLngLat(lngLat).setHTML(html).addTo(this.map);
  }

  resize() {
    this.map.resize();
  }

  destroy() {
    window.clearInterval(this.pulseTimer);
    this.map.remove();
  }
}
