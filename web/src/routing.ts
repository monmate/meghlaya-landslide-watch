// Risk-aware routing on the road graph shipped with the site. Pure functions.
//
// Fastest: shortest travel time. Safer: travel time inflated by the risk level
// each road segment will have when the car reaches it (time-dependent).

import type { GraphRaw } from "./types";
import { HOUR_MS } from "./risk";

export interface Graph {
  n: number;
  lon: Float64Array;
  lat: Float64Array;
  comp: Int32Array;
  eu: Int32Array;
  ev: Int32Array;
  elen: Float64Array;
  etime: Float64Array; // seconds
  esegs: number[][];
  adj: number[][]; // edge ids touching each node
}

export function buildGraph(raw: GraphRaw): Graph {
  const n = raw.nodes.x.length;
  const lon = new Float64Array(n);
  const lat = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    lon[i] = raw.origin[0] + raw.nodes.x[i] / raw.scale;
    lat[i] = raw.origin[1] + raw.nodes.y[i] / raw.scale;
  }
  const m = raw.edges.u.length;
  const speeds = raw.classes.map((c) => (raw.speed_kmh[c] ?? 25) / 3.6);
  const etime = new Float64Array(m);
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let e = 0; e < m; e++) {
    etime[e] = raw.edges.len[e] / speeds[raw.edges.hw[e]];
    adj[raw.edges.u[e]].push(e);
    if (raw.edges.v[e] !== raw.edges.u[e]) adj[raw.edges.v[e]].push(e);
  }
  return {
    n,
    lon,
    lat,
    comp: Int32Array.from(raw.nodes.comp),
    eu: Int32Array.from(raw.edges.u),
    ev: Int32Array.from(raw.edges.v),
    elen: Float64Array.from(raw.edges.len),
    etime,
    esegs: raw.edges.segs,
    adj,
  };
}

/** Level of a segment at an absolute hour index (clamped by the caller's data). */
export type LevelAt = (seg: number, hourIndex: number) => number;

export interface RouteStep {
  seg: number;
  startM: number; // distance from the start (m)
  lenM: number;
  etaS: number; // seconds after departure when the car enters it
  level: number;
}

export interface Stretch {
  startM: number;
  lenM: number;
  etaS: number;
  level: number; // worst level in the stretch (2 or 3)
  segs: number[];
}

export interface Route {
  nodes: number[];
  steps: RouteStep[];
  lengthM: number;
  timeS: number;
  maxLevel: number;
  stretches: Stretch[];
}

// Extra cost per level for the safer route: travel time x (1 + penalty).
export const SAFE_PENALTY = [0, 0.25, 3, 20];

class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    const k = this.k;
    const v = this.v;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const k = this.k;
    const v = this.v;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!;
    const lv = v.pop()!;
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < k.length && k[l] < k[s]) s = l;
        if (r < k.length && k[r] < k[s]) s = r;
        if (s === i) break;
        [k[s], k[i]] = [k[i], k[s]];
        [v[s], v[i]] = [v[i], v[s]];
        i = s;
      }
    }
    return top;
  }
}

function orientedSegs(g: Graph, e: number, from: number): number[] {
  return g.eu[e] === from ? g.esegs[e] : [...g.esegs[e]].reverse();
}

/**
 * Time-dependent Dijkstra. With penalty = all zeros it is the fastest route.
 * departIndex is the hour index (in the rain data) at departure.
 */
export function findRoute(
  g: Graph,
  from: number,
  to: number,
  departIndex: number,
  levelAt: LevelAt,
  segLen: (seg: number) => number,
  penalty: number[] = [0, 0, 0, 0],
): Route | null {
  if (from === to) return null;
  const cost = new Float64Array(g.n).fill(Infinity);
  const time = new Float64Array(g.n).fill(Infinity);
  const prevEdge = new Int32Array(g.n).fill(-1);
  const done = new Uint8Array(g.n);
  cost[from] = 0;
  time[from] = 0;
  const heap = new Heap();
  heap.push(0, from);
  while (heap.size) {
    const [c, u] = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === to) break;
    if (c > cost[u]) continue;
    for (const e of g.adj[u]) {
      const w = g.eu[e] === u ? g.ev[e] : g.eu[e];
      if (done[w]) continue;
      let worst = 0;
      if (penalty.some((p) => p > 0)) {
        const hour = departIndex + Math.floor(time[u] / 3600);
        for (const s of g.esegs[e]) worst = Math.max(worst, levelAt(s, hour));
      }
      const t = g.etime[e];
      const nc = c + t * (1 + penalty[worst]);
      if (nc < cost[w]) {
        cost[w] = nc;
        time[w] = time[u] + t;
        prevEdge[w] = e;
        heap.push(nc, w);
      }
    }
  }
  if (!Number.isFinite(cost[to])) return null;
  // Walk back.
  const edgesRev: number[] = [];
  const nodes: number[] = [to];
  let cur = to;
  while (cur !== from) {
    const e = prevEdge[cur];
    edgesRev.push(e);
    cur = g.eu[e] === cur ? g.ev[e] : g.eu[e];
    nodes.push(cur);
  }
  nodes.reverse();
  const edges = edgesRev.reverse();
  return describeRoute(g, nodes, edges, departIndex, levelAt, segLen);
}

export function describeRoute(
  g: Graph,
  nodes: number[],
  edges: number[],
  departIndex: number,
  levelAt: LevelAt,
  segLen: (seg: number) => number,
): Route {
  const steps: RouteStep[] = [];
  let dist = 0;
  let t = 0;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const segs = orientedSegs(g, e, nodes[i]);
    const speed = g.elen[e] / g.etime[e];
    for (const s of segs) {
      const len = segLen(s);
      const level = levelAt(s, departIndex + Math.floor(t / 3600));
      steps.push({ seg: s, startM: dist, lenM: len, etaS: t, level });
      dist += len;
      t += len / speed;
    }
  }
  return {
    nodes,
    steps,
    lengthM: dist,
    timeS: t,
    maxLevel: steps.reduce((m, s) => Math.max(m, s.level), 0),
    stretches: stretchesOf(steps),
  };
}

/** Consecutive High or Severe segments, merged when gaps are under 300 m. */
export function stretchesOf(steps: RouteStep[], minLevel = 2, mergeGapM = 300): Stretch[] {
  const out: Stretch[] = [];
  for (const s of steps) {
    if (s.level < minLevel) continue;
    const last = out[out.length - 1];
    if (last && s.startM - (last.startM + last.lenM) <= mergeGapM) {
      last.lenM = s.startM + s.lenM - last.startM;
      last.level = Math.max(last.level, s.level);
      last.segs.push(s.seg);
    } else {
      out.push({ startM: s.startM, lenM: s.lenM, etaS: s.etaS, level: s.level, segs: [s.seg] });
    }
  }
  return out;
}

export interface DepartureOption {
  offsetH: number;
  maxLevel: number;
  highKm: number;
}

/** Re-score a fixed path for each possible departure hour. */
export function departureOptions(
  route: Route,
  departIndex: number,
  lastIndex: number,
  levelAt: LevelAt,
): DepartureOption[] {
  const out: DepartureOption[] = [];
  const spanH = Math.ceil(route.timeS / 3600);
  for (let d = 0; departIndex + d + spanH <= lastIndex && d <= 24; d++) {
    let maxLevel = 0;
    let highM = 0;
    for (const s of route.steps) {
      const lv = levelAt(s.seg, departIndex + d + Math.floor(s.etaS / 3600));
      maxLevel = Math.max(maxLevel, lv);
      if (lv >= 2) highM += s.lenM;
    }
    out.push({ offsetH: d, maxLevel, highKm: highM / 1000 });
  }
  return out;
}

/** Earliest departure with the lowest worst level, then the least high-risk distance. */
export function bestDeparture(opts: DepartureOption[]): DepartureOption | null {
  let best: DepartureOption | null = null;
  for (const o of opts) {
    if (
      !best ||
      o.maxLevel < best.maxLevel ||
      (o.maxLevel === best.maxLevel && o.highKm < best.highKm - 0.05)
    ) {
      best = o;
    }
  }
  return best;
}

export function nearestNode(g: Graph, lon: number, lat: number, comp?: number): number {
  const k = Math.cos((lat * Math.PI) / 180);
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < g.n; i++) {
    if (comp !== undefined && g.comp[i] !== comp) continue;
    const dx = (g.lon[i] - lon) * k;
    const dy = g.lat[i] - lat;
    const d = dx * dx + dy * dy;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

export const HOUR = HOUR_MS;
