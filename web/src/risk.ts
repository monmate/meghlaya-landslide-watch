// Rainfall trigger and risk levels. Pure functions, unit-tested in risk.test.ts.
//
// Trigger step from the 24-hour rain total, using IMD's categories:
//   0 below heavy, 1 heavy (>= 64.5 mm), 2 very heavy (>= 115.6), 3 extremely heavy (>= 204.5).
// Wet-ground bump: if the 72 hours before that 24-hour window held >= wet_mm,
// the step goes up by one (max 3). Level = matrix[susceptibility class][step].

import type { RainData, TriggerCfg } from "./types";

export const HOUR_MS = 3_600_000;
const IST_OFFSET_MS = 5.5 * HOUR_MS;

/** "YYYY-MM-DDTHH:MM" in UTC -> epoch ms. */
export function parseUtc(t: string): number {
  return Date.parse(t.length === 16 ? `${t}:00Z` : t);
}

/** "YYYY-MM-DDTHH:MM" in IST -> epoch ms. */
export function parseIst(t: string): number {
  return Date.parse(`${t}:00Z`) - IST_OFFSET_MS;
}

export interface CellTrigger {
  step: Uint8Array; // per hour
  r24: Float32Array; // 24 h total ending at that hour (mm)
  a72: Float32Array; // the 72 h before that window (mm)
}

export function cellTrigger(precip: number[], cfg: TriggerCfg): CellTrigger {
  const n = precip.length;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + Math.max(0, precip[i] || 0);
  const sum = (from: number, to: number) => (to < from ? 0 : pre[to + 1] - pre[Math.max(0, from)]);
  const step = new Uint8Array(n);
  const r24 = new Float32Array(n);
  const a72 = new Float32Array(n);
  const c = cfg.categories_mm_24h;
  const win = cfg.antecedent.window_h;
  for (let i = 0; i < n; i++) {
    const r = sum(i - 23, i);
    const a = sum(i - 23 - win, i - 24);
    let s = r >= c.extremely_heavy ? 3 : r >= c.very_heavy ? 2 : r >= c.heavy ? 1 : 0;
    if (a >= cfg.antecedent.wet_mm) s = Math.min(3, s + 1);
    step[i] = s;
    r24[i] = r;
    a72[i] = a;
  }
  return { step, r24, a72 };
}

export interface RiskWindow {
  from: number; // first hour index shown
  to: number; // last hour index shown (inclusive)
  nowIndex: number | null; // index of the current hour, if inside the data
  stale: boolean; // live data that no longer covers "now"
}

/** Which hours the slider shows. Live: 24 h back to 48 h ahead of now. Replay: the event window. */
export function riskWindow(rain: RainData, nowMs: number): RiskWindow {
  const times = rain.times.map(parseUtc);
  const last = times.length - 1;
  if (rain.mode === "replay" && rain.event) {
    const a = parseIst(rain.event.show_from);
    const b = parseIst(rain.event.show_to);
    const from = Math.max(0, times.findIndex((t) => t >= a));
    let to = times.findIndex((t) => t > b) - 1;
    if (to < 0) to = last;
    return { from, to, nowIndex: null, stale: false };
  }
  const hour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const idx = times.indexOf(hour);
  if (idx === -1) {
    // Snapshot no longer covers now: show its last 72 hours and flag it.
    return { from: Math.max(0, last - 72), to: last, nowIndex: null, stale: true };
  }
  return { from: Math.max(0, idx - 24), to: Math.min(last, idx + 48), nowIndex: idx, stale: false };
}

/**
 * One string per segment, one character ('0'..'3') per hour in the window.
 * Built per cell and class, then shared, so it is fast for 40,000 segments.
 */
export function levelStrings(
  sclass: number[],
  cell: number[],
  triggers: CellTrigger[],
  win: RiskWindow,
  matrix: TriggerCfg["matrix"],
): string[] {
  const rows = [matrix.low, matrix.moderate, matrix.high];
  const cache: string[][] = triggers.map((t) => {
    const out: string[] = [];
    for (let c = 0; c < 3; c++) {
      let s = "";
      for (let h = win.from; h <= win.to; h++) s += String(rows[c][t.step[h]]);
      out.push(s);
    }
    return out;
  });
  return sclass.map((c, i) => cache[cell[i]]?.[c] ?? "0".repeat(win.to - win.from + 1));
}

/** Kilometres of road at each level for one hour of the window. */
export function kmByLevel(levels: string[], lengths: number[], h: number): number[] {
  const km = [0, 0, 0, 0];
  for (let i = 0; i < levels.length; i++) km[levels[i].charCodeAt(h) - 48] += lengths[i] / 1000;
  return km;
}

export function formatIst(ms: number, withDate = true): string {
  const d = new Date(ms + IST_OFFSET_MS);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  if (!withDate) return `${hh}:${mm}`;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${hh}:${mm}`;
}
