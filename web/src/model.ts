// Derived state: triggers per rain cell, level strings per segment, and the
// level lookup routing and Car Mode share.

import { cellTrigger, levelStrings, riskWindow, type CellTrigger, type RiskWindow } from "./risk";
import type { Meta, RainData, Segments } from "./types";

export interface RiskModel {
  rain: RainData;
  win: RiskWindow;
  triggers: CellTrigger[];
  levels: string[]; // per segment, one char per hour in the window
  levelAt: (seg: number, hourIndex: number) => number;
  lastIndex: number;
}

export function buildModel(meta: Meta, segs: Segments, rain: RainData, nowMs: number): RiskModel {
  const triggers = rain.precip.map((p) => cellTrigger(p, meta.trigger));
  const win = riskWindow(rain, nowMs);
  const levels = levelStrings(segs.raw.sclass, segs.raw.cell, triggers, win, meta.trigger.matrix);
  const rows = [meta.trigger.matrix.low, meta.trigger.matrix.moderate, meta.trigger.matrix.high];
  const lastIndex = rain.times.length - 1;
  const levelAt = (seg: number, hourIndex: number) => {
    if (hourIndex >= win.from && hourIndex <= win.to) return levels[seg].charCodeAt(hourIndex - win.from) - 48;
    const h = Math.min(lastIndex, Math.max(0, hourIndex));
    const trig = triggers[segs.raw.cell[seg]];
    return trig ? rows[segs.raw.sclass[seg]][trig.step[h]] : 0;
  };
  return { rain, win, triggers, levels, levelAt, lastIndex };
}

export function segmentFeatures(segs: Segments): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = new Array(segs.n);
  for (let i = 0; i < segs.n; i++) {
    features[i] = {
      type: "Feature",
      id: i,
      properties: { i, sc: segs.raw.sclass[i] },
      geometry: { type: "LineString", coordinates: segs.coords[i] },
    };
  }
  return { type: "FeatureCollection", features };
}

export interface RoadGroup {
  label: string;
  level: number;
  km: number;
  segs: number[];
}

/** Riskiest stretches at one hour, grouped by road name. */
export function riskyGroups(segs: Segments, levels: string[], rel: number, unnamed: string, limit = 6): RoadGroup[] {
  const groups = new Map<string, RoadGroup>();
  for (let i = 0; i < segs.n; i++) {
    const lv = levels[i].charCodeAt(rel) - 48;
    if (lv < 2) continue;
    const label = segs.raw.names[segs.raw.name[i]] || unnamed;
    const key = `${label}|${lv}`;
    let g = groups.get(key);
    if (!g) {
      g = { label, level: lv, km: 0, segs: [] };
      groups.set(key, g);
    }
    g.km += segs.raw.len[i] / 1000;
    g.segs.push(i);
  }
  return [...groups.values()].sort((a, b) => b.level - a.level || b.km - a.km).slice(0, limit);
}
