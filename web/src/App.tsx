import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { About } from "./components/About";
import { CarMode } from "./components/CarMode";
import { LevelIcon, LevelTag } from "./components/LevelIcon";
import { RainRibbon } from "./components/RainRibbon";
import { loadReports, ReportPanel, type LocalReport } from "./components/ReportPanel";
import { loadLiveRain, loadReplay, loadStatic, type RainOrigin, type StaticData } from "./data";
import { fmtDist, fmtDuration, t, type Lang } from "./i18n";
import { MapView } from "./mapview";
import { buildModel, riskyGroups, segmentFeatures, type RiskModel } from "./model";
import { formatIst, HOUR_MS, kmByLevel, parseUtc } from "./risk";
import {
  bestDeparture,
  buildGraph,
  departureOptions,
  findRoute,
  nearestNode,
  SAFE_PENALTY,
  type DepartureOption,
  type Route,
} from "./routing";
import type { RainData, SlideEvent } from "./types";

type Tab = "now" | "trip" | "report";

interface Trip {
  fromLabel: string;
  toLabel: string;
  departIndex: number;
  fastest: Route;
  safer: Route | null;
  options: DepartureOption[];
  best: DepartureOption | null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function getLang(): Lang {
  try {
    return localStorage.getItem("mlw.lang") === "hi" ? "hi" : "en";
  } catch {
    return "en";
  }
}

export default function App() {
  const [lang, setLang] = useState<Lang>(getLang);
  const [st, setSt] = useState<StaticData | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [dataset, setDataset] = useState<"live" | "replay">("live");
  const [rain, setRain] = useState<{ rain: RainData; origin: RainOrigin } | null>(null);
  const [hour, setHour] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [tab, setTab] = useState<Tab>("now");
  const [terrainMode, setTerrainMode] = useState(false);
  const [showSlides, setShowSlides] = useState(false);
  const [showRain, setShowRain] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [carOn, setCarOn] = useState(false);
  const [reports, setReports] = useState<LocalReport[]>(loadReports);
  const [sheetOpen, setSheetOpen] = useState(() => window.innerWidth > 760);
  const [mapReady, setMapReady] = useState(false);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [fromName, setFromName] = useState("");
  const [toName, setToName] = useState("");
  const [gpsFrom, setGpsFrom] = useState<[number, number] | null>(null);
  const [tripMsg, setTripMsg] = useState("");
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapView | null>(null);

  useEffect(() => {
    document.documentElement.lang = lang;
    try {
      localStorage.setItem("mlw.lang", lang);
    } catch {
      /* ignore */
    }
  }, [lang]);

  // 1. Static data, then rain.
  useEffect(() => {
    loadStatic()
      .then(async (data) => {
        setSt(data);
        const live = await loadLiveRain(data.meta, data.grid);
        setRain(live);
      })
      .catch((e: unknown) => setLoadErr(String(e)));
  }, []);

  const graph = useMemo(() => (st ? buildGraph(st.graph) : null), [st]);
  const model: RiskModel | null = useMemo(
    () => (st && rain ? buildModel(st.meta, st.segs, rain.rain, Date.now()) : null),
    [st, rain],
  );

  // 2. Map.
  useEffect(() => {
    if (!st || !mapEl.current || mapRef.current) return;
    mapRef.current = new MapView(mapEl.current, st.meta, {
      onReady: () => setMapReady(true),
      onSegment: (seg, ll) => showSegmentPopup(seg, ll),
      onEvent: (ev) => showEventPopup(ev),
    });
    return () => {
      mapRef.current?.destroy();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st]);

  // 3. Push data into the map: geometry once, levels whenever the rain changes.
  useEffect(() => {
    if (!mapReady || !st) return;
    const mv = mapRef.current!;
    mv.setSegments(segmentFeatures(st.segs));
    mv.setBoundary(st.boundary);
    mv.setEvents(st.events);
  }, [mapReady, st]);

  useEffect(() => {
    if (!mapReady || !model) return;
    const start = model.win.nowIndex ?? model.win.from;
    mapRef.current!.setHour(start - model.win.from);
    mapRef.current!.setLevels(model.levels);
    setHour(start);
  }, [mapReady, model]);

  useEffect(() => {
    if (!mapReady || !model) return;
    mapRef.current!.setHour(hour - model.win.from);
  }, [mapReady, model, hour]);

  useEffect(() => {
    if (mapReady) mapRef.current!.setTerrainMode(terrainMode);
  }, [mapReady, terrainMode]);

  useEffect(() => {
    if (mapReady) mapRef.current!.setVisible("events", showSlides);
  }, [mapReady, showSlides]);

  useEffect(() => {
    if (!mapReady || !model || !st) return;
    mapRef.current!.setVisible("rain", showRain);
    if (showRain) mapRef.current!.setRain(st.grid, model.triggers.map((tr) => tr.r24[hour] ?? 0));
  }, [mapReady, showRain, model, st, hour]);

  useEffect(() => {
    if (mapReady) mapRef.current!.setReports(reports);
  }, [mapReady, reports]);

  useEffect(() => {
    if (!mapReady) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => mapRef.current?.setDark(carOn || mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [mapReady, carOn]);

  // Play the slider through the window.
  useEffect(() => {
    if (!playing || !model) return;
    const id = window.setInterval(() => {
      setHour((h) => {
        if (h >= model.win.to) {
          setPlaying(false);
          return h;
        }
        return h + 1;
      });
    }, 550);
    return () => window.clearInterval(id);
  }, [playing, model]);

  // Switch between live and the June 2022 replay.
  const switchDataset = async (to: "live" | "replay") => {
    if (!st) return;
    setPlaying(false);
    setTrip(null);
    mapRef.current?.setRoute(null, null);
    try {
      if (to === "replay") setRain({ rain: await loadReplay(st.meta), origin: "replay" });
      else setRain(await loadLiveRain(st.meta, st.grid));
      setDataset(to);
    } catch (e) {
      setLoadErr(String(e));
    }
  };

  const segName = useCallback(
    (seg: number) => (st ? st.segs.raw.names[st.segs.raw.name[seg]] || "" : ""),
    [st],
  );

  function reasonLines(seg: number, h: number): string[] {
    if (!st || !model) return [];
    const r = st.segs.raw;
    const out: string[] = [];
    for (const ch of r.reasons[seg]) {
      if (ch === "s") out.push(t(lang, "reasonS", { v: (r.slope[seg] / 10).toFixed(0) }));
      if (ch === "r") out.push(t(lang, "reasonR", { v: r.relief[seg] }));
      if (ch === "c") out.push(t(lang, "reasonC"));
      if (ch === "l") out.push(t(lang, "reasonL"));
      if (ch === "p") out.push(t(lang, "reasonP", { v: r.slides[seg] }));
    }
    const tr = model.triggers[r.cell[seg]];
    if (tr) {
      const mm = Math.round(tr.r24[h]);
      const c = model.rain && st.meta.trigger.categories_mm_24h;
      const cat = mm >= c.extremely_heavy ? 3 : mm >= c.very_heavy ? 2 : mm >= c.heavy ? 1 : 0;
      out.unshift(`${t(lang, "reasonRain", { mm })} (${t(lang, `rainCat${cat}`)})`);
      if (tr.a72[h] >= st.meta.trigger.antecedent.wet_mm) out.splice(1, 0, t(lang, "reasonWet", { mm: Math.round(tr.a72[h]) }));
    }
    return out.slice(0, 4);
  }

  function showSegmentPopup(seg: number, ll: [number, number]) {
    // Read the latest state through refs set below.
    popupRef.current(seg, ll);
  }
  function showEventPopup(ev: SlideEvent) {
    eventPopupRef.current(ev);
  }
  const popupRef = useRef<(seg: number, ll: [number, number]) => void>(() => undefined);
  const eventPopupRef = useRef<(ev: SlideEvent) => void>(() => undefined);
  popupRef.current = (seg, ll) => {
    if (!st || !model || !mapRef.current) return;
    const lv = model.levelAt(seg, hour);
    const sc = st.segs.raw.sclass[seg];
    const name = segName(seg);
    const reasons = reasonLines(seg, hour);
    const when = formatIst(parseUtc(model.rain.times[hour]));
    const html = `
      <div class="pop">
        <div class="pop-level lv${lv}"><span class="dot"></span>${esc(t(lang, `level${lv}`))}</div>
        <div class="pop-road">${esc(name || t(lang, "appName"))}</div>
        <div class="pop-when">${esc(t(lang, "atTime", { t: when }))} · ${esc(t(lang, "terrainClass", { c: t(lang, `sclass${sc}`) }))}</div>
        <ul>${reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
        <div class="pop-foot">${esc(t(lang, "popupFoot"))}</div>
      </div>`;
    mapRef.current.popup(ll, html);
  };
  eventPopupRef.current = (ev) => {
    if (!mapRef.current) return;
    const html = `
      <div class="pop">
        <div class="pop-road">${esc(ev.title || "Reported landslide")}</div>
        <div class="pop-when">${esc(ev.date ?? "date unknown")} · location within ${esc(ev.accuracy_text || "unknown")}</div>
        <div class="pop-foot">Source: ${esc(ev.source || "NASA COOLR")}${ev.url ? ` · <a href="${esc(ev.url)}" target="_blank" rel="noopener">report</a>` : ""}</div>
      </div>`;
    mapRef.current.popup([ev.lon, ev.lat], html);
  };

  // Summary numbers for the selected hour.
  const rel = model ? hour - model.win.from : 0;
  const km = useMemo(
    () => (st && model ? kmByLevel(model.levels, st.segs.raw.len, Math.max(0, rel)) : [0, 0, 0, 0]),
    [st, model, rel],
  );
  const groups = useMemo(
    () => (st && model ? riskyGroups(st.segs, model.levels, Math.max(0, rel), "Unnamed road") : []),
    [st, model, rel],
  );
  const ribbon = useMemo(() => {
    if (!model) return null;
    const { from, to } = model.win;
    const rainByHour: number[] = [];
    const worstByHour: number[] = [];
    for (let h = from; h <= to; h++) {
      let mx = 0;
      for (const p of model.rain.precip) mx = Math.max(mx, p[h] ?? 0);
      rainByHour.push(mx);
      let w = 0;
      for (const L of model.levels) {
        const c = L.charCodeAt(h - from) - 48;
        if (c > w) w = c;
        if (w === 3) break;
      }
      worstByHour.push(w);
    }
    return { rainByHour, worstByHour };
  }, [model]);
  const maxR24 = useMemo(
    () => (model ? Math.max(0, ...model.triggers.map((tr) => tr.r24[hour] ?? 0)) : 0),
    [model, hour],
  );

  const zoomToSegs = (ids: number[]) => {
    if (!st) return;
    mapRef.current?.fit(ids.flatMap((i) => st.segs.coords[i]));
    setSheetOpen(window.innerWidth > 760);
  };

  // Trip planning.
  const planTrip = () => {
    if (!st || !graph || !model) return;
    setTripMsg("");
    const to = st.places.find((p) => p.name === toName);
    const fromPlace = st.places.find((p) => p.name === fromName);
    if (!to || (!fromPlace && !gpsFrom)) {
      setTripMsg(t(lang, "pickPlace"));
      return;
    }
    const toNode = to.node;
    const fromNode = gpsFrom ? nearestNode(graph, gpsFrom[0], gpsFrom[1], graph.comp[toNode]) : fromPlace!.node;
    const segLen = (s: number) => st.segs.raw.len[s];
    const departIndex = hour;
    const fastest = findRoute(graph, fromNode, toNode, departIndex, model.levelAt, segLen);
    if (!fastest) {
      setTrip(null);
      mapRef.current?.setRoute(null, null);
      setTripMsg(t(lang, "noRoute"));
      return;
    }
    const safer = findRoute(graph, fromNode, toNode, departIndex, model.levelAt, segLen, SAFE_PENALTY);
    const options = departureOptions(fastest, departIndex, model.lastIndex, model.levelAt);
    const best = bestDeparture(options);
    const differs = safer && safer.nodes.join(",") !== fastest.nodes.join(",");
    const next: Trip = {
      fromLabel: gpsFrom ? t(lang, "myLocation") : fromPlace!.name,
      toLabel: to.name,
      departIndex,
      fastest,
      safer: differs ? safer : null,
      options,
      best,
    };
    setTrip(next);
    const steps = fastest.steps.map((s) => ({ coords: st.segs.coords[s.seg], lv: s.level }));
    const altCoords = next.safer ? next.safer.steps.flatMap((s) => st.segs.coords[s.seg]) : null;
    mapRef.current?.setRoute(steps, altCoords);
    mapRef.current?.fit(fastest.steps.flatMap((s) => st.segs.coords[s.seg]), 80);
  };

  const useMyLocation = () => {
    navigator.geolocation?.getCurrentPosition(
      (p) => {
        setGpsFrom([p.coords.longitude, p.coords.latitude]);
        setFromName("");
      },
      () => setTripMsg("Location is off or blocked. Choose a starting place instead."),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  // ----- Render -----
  if (loadErr && !st) {
    return (
      <main className="fatal">
        <h1>{t(lang, "appName")}</h1>
        <p>{t(lang, "loadFailed")}</p>
        <pre>{loadErr}</pre>
      </main>
    );
  }

  const meta = st?.meta;
  const modeKey = !rain
    ? null
    : meta?.sample || rain.rain.sample
      ? "modeSample"
      : rain.origin === "replay"
        ? "modeReplay"
        : model?.win.stale
          ? "modeSnapshot"
          : "modeLive";
  const updatedAt = rain ? formatIst(Date.parse(rain.rain.fetched_at)) : "";
  const hourLabel = model ? formatIst(parseUtc(model.rain.times[hour])) : "";
  const highKm = km[2] + km[3];
  const placeOptions = st?.places ?? [];
  const departTime = (opt: DepartureOption) =>
    formatIst(parseUtc(model!.rain.times[trip!.departIndex]) + opt.offsetH * HOUR_MS, false);
  const departLabel = (opt: DepartureOption) =>
    opt.offsetH === 0 ? t(lang, "leaveNow") : t(lang, "leaveAt", { t: departTime(opt) });

  return (
    <div className={`app ${carOn ? "is-car" : ""}`}>
      <header className="topbar">
        <div className="brand">
          <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" className="brand-mark">
            <path d="M2 21 L9 11 L13 16 L18 7 L26 21 Z" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
            <path d="M4 25 C9 22, 15 26, 24 23" fill="none" stroke="var(--rain)" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
          <h1>
            {t(lang, "appName")} <span>{t(lang, "region")}</span>
          </h1>
        </div>
        <div className="status">
          {modeKey && <span className={`mode-badge ${modeKey}`}>{t(lang, modeKey)}</span>}
          {rain && modeKey !== "modeReplay" && (
            <span className="updated">{model?.win.stale ? t(lang, "staleSince", { t: updatedAt }) : t(lang, "updated", { t: updatedAt })}</span>
          )}
        </div>
        <div className="top-actions">
          <button type="button" className="ghost" onClick={() => setLang(lang === "en" ? "hi" : "en")} aria-label="Language">
            {lang === "en" ? "हिंदी" : "English"}
          </button>
          <button type="button" className="ghost" onClick={() => setAboutOpen(true)}>{t(lang, "about")}</button>
        </div>
      </header>

      {meta?.sample && <div className="banner sample">{t(lang, "sampleBanner")}</div>}
      {rain?.origin === "replay" && rain.rain.event && (
        <div className="banner replay">
          {t(lang, "replayBanner", { title: rain.rain.event.title })} {rain.rain.event.note}{" "}
          <a href={rain.rain.event.source_url} target="_blank" rel="noopener">Source</a>
        </div>
      )}

      <div className="body">
        <aside className={`panel ${sheetOpen ? "open" : "closed"}`} aria-label="Panel">
          <button type="button" className="sheet-handle" onClick={() => setSheetOpen((o) => !o)} aria-expanded={sheetOpen}>
            <span />
          </button>
          <nav className="tabs" role="tablist">
            {(["now", "trip", "report"] as Tab[]).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={tab === k}
                className={tab === k ? "tab on" : "tab"}
                onClick={() => {
                  setTab(k);
                  setSheetOpen(true);
                }}
              >
                {t(lang, k === "now" ? "tabNow" : k === "trip" ? "tabTrip" : "tabReport")}
              </button>
            ))}
          </nav>

          <div className="panel-scroll">
            {!model && <p className="loading">{t(lang, "loading")}</p>}

            {model && tab === "now" && (
              <div className="panel-section">
                <p className="when">{t(lang, "atTime", { t: hourLabel })}</p>
                <p className={`headline ${highKm > 0 ? "alert" : ""}`}>
                  {highKm > 0.05 ? t(lang, "kmAtRisk", { km: highKm.toFixed(highKm < 10 ? 1 : 0) }) : t(lang, "kmNone")}
                </p>
                <div className="kmbar" aria-hidden="true">
                  {km.map((v, i) => (
                    <span key={i} style={{ flexGrow: v, background: `var(--risk-${i})` }} />
                  ))}
                </div>
                <ul className="kmlegend">
                  {[3, 2, 1, 0].map((i) => (
                    <li key={i}>
                      <LevelTag level={i} label={t(lang, `level${i}`)} />
                      <span className="num">{fmtDist(lang, km[i] * 1000)}</span>
                    </li>
                  ))}
                </ul>
                <p className="muted">{t(lang, "rainMax", { mm: Math.round(maxR24) })}</p>

                <h2>{t(lang, "worstRoads")}</h2>
                {groups.length === 0 ? (
                  <p className="muted">{t(lang, "noWorst")}</p>
                ) : (
                  <ul className="groups">
                    {groups.map((g, i) => (
                      <li key={i}>
                        <button type="button" onClick={() => zoomToSegs(g.segs)}>
                          <LevelIcon level={g.level} />
                          <span className="g-name">{g.label}</span>
                          <span className="num">{fmtDist(lang, g.km * 1000)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="toggles">
                  <div className="seg-control" role="radiogroup" aria-label="Map colour">
                    <button type="button" role="radio" aria-checked={!terrainMode} className={!terrainMode ? "on" : ""} onClick={() => setTerrainMode(false)}>{t(lang, "showRisk")}</button>
                    <button type="button" role="radio" aria-checked={terrainMode} className={terrainMode ? "on" : ""} onClick={() => setTerrainMode(true)}>{t(lang, "showTerrain")}</button>
                  </div>
                  <label className="check"><input type="checkbox" id="lyr-slides" checked={showSlides} onChange={(e) => setShowSlides(e.target.checked)} /> {t(lang, "layerSlides")}</label>
                  <label className="check"><input type="checkbox" id="lyr-rain" checked={showRain} onChange={(e) => setShowRain(e.target.checked)} /> {t(lang, "layerRain")}</label>
                </div>
                <button type="button" className="secondary wide" onClick={() => switchDataset(dataset === "live" ? "replay" : "live")}>
                  {dataset === "live" ? t(lang, "switchReplay") : t(lang, "switchLive")}
                </button>
                <p className="disclaimer">{t(lang, "disclaimer")}</p>
              </div>
            )}

            {model && tab === "trip" && (
              <div className="panel-section">
                <label className="field">
                  <span>{t(lang, "from")}</span>
                  <select id="trip-from" value={gpsFrom ? "__gps" : fromName} onChange={(e) => { setGpsFrom(null); setFromName(e.target.value); }}>
                    <option value="">{t(lang, "pickPlace")}</option>
                    {gpsFrom && <option value="__gps">{t(lang, "myLocation")}</option>}
                    {placeOptions.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                  </select>
                </label>
                <button type="button" className="link" onClick={useMyLocation}>{t(lang, "myLocation")}</button>
                <label className="field">
                  <span>{t(lang, "to")}</span>
                  <select id="trip-to" value={toName} onChange={(e) => setToName(e.target.value)}>
                    <option value="">{t(lang, "pickPlace")}</option>
                    {placeOptions.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                  </select>
                </label>
                <p className="muted small">{t(lang, "atTime", { t: hourLabel })}</p>
                <button type="button" className="primary wide" onClick={planTrip}>{t(lang, "checkTrip")}</button>
                {tripMsg && <p className="status" role="status">{tripMsg}</p>}

                {trip && (
                  <div className="trip">
                    <div className="compare">
                      {[
                        { key: "fastest", r: trip.fastest },
                        ...(trip.safer ? [{ key: "safer", r: trip.safer }] : []),
                      ].map(({ key, r }) => (
                        <div key={key} className={`option ${key}`}>
                          <h3>{t(lang, key)}</h3>
                          <p className="num big">{fmtDist(lang, r.lengthM)}</p>
                          <p className="num">{fmtDuration(lang, r.timeS)}</p>
                          <LevelTag level={r.maxLevel} label={`${t(lang, "worstLevel")}: ${t(lang, `level${r.maxLevel}`)}`} />
                          <p className="muted small">{t(lang, "highKm", { km: (r.stretches.reduce((a, s) => a + s.lenM, 0) / 1000).toFixed(1) })}</p>
                        </div>
                      ))}
                    </div>
                    {!trip.safer && <p className="muted">{t(lang, "sameRoute")}</p>}

                    {trip.best && (
                      <div className="best">
                        <h3>{t(lang, "bestTime")}</h3>
                        <p>
                          {trip.best.offsetH === 0
                            ? t(lang, "bestNow")
                            : t(lang, "bestLater", { t: departTime(trip.best), level: t(lang, `level${trip.best.maxLevel}`) })}
                        </p>
                        <div className="depart-strip" aria-hidden="true">
                          {trip.options.map((o) => (
                            <span key={o.offsetH} className={o.offsetH === trip.best!.offsetH ? "pick" : ""} style={{ background: `var(--risk-${o.maxLevel})` }} title={departLabel(o)} />
                          ))}
                        </div>
                      </div>
                    )}

                    {trip.fastest.stretches.length > 0 && (
                      <>
                        <h3>{t(lang, "stretches")}</h3>
                        <ol className="stretch-list">
                          {trip.fastest.stretches.map((s, i) => (
                            <li key={i}>
                              <button type="button" onClick={() => zoomToSegs(s.segs)}>
                                <LevelIcon level={s.level} />
                                <span>
                                  {t(lang, "stretchItem", {
                                    level: t(lang, `level${s.level}`),
                                    len: fmtDist(lang, s.lenM),
                                    dist: fmtDist(lang, s.startM),
                                    eta: fmtDuration(lang, s.etaS),
                                  })}
                                  {segName(s.segs[0]) ? ` · ${segName(s.segs[0])}` : ""}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ol>
                      </>
                    )}
                    <button type="button" className="primary wide car-start" onClick={() => setCarOn(true)}>{t(lang, "startCar")}</button>
                  </div>
                )}
                <p className="disclaimer">{t(lang, "disclaimer")}</p>
              </div>
            )}

            {tab === "report" && (
              <ReportPanel
                lang={lang}
                reports={reports}
                onChange={setReports}
                mapCenter={() => {
                  const c = mapRef.current?.map.getCenter();
                  return c ? [c.lng, c.lat] : [91.88, 25.57];
                }}
              />
            )}
          </div>
        </aside>

        <main className="mapwrap">
          <div ref={mapEl} className="map" role="region" aria-label="Map of road landslide risk" />
          <div className="legend" aria-label="Legend">
            {[3, 2, 1, 0].map((i) => (
              <span key={i}><LevelIcon level={i} size={13} />{t(lang, `level${i}`)}</span>
            ))}
          </div>
          {model && ribbon && st && (
            <RainRibbon
              times={model.rain.times}
              rainByHour={ribbon.rainByHour}
              worstByHour={ribbon.worstByHour}
              from={model.win.from}
              to={model.win.to}
              nowIndex={model.win.nowIndex}
              hour={hour}
              playing={playing}
              lang={lang}
              label={t(lang, "atTime", { t: hourLabel })}
              onHour={(h) => { setPlaying(false); setHour(h); }}
              onPlay={() => {
                if (!playing && hour >= model.win.to) setHour(model.win.from);
                setPlaying((p) => !p);
              }}
            />
          )}
        </main>
      </div>

      {carOn && trip && st && mapRef.current && (
        <CarMode lang={lang} route={trip.fastest} segCoords={st.segs.coords} segName={segName} map={mapRef.current} onExit={() => setCarOn(false)} />
      )}
      {aboutOpen && meta && <About meta={meta} lang={lang} onClose={() => setAboutOpen(false)} />}
    </div>
  );
}
