import { describe, expect, it } from "vitest";
import { cellTrigger, kmByLevel, levelStrings, parseIst, parseUtc, riskWindow } from "./risk";
import { bestDeparture, buildGraph, departureOptions, findRoute, SAFE_PENALTY, stretchesOf } from "./routing";
import type { GraphRaw, RainData, TriggerCfg } from "./types";

const cfg: TriggerCfg = {
  source: "IMD",
  source_url: "",
  categories_mm_24h: { heavy: 64.5, very_heavy: 115.6, extremely_heavy: 204.5 },
  antecedent: { window_h: 72, wet_mm: 150 },
  matrix: { low: [0, 0, 1, 2], moderate: [0, 1, 2, 3], high: [0, 2, 3, 3] },
};

describe("trigger", () => {
  it("uses IMD 24-hour categories", () => {
    const hours = new Array(200).fill(0);
    // 3 mm/h for 24 h = 72 mm: heavy.
    for (let i = 100; i < 124; i++) hours[i] = 3;
    const t = cellTrigger(hours, cfg);
    expect(t.r24[123]).toBeCloseTo(72);
    expect(t.step[123]).toBe(1);
    expect(t.step[99]).toBe(0);
  });

  it("bumps one step on wet ground", () => {
    const hours = new Array(200).fill(0);
    for (let i = 20; i < 70; i++) hours[i] = 4; // 200 mm well before
    for (let i = 76; i < 100; i++) hours[i] = 1; // 24 mm now: below heavy
    const t = cellTrigger(hours, cfg);
    expect(t.a72[99]).toBeGreaterThanOrEqual(150);
    expect(t.step[99]).toBe(1);
  });

  it("thresholds are inclusive at the boundary", () => {
    const hours = new Array(48).fill(0);
    hours[30] = 204.5;
    expect(cellTrigger(hours, cfg).step[30]).toBe(3);
  });
});

describe("levels", () => {
  const rain: RainData = {
    mode: "live",
    times: Array.from({ length: 96 }, (_, i) => new Date(Date.UTC(2026, 9, 7, 0) + i * 3_600_000).toISOString().slice(0, 16)),
    precip: [new Array(96).fill(0), new Array(96).fill(10)],
    source: "test",
    credit: "",
    fetched_at: "",
    sample: true,
  };

  it("picks a window around now", () => {
    const now = parseUtc("2026-10-08T05:30");
    const w = riskWindow(rain, now);
    expect(w.nowIndex).toBe(29);
    expect(w.from).toBe(5);
    expect(w.to).toBe(77);
    expect(w.stale).toBe(false);
  });

  it("flags stale snapshots", () => {
    expect(riskWindow(rain, parseUtc("2026-10-20T00:00")).stale).toBe(true);
  });

  it("maps class and trigger through the matrix", () => {
    const trig = rain.precip.map((p) => cellTrigger(p, cfg));
    const win = { from: 30, to: 31, nowIndex: 30, stale: false };
    // 10 mm/h -> 240 mm in 24 h -> step 3 (extremely heavy).
    const s = levelStrings([0, 1, 2, 2], [0, 1, 1, 0], trig, win, cfg.matrix);
    expect(s).toEqual(["00", "33", "33", "00"]);
    expect(kmByLevel(s, [1000, 2000, 500, 500], 0)).toEqual([1.5, 0, 0, 2.5]);
  });

  it("converts IST to UTC", () => {
    expect(parseIst("2022-06-17T05:30")).toBe(parseUtc("2022-06-17T00:00"));
  });
});

describe("routing", () => {
  // Square: 0-1-3 is short but risky; 0-2-3 is longer and safe.
  const raw: GraphRaw = {
    scale: 100000,
    origin: [91, 25],
    classes: ["primary"],
    speed_kmh: { primary: 36 },
    nodes: { x: [0, 1000, 0, 1000], y: [0, 0, 1000, 1000], comp: [0, 0, 0, 0] },
    edges: {
      u: [0, 1, 0, 2],
      v: [1, 3, 2, 3],
      len: [1000, 1000, 1500, 1500],
      hw: [0, 0, 0, 0],
      segs: [[0], [1], [2], [3]],
    },
  };
  const g = buildGraph(raw);
  const segLen = (s: number) => raw.edges.len[s];
  const levelAt = (s: number) => (s === 1 ? 3 : 0);

  it("fastest takes the short road", () => {
    const r = findRoute(g, 0, 3, 0, levelAt, segLen)!;
    expect(r.nodes).toEqual([0, 1, 3]);
    expect(r.maxLevel).toBe(3);
    expect(r.timeS).toBeCloseTo(200);
    expect(r.stretches).toHaveLength(1);
  });

  it("safer avoids the severe segment", () => {
    const r = findRoute(g, 0, 3, 0, levelAt, segLen, SAFE_PENALTY)!;
    expect(r.nodes).toEqual([0, 2, 3]);
    expect(r.maxLevel).toBe(0);
  });

  it("finds a calmer departure hour", () => {
    const r = findRoute(g, 0, 3, 0, levelAt, segLen)!;
    const timed = (s: number, h: number) => (s === 1 && h < 3 ? 3 : 0);
    const opts = departureOptions(r, 0, 30, timed);
    const best = bestDeparture(opts)!;
    expect(best.offsetH).toBe(3);
    expect(best.maxLevel).toBe(0);
  });

  it("merges nearby risky segments into one stretch", () => {
    const st = stretchesOf([
      { seg: 1, startM: 0, lenM: 200, etaS: 0, level: 2 },
      { seg: 2, startM: 200, lenM: 200, etaS: 20, level: 0 },
      { seg: 3, startM: 400, lenM: 200, etaS: 40, level: 3 },
      { seg: 4, startM: 2000, lenM: 200, etaS: 200, level: 2 },
    ]);
    expect(st).toHaveLength(2);
    expect(st[0].level).toBe(3);
    expect(st[0].lenM).toBe(600);
  });
});
