export interface BarSeries {
  label: string;
  value: number;
  valueB?: number;
}

export function BarChart({
  data,
  colorA = "#7357FF",
  colorB = "#C7F36B",
  showLegend = false,
  legendA = "Series A",
  legendB = "Series B",
  height = 180,
}: {
  data: BarSeries[];
  colorA?: string;
  colorB?: string;
  showLegend?: boolean;
  legendA?: string;
  legendB?: string;
  height?: number;
}) {
  const max = Math.max(1, ...data.flatMap((d) => [d.value, d.valueB ?? 0]));
  const hasB = data.some((d) => d.valueB !== undefined);
  const width = 560;
  const padding = 24;
  const chartH = height - padding;
  const groupWidth = (width - padding) / data.length;

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-[180px] w-full" role="img" aria-label="Chart">
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line
            key={f}
            x1={0}
            x2={width}
            y1={chartH - chartH * f}
            y2={chartH - chartH * f}
            stroke="#E4E7EC"
            strokeWidth={1}
          />
        ))}
        {data.map((d, i) => {
          const barW = hasB ? (groupWidth - 16) / 2 : groupWidth - 20;
          const x = padding / 2 + i * groupWidth;
          const hA = (d.value / max) * (chartH - 8);
          return (
            <g key={d.label}>
              <rect
                x={x}
                y={chartH - hA}
                width={barW}
                height={hA}
                rx={3}
                fill={colorA}
              />
              {hasB && (
                <rect
                  x={x + barW + 6}
                  y={chartH - (((d.valueB ?? 0) / max) * (chartH - 8))}
                  width={barW}
                  height={(d.valueB ?? 0) / max * (chartH - 8)}
                  rx={3}
                  fill={colorB}
                />
              )}
              <text
                x={x + groupWidth / 2 - 8}
                y={height - 4}
                fontSize={11}
                fill="#98A2B3"
                textAnchor="middle"
              >
                {d.label}
              </text>
            </g>
          );
        })}
      </svg>
      {showLegend && (
        <div className="mt-2 flex items-center gap-4 text-[12px]" style={{ color: "#667085" }}>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full" style={{ background: colorA }} />
            {legendA}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full" style={{ background: colorB }} />
            {legendB}
          </span>
        </div>
      )}
    </div>
  );
}

export default BarChart;
