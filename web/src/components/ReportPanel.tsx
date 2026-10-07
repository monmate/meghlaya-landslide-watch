// Report a slide. Demo only: reports stay in this browser. Photos are redrawn
// through a canvas, which drops EXIF data (including any GPS tags).

import { useState } from "react";
import type { Lang } from "../i18n";
import { t } from "../i18n";

export interface LocalReport {
  id: string;
  type: string;
  note: string;
  lon: number;
  lat: number;
  at: string;
  photo: string | null; // small JPEG data URL
}

const KEY = "mlw.reports.v1";

export function loadReports(): LocalReport[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]") as LocalReport[];
  } catch {
    return [];
  }
}

function saveReports(list: LocalReport[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-30)));
  } catch {
    /* storage full or blocked: the report still shows this session */
  }
}

async function shrinkPhoto(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const scale = Math.min(1, 640 / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.7);
  } finally {
    URL.revokeObjectURL(url);
  }
}

interface Props {
  lang: Lang;
  reports: LocalReport[];
  mapCenter: () => [number, number];
  onChange: (list: LocalReport[]) => void;
}

export function ReportPanel({ lang, reports, mapCenter, onChange }: Props) {
  const [type, setType] = useState("typeSlide");
  const [note, setNote] = useState("");
  const [where, setWhere] = useState<[number, number] | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  const useGps = () => {
    navigator.geolocation?.getCurrentPosition(
      (p) => setWhere([p.coords.longitude, p.coords.latitude]),
      () => setMsg("Location is off or blocked. Use the map centre instead."),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!where) {
      setMsg(t(lang, "pickLocationFirst"));
      return;
    }
    const r: LocalReport = {
      id: Math.random().toString(36).slice(2),
      type,
      note: note.slice(0, 280),
      lon: where[0],
      lat: where[1],
      at: new Date().toISOString(),
      photo,
    };
    const next = [...reports, r];
    saveReports(next);
    onChange(next);
    setNote("");
    setPhoto(null);
    setMsg(t(lang, "reportSaved"));
  };

  return (
    <div className="panel-section">
      <p className="note">{t(lang, "reportDemo")}</p>
      <form onSubmit={submit} className="report-form">
        <fieldset>
          <legend>{t(lang, "reportType")}</legend>
          {["typeSlide", "typeDebris", "typeBlocked", "typeFlood"].map((k) => (
            <label key={k} className="choice">
              <input type="radio" name="rtype" id={`rt-${k}`} checked={type === k} onChange={() => setType(k)} />
              {t(lang, k)}
            </label>
          ))}
        </fieldset>
        <label className="field">
          <span>{t(lang, "reportWhere")}</span>
          <span className="row">
            <button type="button" className="secondary" onClick={useGps}>{t(lang, "reportUseGps")}</button>
            <button type="button" className="secondary" onClick={() => setWhere(mapCenter())}>{t(lang, "reportUseMap")}</button>
          </span>
          {where && <span className="coords">{where[1].toFixed(4)}, {where[0].toFixed(4)}</span>}
        </label>
        <label className="field">
          <span>{t(lang, "reportNote")}</span>
          <textarea id="report-note" rows={2} maxLength={280} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <label className="field">
          <span>{t(lang, "reportPhoto")}</span>
          <input
            id="report-photo"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (f.size > 12 * 1024 * 1024) {
                setMsg("That photo is over 12 MB. Choose a smaller one.");
                return;
              }
              setPhoto(await shrinkPhoto(f));
            }}
          />
        </label>
        <button type="submit" className="primary">{t(lang, "reportSend")}</button>
        <p className="status" role="status">{msg}</p>
      </form>
      <h3>{t(lang, "reportMine")}</h3>
      {reports.length === 0 ? (
        <p className="muted">{t(lang, "reportNone")}</p>
      ) : (
        <ul className="report-list">
          {[...reports].reverse().map((r) => (
            <li key={r.id}>
              {r.photo && <img src={r.photo} alt="" width={56} height={56} />}
              <div>
                <strong>{t(lang, r.type)}</strong>
                <span className="muted"> {new Date(r.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}</span>
                <div className="muted small">{t(lang, "unverified")}</div>
                {r.note && <div>{r.note}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
