// The time control: an hourly rain chart you scrub through. Bars are rain per
// hour; the strip below shows the worst road risk in that hour.

import { useMemo, useRef } from "react";
import type { Lang } from "../i18n";
import { t } from "../i18n";
import { formatIst, parseUtc } from "../risk";

interface Props {
  times: string[];
  rainByHour: number[]; // mm per hour for the window, aligned with times[from..to]
  worstByHour: number[]; // 0..3
  from: number;
  to: number;
  nowIndex: number | null;
  hour: number; // absolute index
  playing: boolean;
  lang: Lang;
  label: string;
  onHour: (h: number) => void;
  onPlay: () => void;
}

export function RainRibbon(p: Props) {
  const n = p.to - p.from + 1;
  const W = 1000;
  const H = 64;
  const bw = W / n;
  const maxMm = Math.max(10, ...p.rainByHour);
  const svgRef = useRef<SVGSVGElement>(null);

  const ticks = useMemo(() => {
    const out: { x: number; label: string; day: boolean }[] = [];
    for (let i = 0; i < n; i++) {
      const ms = parseUtc(p.times[p.from + i]);
      const ist = new Date(ms + 5.5 * 3_600_000);
      const hh = ist.getUTCHours();
      if (hh === 0) out.push({ x: i * bw, label: formatIst(ms).split(" ").slice(0, 2).join(" "), day: true });
      else if (hh % 6 === 0) out.push({ x: i * bw, label: `${String(hh).padStart(2, "0")}:00`, day: false });
    }
    return out;
  }, [p.times, p.from, n, bw]);

  const pick = (clientX: number) => {
    const el = svgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const i = Math.min(n - 1, Math.max(0, Math.floor(((clientX - r.left) / r.width) * n)));
    p.onHour(p.from + i);
  };

  const cur = p.hour - p.from;
  const nowX = p.nowIndex !== null ? (p.nowIndex - p.from) * bw : null;
  const timeLabel = formatIst(parseUtc(p.times[p.hour]));

  return (
    <div className="ribbon" aria-label={p.label}>
      <div className="ribbon-head">
        <button type="button" className="play" onClick={p.onPlay} aria-pressed={p.playing}>
          {p.playing ? (
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="2" y="1" width="3.5" height="12" fill="currentColor" /><rect x="8.5" y="1" width="3.5" height="12" fill="currentColor" /></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><polygon points="2,1 13,7 2,13" fill="currentColor" /></svg>
          )}
          <span>{p.playing ? t(p.lang, "pause") : t(p.lang, "play")}</span>
        </button>
        <output className="ribbon-time" aria-live="off">{timeLabel}</output>
        <span className="ribbon-scale">{Math.round(maxMm)} mm/h</span>
      </div>
      <svg
        ref={svgRef}
        className="ribbon-svg"
        viewBox={`0 0 ${W} ${H + 30}`}
        preserveAspectRatio="none"
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture?.(e.pointerId);
          pick(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.buttons) pick(e.clientX);
        }}
        role="presentation"
      >
        <defs>
          <pattern id="fc-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="8" stroke="var(--rule)" strokeWidth="3" />
          </pattern>
        </defs>
        {nowX !== null && <rect x={nowX + bw} y={0} width={W - nowX - bw} height={H} fill="url(#fc-hatch)" opacity="0.55" />}
        {p.rainByHour.map((mm, i) => {
          const h = (mm / maxMm) * (H - 6);
          return <rect key={i} x={i * bw + bw * 0.12} y={H - h} width={bw * 0.76} height={h} fill="var(--rain)" opacity={i === cur ? 1 : 0.7} />;
        })}
        {p.worstByHour.map((lv, i) => (
          <rect key={`w${i}`} x={i * bw} y={H + 3} width={bw + 0.5} height={7} fill={`var(--risk-${lv})`} />
        ))}
        {ticks.map((tk, i) => (
          <g key={i}>
            <line x1={tk.x} x2={tk.x} y1={tk.day ? 0 : H - 6} y2={H + 12} stroke="var(--muted)" strokeWidth={tk.day ? 1.2 : 0.8} opacity={tk.day ? 0.7 : 0.45} vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        {nowX !== null && <line x1={nowX + bw / 2} x2={nowX + bw / 2} y1={0} y2={H + 12} stroke="var(--ink)" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
        <rect x={cur * bw} y={0} width={bw} height={H + 12} fill="none" stroke="var(--accent)" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="ribbon-ticks" aria-hidden="true">
        {ticks.filter((tk) => tk.day).map((tk, i) => (
          <span key={i} style={{ left: `${(tk.x / W) * 100}%` }}>{tk.label}</span>
        ))}
        {nowX !== null && (
          <span className="now-tick" style={{ left: `${((nowX + bw / 2) / W) * 100}%` }}>{t(p.lang, "now")}</span>
        )}
      </div>
      <input
        className="ribbon-range"
        type="range"
        min={p.from}
        max={p.to}
        step={1}
        value={p.hour}
        onChange={(e) => p.onHour(Number(e.target.value))}
        aria-label={p.label}
        aria-valuetext={timeLabel}
      />
    </div>
  );
}
