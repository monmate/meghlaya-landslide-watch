// Car Mode: one big "risk ahead" card, spoken alerts, screen kept awake.
// Voice starts only after a tap (browsers require it, and it should be a choice).

import { useEffect, useMemo, useRef, useState } from "react";
import type { Lang } from "../i18n";
import { fmtDist, fmtDuration, speechLang, t } from "../i18n";
import type { MapView } from "../mapview";
import type { Route, Stretch } from "../routing";
import { LevelIcon } from "./LevelIcon";

interface Props {
  lang: Lang;
  route: Route;
  segCoords: [number, number][][];
  segName: (seg: number) => string;
  map: MapView;
  onExit: () => void;
}

interface Line {
  pts: [number, number][];
  cum: number[]; // metres along the route at each point
  total: number;
}

const R = 6371000;
function distM(a: [number, number], b: [number, number]) {
  const k = Math.PI / 180;
  const x = (b[0] - a[0]) * k * Math.cos(((a[1] + b[1]) / 2) * k);
  const y = (b[1] - a[1]) * k;
  return Math.hypot(x, y) * R;
}

/** Ordered polyline for the route, reversing segments drawn the other way. */
function routeLine(route: Route, segCoords: [number, number][][]): Line {
  const pts: [number, number][] = [];
  route.steps.forEach((s, i) => {
    let c = segCoords[s.seg];
    if (pts.length) {
      const last = pts[pts.length - 1];
      if (distM(last, c[c.length - 1]) < distM(last, c[0])) c = [...c].reverse();
    } else if (route.steps[1]) {
      const nxt = segCoords[route.steps[1].seg];
      const endNear = Math.min(distM(c[c.length - 1], nxt[0]), distM(c[c.length - 1], nxt[nxt.length - 1]));
      const startNear = Math.min(distM(c[0], nxt[0]), distM(c[0], nxt[nxt.length - 1]));
      if (startNear < endNear) c = [...c].reverse();
    }
    for (const p of i === 0 ? c : c.slice(1)) pts.push(p);
  });
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distM(pts[i - 1], pts[i]));
  return { pts, cum, total: cum[cum.length - 1] || 0 };
}

function pointAt(line: Line, s: number): [number, number] {
  if (s <= 0) return line.pts[0];
  if (s >= line.total) return line.pts[line.pts.length - 1];
  let lo = 0;
  let hi = line.cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (line.cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const f = (s - line.cum[lo]) / Math.max(1e-6, line.cum[hi] - line.cum[lo]);
  const a = line.pts[lo];
  const b = line.pts[hi];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

function project(line: Line, p: [number, number]): { s: number; off: number } {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < line.pts.length; i++) {
    const d = distM(p, line.pts[i]);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return { s: line.cum[best], off: bd };
}

export function CarMode({ lang, route, segCoords, segName, map, onExit }: Props) {
  const line = useMemo(() => routeLine(route, segCoords), [route, segCoords]);
  const [s, setS] = useState(0);
  const [source, setSource] = useState<"sim" | "gps" | null>(null);
  const [voice, setVoice] = useState(false);
  const [wake, setWake] = useState(false);
  const [offRoute, setOffRoute] = useState(false);
  const [battery, setBattery] = useState<number | null>(null);
  const [spoken, setSpoken] = useState("");
  const announced = useRef(new Map<number, number>()); // stretch start -> level announced
  const entered = useRef(new Set<number>());
  const lastSpeak = useRef(0);
  const wakeRef = useRef<WakeLockSentinel | null>(null);

  // Dark map, car marker, screen wake lock.
  useEffect(() => {
    map.setDark(true);
    const request = async () => {
      try {
        wakeRef.current = await navigator.wakeLock?.request("screen");
        setWake(!!wakeRef.current);
        wakeRef.current?.addEventListener("release", () => setWake(false));
      } catch {
        setWake(false);
      }
    };
    void request();
    const onVis = () => {
      if (document.visibilityState === "visible") void request();
    };
    document.addEventListener("visibilitychange", onVis);
    const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean }> };
    nav.getBattery?.().then((b) => {
      if (!b.charging && b.level < 0.25) setBattery(Math.round(b.level * 100));
    }).catch(() => undefined);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      void wakeRef.current?.release().catch(() => undefined);
      map.setDark(false);
      map.setCar(null, false);
      window.speechSynthesis?.cancel();
    };
  }, [map]);

  // Simulated drive: covers the route in about 90 seconds.
  useEffect(() => {
    if (source !== "sim") return;
    const speed = Math.max(150, line.total / 90);
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setS((v) => {
        const nv = Math.min(line.total, v + speed * dt);
        if (nv >= line.total) setSource(null);
        return nv;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [source, line]);

  // Real GPS.
  useEffect(() => {
    if (source !== "gps" || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (p) => {
        const pr = project(line, [p.coords.longitude, p.coords.latitude]);
        setOffRoute(pr.off > 300);
        setS(pr.s);
      },
      () => setSource(null),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [source, line]);

  // Move the marker, at most about 8 times a second.
  const lastMove = useRef(0);
  useEffect(() => {
    const now = performance.now();
    if (source && now - lastMove.current < 120) return;
    lastMove.current = now;
    map.setCar(pointAt(line, s), source !== null);
  }, [map, line, s, source]);

  const inside: Stretch | undefined = route.stretches.find((st) => s >= st.startM && s <= st.startM + st.lenM);
  const next: Stretch | undefined = route.stretches.find((st) => st.startM > s);
  const levelName = (lv: number) => t(lang, `level${lv}`).toLowerCase();

  // Spoken alerts with hysteresis: once per stretch, again only if its level rises; 30 s cooldown.
  useEffect(() => {
    if (!voice || !window.speechSynthesis) return;
    const say = (text: string, urgent = false) => {
      const now = Date.now();
      if (!urgent && now - lastSpeak.current < 30000) return false;
      lastSpeak.current = now;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = speechLang[lang];
      const v = window.speechSynthesis.getVoices().find((vv) => vv.lang.startsWith(speechLang[lang].slice(0, 2)));
      if (v) u.voice = v;
      window.speechSynthesis.speak(u);
      setSpoken(text);
      return true;
    };
    if (inside && !entered.current.has(inside.startM)) {
      if (say(t(lang, "voiceEnter", { level: levelName(inside.level), len: fmtDist(lang, inside.lenM) }), true)) entered.current.add(inside.startM);
    } else if (next) {
      const d = next.startM - s;
      const warnAt = next.level >= 3 ? 3000 : 1500;
      const prev = announced.current.get(next.startM);
      if (d <= warnAt && (prev === undefined || next.level > prev)) {
        if (say(t(lang, "voiceAhead", { level: levelName(next.level), dist: fmtDist(lang, d) }), prev !== undefined)) {
          announced.current.set(next.startM, next.level);
        }
      }
    }
  });

  const arrived = line.total > 0 && s >= line.total - 30;
  const target = inside ?? next;
  const etaS = next ? next.etaS - (route.timeS * s) / Math.max(1, route.lengthM) : 0;

  return (
    <div className="car" role="region" aria-label={t(lang, "carMode")}>
      <div className="car-top">
        <button type="button" className="car-exit" onClick={onExit}>{t(lang, "exitCar")}</button>
        <span className={`car-wake ${wake ? "on" : ""}`}>{wake ? t(lang, "wakeOn") : t(lang, "wakeOff")}</span>
      </div>
      <div className={`car-card ${target ? `lv${target.level}` : "clear"}`} aria-live="polite">
        {arrived ? (
          <p className="car-big-text">{t(lang, "arrived")}</p>
        ) : inside ? (
          <>
            <div className="car-level"><LevelIcon level={inside.level} size={40} />{t(lang, "inside", { level: levelName(inside.level) })}</div>
            <p className="car-sub">{t(lang, "aheadFor", { len: fmtDist(lang, inside.startM + inside.lenM - s) })} · {segName(inside.segs[0])}</p>
          </>
        ) : next ? (
          <>
            <div className="car-level"><LevelIcon level={next.level} size={40} />{t(lang, "aheadIn", { level: t(lang, `level${next.level}`) })}</div>
            <p className="car-dist">{fmtDist(lang, next.startM - s)}</p>
            <p className="car-sub">
              {t(lang, "aheadFor", { len: fmtDist(lang, next.lenM) })}
              {segName(next.segs[0]) ? ` · ${segName(next.segs[0])}` : ""}
              {etaS > 0 ? ` · ${fmtDuration(lang, etaS)}` : ""}
            </p>
          </>
        ) : (
          <p className="car-big-text">{t(lang, "aheadNone")}</p>
        )}
        {offRoute && <p className="car-warn">{t(lang, "offRoute")}</p>}
        {source === "sim" && <p className="car-flag">{t(lang, "simulated")}</p>}
      </div>
      <div className="car-actions">
        <button type="button" className={voice ? "car-btn on" : "car-btn"} aria-pressed={voice} onClick={() => setVoice((v) => !v)}>
          {voice ? t(lang, "voiceOn") : t(lang, "voiceOff")}
        </button>
        <button type="button" className="car-btn" aria-pressed={source === "sim"} onClick={() => { if (source !== "sim" && s >= line.total - 30) setS(0); setSource(source === "sim" ? null : "sim"); }}>
          {source === "sim" ? t(lang, "stopSim") : t(lang, "simulate")}
        </button>
        <button type="button" className="car-btn" aria-pressed={source === "gps"} onClick={() => setSource(source === "gps" ? null : "gps")}>
          {t(lang, "useGps")}
        </button>
      </div>
      {battery !== null && <p className="car-warn">{t(lang, "battery", { p: battery })}</p>}
      <p className="car-safety">{t(lang, "carSafety")}</p>
      <p className="sr-only" aria-live="assertive">{spoken}</p>
    </div>
  );
}
