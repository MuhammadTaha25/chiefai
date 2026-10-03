const TONE_STYLES: Record<string, { bg: string; fg: string }> = {
  violet: { bg: "rgba(115,87,255,0.1)", fg: "#5b43d6" },
  green: { bg: "rgba(22,163,107,0.1)", fg: "#16A36B" },
  orange: { bg: "rgba(240,140,70,0.12)", fg: "#C96A2A" },
  gray: { bg: "#F1F3F7", fg: "#667085" },
  blue: { bg: "rgba(52,133,216,0.1)", fg: "#3485D8" },
};

export type StatusTone = keyof typeof TONE_STYLES;

export function StatusBadge({ label, tone }: { label: string; tone: StatusTone }) {
  const s = TONE_STYLES[tone] ?? TONE_STYLES.gray;
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold"
      style={{ background: s.bg, color: s.fg }}
    >
      {label}
    </span>
  );
}

export default StatusBadge;
