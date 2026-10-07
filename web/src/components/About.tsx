// "How this works": sources, the index, the rain rule, limits. Loaded from meta.json
// so it always matches the data the map is showing.

import { useEffect, useRef } from "react";
import type { Lang } from "../i18n";
import { t } from "../i18n";
import type { Meta } from "../types";
import { LevelTag } from "./LevelIcon";

const FACTOR_LABEL: Record<string, string> = {
  slope: "Slope (90th percentile within 100 m of the road)",
  relief: "Local relief (height range within about 330 m)",
  cross_slope: "Cross-slope (how steeply the hillside falls across the road)",
  landcover: "Land cover exposure (ESA WorldCover)",
  past_slides: "Reported slides nearby (NASA COOLR)",
};

export function About({ meta, lang, onClose }: { meta: Meta; lang: Lang; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const c = meta.trigger.categories_mm_24h;
  const m = meta.trigger.matrix;
  const lv = (i: number) => t(lang, `level${i}`);
  const counts = meta.counts;
  return (
    <dialog ref={ref} className="about" onClose={onClose} aria-labelledby="about-title">
      <div className="about-body">
        <div className="about-top">
          <h2 id="about-title">{t(lang, "about")}</h2>
          <button type="button" className="ghost" onClick={() => ref.current?.close()}>{t(lang, "close")}</button>
        </div>
        <p className="lead">
          Each road segment of about 200 m gets a terrain score. Rain then decides how much of that
          score turns into risk at each hour. This is a transparent risk estimate, not a landslide
          prediction, and not an official warning.
        </p>
        {meta.sample && <p className="warn">This build uses SAMPLE DATA: the roads, terrain and rain are synthetic.</p>}

        <h3>1. Terrain score (built once)</h3>
        <table>
          <thead><tr><th>Factor</th><th>Weight</th><th>Scores 0 at</th><th>Scores 1 at</th></tr></thead>
          <tbody>
            {Object.entries(meta.weights_used).map(([k, w]) => {
              const ramp = meta.susceptibility_config.ramps[
                k === "slope" ? "slope_p90_deg" : k === "relief" ? "relief_m" : k === "cross_slope" ? "cross_slope_deg" : "past_slides_count"
              ];
              return (
                <tr key={k}>
                  <td>{FACTOR_LABEL[k] ?? k}</td>
                  <td className="num">{Math.round(w * 100)}%</td>
                  <td className="num">{k === "landcover" ? "forest" : ramp?.[0]}</td>
                  <td className="num">{k === "landcover" ? "bare ground" : ramp?.[1]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p>
          Terrain classes are relative: the top 15% of hillside segments are High and the next 35%
          Moderate. Segments flatter than {meta.susceptibility_config.flat_slope_deg}° stay Low. No
          weight was fitted to landslide data yet; they are documented starting values.
        </p>

        <h3>2. Rain trigger (every hour)</h3>
        <p>
          Rain over the last 24 hours, in IMD's categories: heavy from {c.heavy} mm, very heavy from{" "}
          {c.very_heavy} mm, extremely heavy from {c.extremely_heavy} mm. If the 72 hours before
          that brought {meta.trigger.antecedent.wet_mm} mm or more, the ground counts as wet and the
          trigger moves up one step (a provisional rule). <a href={meta.trigger.source_url} target="_blank" rel="noopener">IMD bulletin with the categories</a>.
        </p>
        <table className="matrix">
          <thead>
            <tr><th>Terrain \ 24 h rain</th><th>Below heavy</th><th>Heavy</th><th>Very heavy</th><th>Extremely heavy</th></tr>
          </thead>
          <tbody>
            {([["Low", m.low], ["Moderate", m.moderate], ["High", m.high]] as const).map(([name, row]) => (
              <tr key={name}>
                <th>{name}</th>
                {row.map((v, i) => <td key={i}><LevelTag level={v} label={lv(v)} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>

        <h3>3. What the data says about this build</h3>
        <ul>
          <li>Built {new Date(meta.built_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST, data version {meta.data_version}.</li>
          <li>{String(counts.segments ?? "?")} road segments, {String(counts.road_km ?? "?")} km of road.</li>
          <li>
            Reported slides in the state from NASA COOLR: {String(counts.reported_slides_in_state ?? "?")}, of which{" "}
            {String(counts.reported_slides_dated_within_10km ?? "?")} are dated and located within 10 km. That is too
            few to train or validate a rain threshold, which is why the rules above are documented
            defaults rather than fitted values.
          </li>
          {meta.warnings.map((w, i) => <li key={i} className="warn">{w.split("\n")[0]}</li>)}
        </ul>

        <h3>4. Known limits</h3>
        <ul>
          <li>Rain comes from weather models on a grid of about 25 km, not rain gauges, and can miss intense local downpours.</li>
          <li>The elevation model includes tree tops and buildings, so slope under forest carries error.</li>
          <li>Mining, quarrying, road widening and drainage problems cause failures this map cannot see.</li>
          <li>Roads outside Meghalaya and one-way rules are not included.</li>
          <li>The Hindi text is a draft that needs review by native speakers. Khasi, Garo and Pnar are not yet available.</li>
        </ul>

        <h3>5. Sources</h3>
        <ul className="sources">
          {Object.entries(meta.sources).map(([k, v]) => (
            <li key={k}><strong>{k}</strong>: {Object.entries(v).filter(([kk]) => kk !== "retrieved_at").map(([kk, vv]) => `${kk} ${vv}`).join("; ")}</li>
          ))}
          <li><strong>Basemap</strong>: OpenFreeMap, OpenMapTiles, OpenStreetMap contributors.</li>
          <li><strong>Rain</strong>: Open-Meteo.com (CC BY 4.0), free non-commercial API.</li>
        </ul>
        <p className="disclaimer">{meta.disclaimer}</p>
      </div>
    </dialog>
  );
}
