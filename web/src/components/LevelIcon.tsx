// Each risk level has its own shape, so meaning never rests on colour alone.

export function LevelIcon({ level, size = 16 }: { level: number; size?: number }) {
  const c = `var(--risk-${level})`;
  const common = { width: size, height: size, viewBox: "0 0 16 16", "aria-hidden": true, className: "level-icon" } as const;
  switch (level) {
    case 3:
      return (
        <svg {...common}>
          <polygon points="5,1 11,1 15,5 15,11 11,15 5,15 1,11 1,5" fill={c} />
          <rect x="7.1" y="3.8" width="1.8" height="5.4" rx="0.6" fill="#fff" />
          <circle cx="8" cy="11.6" r="1.1" fill="#fff" />
        </svg>
      );
    case 2:
      return (
        <svg {...common}>
          <polygon points="8,0.8 15.2,8 8,15.2 0.8,8" fill={c} />
        </svg>
      );
    case 1:
      return (
        <svg {...common}>
          <polygon points="8,1.5 15,14.5 1,14.5" fill={c} />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.6" fill="none" stroke={c} strokeWidth="2.6" />
        </svg>
      );
  }
}

export function LevelTag({ level, label }: { level: number; label: string }) {
  return (
    <span className={`level-tag lv${level}`}>
      <LevelIcon level={level} size={14} />
      {label}
    </span>
  );
}
