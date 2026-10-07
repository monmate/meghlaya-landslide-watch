// Shapes of the JSON files the pipeline publishes (see pipeline/publish.py).

export interface TriggerCfg {
  source: string;
  source_url: string;
  categories_mm_24h: { heavy: number; very_heavy: number; extremely_heavy: number };
  antecedent: { window_h: number; wet_mm: number };
  matrix: { low: number[]; moderate: number[]; high: number[] };
}

export interface ReplayCfg {
  id: string;
  title: string;
  show_from: string; // IST, "YYYY-MM-DDTHH:MM"
  show_to: string;
  note: string;
  source_url: string;
}

export interface Meta {
  data_version: string;
  built_at: string;
  sample: boolean;
  region: { name: string };
  bounds: [number, number, number, number];
  counts: Record<string, string | number>;
  weights_used: Record<string, number>;
  class_thresholds: Record<string, number>;
  susceptibility_config: {
    ramps: Record<string, [number, number]>;
    flat_slope_deg: number;
    classes: { moderate_quantile: number; high_quantile: number };
  };
  trigger: TriggerCfg;
  levels: string[];
  replay: ReplayCfg;
  rain: { past_days: number; forecast_days: number };
  hillshade: { file: string; bounds: [number, number, number, number] } | null;
  sources: Record<string, Record<string, string | number>>;
  warnings: string[];
  disclaimer: string;
}

export interface SegmentsRaw {
  sample: boolean;
  count: number;
  scale: number;
  origin: [number, number];
  classes: string[];
  names: string[];
  geom: number[][];
  edge: number[];
  hw: number[];
  name: number[];
  len: number[];
  susc: number[];
  sclass: number[];
  cell: number[];
  slope: number[];
  relief: number[];
  cross: number[];
  lc: number[];
  lcm: number[];
  slides: number[];
  elev: number[];
  reasons: string[];
}

export interface GraphRaw {
  scale: number;
  origin: [number, number];
  classes: string[];
  speed_kmh: Record<string, number>;
  nodes: { x: number[]; y: number[]; comp: number[] };
  edges: { u: number[]; v: number[]; len: number[]; hw: number[]; segs: number[][] };
}

export interface Place {
  name: string;
  lon: number;
  lat: number;
  kind: string;
  node: number;
  snap_m: number;
}

export interface SlideEvent {
  lon: number;
  lat: number;
  date: string | null;
  accuracy_m: number | null;
  accuracy_text: string;
  trigger: string;
  title: string;
  source: string;
  url: string;
}

export interface RainData {
  mode: "live" | "replay";
  times: string[]; // UTC "YYYY-MM-DDTHH:MM"
  precip: number[][]; // [grid point][hour]
  source: string;
  credit: string;
  fetched_at: string;
  sample: boolean;
  event?: ReplayCfg;
}

export interface Segments {
  raw: SegmentsRaw;
  coords: [number, number][][];
  n: number;
}

export type Level = 0 | 1 | 2 | 3;
