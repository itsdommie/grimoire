import { useId, useState, type ReactNode } from 'react';

// Chart conventions follow the dataviz guidance: thin marks (<= 24px), 4px rounded data-ends on a square baseline, 2px lines
// with >= 8px markers, recessive hairline grid, text in ink tokens (never the series colour), a legend for 2+ series, a hover
// layer on every chart and a table view for each.

export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'] as const;

const fmtPct = (v: number) => `${Math.round(v * 100)}%`;

/** Toggle between a chart and its data table. */
function ChartFrame({ title, subtitle, table, children, legend }: { title: string; subtitle?: string; table: ReactNode; children: ReactNode; legend?: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <figure className="viz">
      <figcaption>
        <span className="viz-title">{title}</span>
        {subtitle && <span className="viz-sub">{subtitle}</span>}
        <button className="linklike" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>{asTable ? 'Chart' : 'Table'}</button>
      </figcaption>
      {legend}
      {asTable ? table : children}
    </figure>
  );
}

// ------------------------------------------------------------------ columns

export interface Column { label: string; value: number; detail: string }

/** Single-series column chart (one colour, so no legend; the title says what's plotted). */
export function ColumnChart({ title, subtitle, data, format = (v) => String(v), unit }: {
  title: string; subtitle?: string; data: Column[]; format?: (v: number) => string; unit?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 340, H = 150, top = 20, base = 120, band = W / data.length, bw = Math.min(24, band * 0.6);
  const max = Math.max(...data.map((d) => d.value), 1e-9);
  const y = (v: number) => base - (v / max) * (base - top);
  return (
    <ChartFrame
      title={title} subtitle={subtitle}
      table={<table className="viz-table"><thead><tr><th>{unit ?? 'Bucket'}</th><th>Value</th></tr></thead><tbody>{data.map((d) => <tr key={d.label}><td>{d.label}</td><td>{format(d.value)}</td></tr>)}</tbody></table>}
    >
      <div className="viz-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${data.map((d) => `${d.label}: ${format(d.value)}`).join(', ')}`}>
          <line className="viz-axis" x1={0} x2={W} y1={base} y2={base} />
          {data.map((d, i) => {
            const cx = band * i + band / 2, h = Math.max(0, base - y(d.value)), x = cx - bw / 2;
            const r = Math.min(4, h);
            return (
              <g key={d.label} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0} role="listitem" aria-label={d.detail}>
                <rect x={band * i} y={0} width={band} height={H} fill="transparent" />
                {h > 0 && <path d={`M${x},${base} V${base - h + r} Q${x},${base - h} ${x + r},${base - h} H${x + bw - r} Q${x + bw},${base - h} ${x + bw},${base - h + r} V${base} Z`} fill="var(--series-1)" opacity={hover === null || hover === i ? 1 : 0.55} />}
                {d.value > 0 && <text className="viz-value" x={cx} y={base - h - 5} textAnchor="middle">{format(d.value)}</text>}
                <text className="viz-tick" x={cx} y={base + 15} textAnchor="middle">{d.label}</text>
              </g>
            );
          })}
        </svg>
        {hover !== null && <div className="viz-tip" style={{ left: `${((band * hover + band / 2) / W) * 100}%` }} role="tooltip">{data[hover]!.detail}</div>}
      </div>
    </ChartFrame>
  );
}

// -------------------------------------------------------------------- lines

export interface LineSeries { name: string; values: number[] }

/** Multi-series line chart over turns 1..n with values 0..1. Legend + crosshair tooltip + table view. */
export function LineChart({ title, subtitle, series, xLabel = 'Turn' }: { title: string; subtitle?: string; series: LineSeries[]; xLabel?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const n = series[0]?.values.length ?? 0;
  const W = 340, H = 170, left = 30, right = 12, top = 12, bottom = 28;
  const x = (i: number) => left + (n <= 1 ? 0 : (i / (n - 1)) * (W - left - right));
  const y = (v: number) => top + (1 - v) * (H - top - bottom);
  const legend = series.length > 1 ? (
    <ul className="viz-legend" aria-label="Legend">
      {series.map((s, i) => <li key={s.name}><svg width="16" height="8" aria-hidden><line x1="0" x2="16" y1="4" y2="4" stroke={SERIES[i % SERIES.length]} strokeWidth="2" strokeLinecap="round" /></svg>{s.name}</li>)}
    </ul>
  ) : undefined;
  return (
    <ChartFrame
      title={title} subtitle={subtitle} legend={legend}
      table={<table className="viz-table"><thead><tr><th>{xLabel}</th>{series.map((s) => <th key={s.name}>{s.name}</th>)}</tr></thead><tbody>{Array.from({ length: n }, (_, i) => <tr key={i}><td>{i + 1}</td>{series.map((s) => <td key={s.name}>{fmtPct(s.values[i]!)}</td>)}</tr>)}</tbody></table>}
    >
      <div className="viz-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-t`} onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const px = ((e.clientX - r.left) / r.width) * W;
            setHover(Math.max(0, Math.min(n - 1, Math.round(((px - left) / (W - left - right)) * (n - 1)))));
          }}>
          <title id={`${id}-t`}>{`${title}. ${series.map((s) => `${s.name} ends at ${fmtPct(s.values[n - 1] ?? 0)}`).join('; ')}`}</title>
          {[0, 0.25, 0.5, 0.75, 1].map((g) => (
            <g key={g}><line className="viz-grid" x1={left} x2={W - right} y1={y(g)} y2={y(g)} /><text className="viz-tick" x={left - 6} y={y(g) + 3} textAnchor="end">{Math.round(g * 100)}%</text></g>
          ))}
          {Array.from({ length: n }, (_, i) => <text key={i} className="viz-tick" x={x(i)} y={H - 10} textAnchor="middle">{i + 1}</text>)}
          {hover !== null && <line className="viz-cross" x1={x(hover)} x2={x(hover)} y1={top} y2={H - bottom} />}
          {series.map((s, si) => (
            <g key={s.name}>
              <polyline fill="none" stroke={SERIES[si % SERIES.length]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
              {hover !== null && <circle cx={x(hover)} cy={y(s.values[hover]!)} r="4" fill={SERIES[si % SERIES.length]} stroke="var(--viz-surface)" strokeWidth="2" />}
            </g>
          ))}
        </svg>
        {hover !== null && (
          <div className="viz-tip" style={{ left: `${(x(hover) / W) * 100}%` }} role="tooltip">
            <strong>{xLabel} {hover + 1}</strong>
            {series.map((s, si) => <div key={s.name}><svg width="10" height="10" aria-hidden><circle cx="5" cy="5" r="4" fill={SERIES[si % SERIES.length]} /></svg> {s.name}: {fmtPct(s.values[hover]!)}</div>)}
          </div>
        )}
      </div>
    </ChartFrame>
  );
}

// ------------------------------------------------------------ horizontal bars

/** Labelled horizontal bars (identity is the row label, so one colour is enough). */
export function BarList({ title, subtitle, rows, format = (v) => v.toFixed(0) }: { title: string; subtitle?: string; rows: Array<{ label: ReactNode; text: string; value: number; detail: string }>; format?: (v: number) => string }) {
  const max = Math.max(...rows.map((r) => r.value), 1e-9);
  return (
    <ChartFrame
      title={title} subtitle={subtitle}
      table={<table className="viz-table"><thead><tr><th>Colour</th><th>Pips</th></tr></thead><tbody>{rows.map((r) => <tr key={r.text}><td>{r.text}</td><td>{format(r.value)}</td></tr>)}</tbody></table>}
    >
      <ul className="viz-bars">
        {rows.map((r) => (
          <li key={r.text} title={r.detail}>
            <span className="viz-barlabel">{r.label}</span>
            <span className="viz-track"><span className="viz-fill" style={{ width: `${(r.value / max) * 100}%` }} /></span>
            <span className="viz-barvalue">{format(r.value)}</span>
          </li>
        ))}
      </ul>
    </ChartFrame>
  );
}
